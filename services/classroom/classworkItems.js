// services/classroom/classworkItems.js
//
// Classwork items: validation (pure), the create / edit / delete flows that
// keep the gradebook in step, and the payload shapes. Graded classwork is a
// gradebook column (D2): under a category (siblings rescale so the category,
// and so the class, keeps its points), an existing column, or none. Every
// leaf assessment already has its own item (the classwork triggers), so a
// graded item is that row converted in place: one item per assessment.

const path = require('path');
const crypto = require('crypto');
const db = require('../../config/database');
const supabase = require('../../config/supabaseClient');
const logger = require('../../logger');
const q = require('../../queries/classwork.queries');
const assessmentQueries = require('../../queries/assessment.queries');
const { rescaleForInsert, rescaleForRemoval } = require('./weights');
const { BUCKET, SIGNED_URL_TTL, youtubeIdOf } = require('../../utils/classworkUpload');
const { signedUrlMap } = require('../../utils/attachmentUpload');
const engine = require('../analyticsEngine');
const { cellsToDrafts } = require('./publish');

const ITEM_KINDS = ['assessment', 'assignment', 'quiz', 'material'];
const SUBMISSION_MODES = ['file', 'text', 'done', 'none'];
const STATUSES = ['draft', 'scheduled', 'posted'];
const AUDIENCES = ['all', 'some'];
const TITLE_MAX = 200;
const INSTRUCTIONS_MAX = 20000;
const MAX_AUDIENCE = 500;
const MAX_SCORE_LIMIT = 10000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const D2_MESSAGE = 'Add a category in Grades → Assessments & categories first, or fill an existing column.';
const GRADES_EXIST_MESSAGE = 'This column already has published grades. Unpublish or clear them in Grades first.';
const STANDALONE_MOVE_MESSAGE = 'This column counts on its own in Grades. Move it in Grades → Assessments & categories.';
const COLUMN_TAKEN_MESSAGE = 'Another item already fills that gradebook column. Choose another column.';
const GRADED_WORK_CODE = 'GRADED_WORK_EXISTS';
const GRADED_WORK_MESSAGE = "Students' work on this item is already graded. Clear those grades in the grading view before changing how it counts in the gradebook.";
const DRAFT_ABOVE_MAX_CODE = 'DRAFT_ABOVE_MAX';
const TURN_IN_KINDS = new Set(['assignment', 'quiz']);

const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const iso = (value) => (value ? new Date(value).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const fail = (error) => ({ error });

/** An error the controller answers with its status and message (`expose` marks it as ours). */
function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  if (code) err.code = code;
  return err;
}

/** A real calendar day in YYYY-MM-DD. */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** ISO string for a date-time the client sent; null for null; undefined when unreadable. */
function parseInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** The Toronto calendar day of an instant, YYYY-MM-DD. */
const torontoDate = (instant) => new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

/** The gradebook column's date: the assessment's own date, or the day an assignment/quiz is due. */
function gradebookDate(value) {
  if (value.kind === 'assessment') return value.date ?? null;
  if ((value.kind === 'assignment' || value.kind === 'quiz') && value.dueAt) return torontoDate(value.dueAt);
  return null;
}

/** gradebook input → a normalized choice, or { error }. */
function parseGradebook(gb, { kind, categories, linkableColumns, current }) {
  if (!gb || typeof gb !== 'object') return fail('Choose how this counts in the gradebook');
  if (gb.mode === 'none') return { value: { mode: 'none' } };
  if (gb.mode === 'category') {
    if (categories.length === 0) return fail(D2_MESSAGE);
    const categoryId = lower(gb.categoryId);
    if (!categories.some((c) => lower(c.assessmentId) === categoryId)) return fail("Choose one of this class's categories");
    const maxScore = gb.maxScore === '' || gb.maxScore === null || typeof gb.maxScore === 'boolean' ? NaN : Number(gb.maxScore);
    if (!Number.isFinite(maxScore) || maxScore <= 0) return fail('Out of must be more than 0');
    if (maxScore > MAX_SCORE_LIMIT) return fail('Out of must be 10,000 or less');
    return { value: { mode: 'category', categoryId, maxScore } };
  }
  if (gb.mode === 'existing') {
    const assessmentId = lower(gb.assessmentId);
    if (current?.assessmentId && lower(current.assessmentId) === assessmentId) return { value: { mode: 'keep' } };
    if (!linkableColumns.some((c) => lower(c.assessmentId) === assessmentId)) return fail("Choose a column from this class's gradebook");
    if (kind === 'assessment') return fail('Choose a category for this assessment');
    return { value: { mode: 'existing', assessmentId } };
  }
  return fail('Choose how this counts in the gradebook');
}

/**
 * Validates an item form. With `ctx.current` (the item as it stands) the input
 * is an edit: missing keys keep their current value, and time-dependent or
 * roster checks run only on the keys the edit sends.
 *
 * @param {object} input ItemInput (or a partial one for an edit)
 * @param {{ categories: {assessmentId}[], linkableColumns: {assessmentId}[], roster: string[],
 *           topics: string[], now: Date, current?: object }} ctx
 * @returns {{ value: object } | { error: string }}
 */
function validateItemInput(input, ctx) {
  const body = input && typeof input === 'object' ? input : {};
  const cur = ctx.current || null;
  const categories = ctx.categories || [];
  const linkableColumns = ctx.linkableColumns || [];
  const roster = new Set((ctx.roster || []).map(lower));
  const topics = new Set((ctx.topics || []).map(lower));
  const now = ctx.now || new Date();
  const pick = (k, fallback) => (has(body, k) ? body[k] : cur && has(cur, k) ? cur[k] : fallback);

  const kind = pick('kind');
  if (!ITEM_KINDS.includes(kind)) return fail('Choose Assessment, Assignment, Quiz or Material');

  const rawTitle = pick('title');
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title) return fail('Give it a title');
  if (title.length > TITLE_MAX) return fail(`Keep the title to ${TITLE_MAX} characters`);

  let instructions = pick('instructions', null);
  if (instructions !== null && typeof instructions !== 'string') return fail('Instructions must be text');
  instructions = instructions && instructions.trim() ? instructions.trim() : null;
  if (instructions && instructions.length > INSTRUCTIONS_MAX) return fail('Keep the instructions to 20,000 characters');

  const rawTopic = pick('topicId', null);
  const topicId = rawTopic ? lower(String(rawTopic)) : null;
  if (topicId && !topics.has(topicId)) return fail("Choose one of this class's topics");

  const turnIn = kind === 'assignment' || kind === 'quiz';
  let dueAt = null;
  if (turnIn) {
    dueAt = parseInstant(pick('dueAt', null));
    if (dueAt === undefined) return fail('The due date is not a valid date and time');
  }
  let date = null;
  if (kind === 'assessment') {
    date = pick('date', null) || null;
    if (date !== null && !isCalendarDate(date)) return fail('The date must be YYYY-MM-DD');
  }

  let submissionMode = 'none';
  if (kind === 'assignment') {
    submissionMode = has(body, 'submissionMode') ? body.submissionMode
      : cur && cur.kind === 'assignment' ? cur.submissionMode : 'file';
    if (!SUBMISSION_MODES.includes(submissionMode)) return fail('Choose how students turn it in');
  }

  // The gradebook choice. An edit that sends none keeps the column it has.
  let gradebook;
  if (kind === 'material') {
    gradebook = { mode: 'none' };
  } else if (has(body, 'gradebook')) {
    const parsed = parseGradebook(body.gradebook, { kind, categories, linkableColumns, current: cur });
    if (parsed.error) return parsed;
    gradebook = parsed.value;
  } else {
    gradebook = cur && cur.assessmentId ? { mode: 'keep' } : { mode: 'none' };
  }
  if (kind === 'assessment' && gradebook.mode !== 'category' && gradebook.mode !== 'keep') {
    return fail(categories.length === 0 ? D2_MESSAGE : 'Choose a category for this assessment');
  }

  const status = pick('status', 'posted');
  if (!STATUSES.includes(status)) return fail('Status must be draft, scheduled or posted');
  let publishAt = null;
  if (status === 'scheduled') {
    publishAt = parseInstant(pick('publishAt', null));
    if (!publishAt) return fail('Pick a date and time in the future to schedule it');
    const recheck = !cur || has(body, 'status') || has(body, 'publishAt');
    if (recheck && Date.parse(publishAt) <= now.getTime()) return fail('Pick a date and time in the future to schedule it');
  }

  const audience = pick('audience', 'all');
  if (!AUDIENCES.includes(audience)) return fail('Audience must be all or some');
  let studentIds = [];
  if (audience === 'some') {
    const touched = !cur || has(body, 'audience') || has(body, 'studentIds');
    const raw = has(body, 'studentIds') ? body.studentIds : cur ? cur.studentIds : [];
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) return fail('studentIds must be a list of student ids');
    studentIds = [...new Set(raw.map(lower))];
    if (studentIds.length === 0) return fail('Choose at least one student');
    if (studentIds.length > MAX_AUDIENCE) return fail(`Choose at most ${MAX_AUDIENCE} students`);
    if (touched && studentIds.some((id) => !roster.has(id))) return fail("Some of these students aren't in this class");
  }

  const flags = {};
  for (const [key, fallback] of [['emailStudents', true], ['remindStudents', true], ['showEarly', false]]) {
    const v = pick(key, fallback);
    if (typeof v !== 'boolean') return fail(`${key} must be true or false`);
    flags[key] = v;
  }

  return {
    value: {
      kind, title, instructions, topicId, dueAt, date, submissionMode, gradebook,
      status, publishAt, audience, studentIds, ...flags,
    },
  };
}

// ── Shapes ────────────────────────────────────────────────────────────────

/** A classwork_attachments row → Attachment; `signedUrl` for files when signed. */
function toAttachment(row, signedUrl = null) {
  const isLink = row.kind === 'link';
  return {
    attachmentId: row.attachment_id,
    kind: row.kind,
    title: row.title ?? null,
    fileName: row.file_name ?? null,
    mimeType: row.mime_type ?? null,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    url: isLink ? row.url : signedUrl,
    youtubeId: isLink ? youtubeIdOf(row.url) : null,
  };
}

/** An ITEM_SELECT row → ItemSummary. */
function toItemSummary(row) {
  return {
    itemId: row.item_id,
    classId: row.class_id,
    kind: row.kind,
    title: row.title,
    topicId: row.topic_id ?? null,
    status: row.status,
    effectiveStatus: row.effective_status,
    publishAt: iso(row.publish_at),
    postedAt: iso(row.posted_at),
    dueAt: iso(row.due_at),
    date: row.date ?? null,
    submissionMode: row.submission_mode,
    showEarly: Boolean(row.show_early),
    audience: row.audience,
    gradebook: row.assessment_id ? {
      assessmentId: row.assessment_id,
      categoryId: row.category_id ?? null,
      categoryName: row.category_name ?? null,
      maxScore: num(row.max_score),
      weightPoints: num(row.weight_points),
      isPublished: Boolean(row.is_published),
      scoreCount: Number(row.score_count) || 0,
    } : null,
    attachmentCount: Number(row.attachment_count) || 0,
    counts: row.counts,
    classAvgPct: null, // withClassAverages (the grade engine)
    createdAt: iso(row.created_at),
    editedAt: iso(row.edited_at),
  };
}

/** ITEM_SELECT row + its students and attachments → Item. */
function toItem(row, studentIds, attachments) {
  return {
    ...toItemSummary(row),
    instructions: row.instructions ?? null,
    emailStudents: Boolean(row.email_students),
    remindStudents: Boolean(row.remind_students),
    studentIds,
    attachments,
  };
}

/** The item as it stands, in validateItemInput's terms (for an edit). */
function toCurrent(row, studentIds) {
  return {
    kind: row.kind,
    title: row.title,
    instructions: row.instructions ?? null,
    topicId: row.topic_id ?? null,
    dueAt: iso(row.due_at),
    date: row.date ?? null,
    submissionMode: row.submission_mode,
    status: row.status,
    publishAt: iso(row.publish_at),
    audience: row.audience,
    studentIds,
    emailStudents: Boolean(row.email_students),
    remindStudents: Boolean(row.remind_students),
    showEarly: Boolean(row.show_early),
    assessmentId: row.assessment_id ?? null,
    categoryId: row.category_id ?? null,
    maxScore: num(row.max_score),
  };
}

const toCategoryOption = (r) => ({
  assessmentId: r.assessment_id, name: r.name, weightPoints: num(r.weight_points) ?? 0, childCount: Number(r.child_count) || 0,
});
const toColumnOption = (r) => ({
  assessmentId: r.assessment_id, name: r.name, categoryName: r.category_name ?? null, maxScore: num(r.max_score),
});
const toTopic = (r) => ({ topicId: r.topic_id, name: r.name, sortOrder: Number(r.sort_order) || 0, itemCount: Number(r.item_count) || 0 });

// ── Reads ─────────────────────────────────────────────────────────────────

/** What validateItemInput needs to know about a class. `runner` is the pool or a client. */
async function loadContext(runner, classId) {
  const [cats, cols, roster, topics] = await Promise.all([
    runner.query(q.selectCategories, [classId]),
    runner.query(q.selectLinkableColumns, [classId]),
    runner.query(q.selectRosterIds, [classId]),
    runner.query(q.selectTopics, [classId]),
  ]);
  return {
    categoryRows: cats.rows,
    columnRows: cols.rows,
    topicRows: topics.rows,
    categories: cats.rows.map((r) => ({ assessmentId: r.assessment_id, name: r.name })),
    linkableColumns: cols.rows.map((r) => ({ assessmentId: r.assessment_id })),
    roster: roster.rows.map((r) => r.student_id),
    topics: topics.rows.map((r) => r.topic_id),
    now: new Date(),
  };
}

/** Attachments of an item, files signed for an hour. */
async function loadAttachments(itemId, runner = db) {
  const { rows } = await runner.query(q.selectAttachments, [itemId]);
  const signed = await signedUrlMap(rows.filter((r) => r.kind === 'file').map((r) => r.file_path));
  return rows.map((r) => toAttachment(r, signed.get(r.file_path) ?? null));
}

/**
 * classAvgPct for a class's plain published assessments, from the grade
 * engine (the same per-assessment class average the parent portal shows),
 * so Classwork never runs a second grade calculation. Other items keep null.
 */
async function withClassAverages(summaries, classId) {
  const wanted = summaries.some((s) => s.kind === 'assessment' && s.gradebook?.isPublished);
  if (!wanted) return summaries;
  const averages = await engine.classAssessmentAverages(classId, { publishedOnly: true });
  return summaries.map((s) => (s.kind === 'assessment' && s.gradebook?.isPublished
    ? { ...s, classAvgPct: averages.get(s.gradebook.assessmentId) ?? null }
    : s));
}

/** The full Item, or null when it is gone. */
async function loadItem(itemId, runner = db) {
  const { rows } = await runner.query(q.selectItem, [itemId]);
  if (!rows[0]) return null;
  const [students, attachments] = await Promise.all([
    runner.query(q.selectItemStudentIds, [itemId]),
    loadAttachments(itemId, runner),
  ]);
  const [item] = await withClassAverages([toItem(rows[0], students.rows.map((r) => r.student_id), attachments)], rows[0].class_id);
  return item;
}

// ── Gradebook writes (inside a transaction) ───────────────────────────────

async function one(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0] ?? null;
}

async function applyWeights(client, updates) {
  for (const u of updates) await client.query(q.updateAssessmentWeight, [u.weightPoints, u.assessmentId]);
}

/** Locks a category and its columns; 400 when it is not a category of this class. */
async function lockCategoryWithChildren(client, categoryId, classId) {
  const parent = await one(client, q.lockCategory, [categoryId, classId]);
  if (!parent) throw httpError(400, "Choose one of this class's categories");
  const children = (await client.query(q.lockChildren, [parent.assessment_id])).rows;
  return { parent, children };
}

const nextSortOrder = (children) => children.reduce((m, s) => Math.max(m, Number(s.sort_order || 0)), 0) + 1;

/** A new column under a category; its siblings shrink so the category keeps its points. Returns the assessment id. */
async function addColumnUnderCategory(client, { classId, categoryId, title, maxScore, date }) {
  const { parent, children } = await lockCategoryWithChildren(client, categoryId, classId);
  const { updates, newWeight } = rescaleForInsert(Number(parent.weight_points || 0), children);
  await applyWeights(client, updates);
  const { rows } = await client.query(assessmentQueries.createAssessment, [
    classId, title, null, parent.assessment_id, false, nextSortOrder(children), maxScore, newWeight, date]);
  return rows[0].assessment_id; // the insert trigger has given it a kind='assessment' item
}

/** The category's remaining columns grow back to fill it. */
async function refillCategory(client, categoryId) {
  const parent = await one(client, `SELECT assessment_id, weight_points FROM assessments WHERE assessment_id = $1 FOR UPDATE`, [categoryId]);
  if (!parent) return;
  const remaining = (await client.query(q.lockChildren, [categoryId])).rows;
  await applyWeights(client, rescaleForRemoval(Number(parent.weight_points || 0), remaining));
}

/** Deletes a column (scores cascade) and refills its category. */
async function removeColumn(client, assessmentId) {
  const col = await one(client, q.lockAssessment, [assessmentId]);
  if (!col) return;
  await client.query(q.deleteAssessment, [assessmentId]);
  if (col.parent_assessment_id) await refillCategory(client, col.parent_assessment_id);
}

/**
 * Moves a column from one category to another: the new one rescales for the
 * insert, the old one refills, so both keep their points. Both categories are
 * locked in id order first.
 */
async function moveColumn(client, { assessmentId, classId, fromCategoryId, toCategoryId }) {
  await client.query(q.lockCategoriesInOrder, [[fromCategoryId, toCategoryId].map(lower).sort()]);
  const { parent, children } = await lockCategoryWithChildren(client, toCategoryId, classId);
  const siblings = children.filter((c) => c.assessment_id !== assessmentId);
  const { updates, newWeight } = rescaleForInsert(Number(parent.weight_points || 0), siblings);
  await applyWeights(client, updates);
  await client.query(q.reparentAssessment, [assessmentId, parent.assessment_id, newWeight, nextSortOrder(siblings)]);
  if (fromCategoryId) await refillCategory(client, fromCategoryId);
}

async function gradeCount(client, assessmentId) {
  return (await one(client, q.countGrades, [assessmentId]))?.n ?? 0;
}

async function replaceStudents(client, itemId, value) {
  await client.query(q.clearItemStudents, [itemId]);
  if (value.audience === 'some' && value.studentIds.length) await client.query(q.insertItemStudents, [itemId, value.studentIds]);
}

/** kind … audience: the shared column parameters of insertItem / convertItemByAssessment / updateItem. */
const itemParams = (v) => [
  v.kind, v.instructions, v.topicId, v.dueAt, v.submissionMode, v.status,
  v.status === 'scheduled' ? v.publishAt : null, v.showEarly, v.emailStudents, v.remindStudents, v.audience,
];

/**
 * Creates an item from a validated value, in the caller's transaction.
 * @returns {Promise<{ itemId: string, gradebookChanged: boolean }>}
 */
async function createItem(client, { classId, userId, value }) {
  let assessmentId = null;
  if (value.gradebook.mode === 'category') {
    assessmentId = await addColumnUnderCategory(client, {
      classId, categoryId: value.gradebook.categoryId, title: value.title,
      maxScore: value.gradebook.maxScore, date: gradebookDate(value),
    });
  } else if (value.gradebook.mode === 'existing') {
    assessmentId = value.gradebook.assessmentId;
    await client.query(q.renameAssessment, [value.title, gradebookDate(value), assessmentId]);
  }
  const params = itemParams(value);
  let item;
  if (assessmentId) {
    item = await one(client, q.convertItemByAssessment, [classId, assessmentId, ...params, userId]);
    if (!item) throw httpError(409, COLUMN_TAKEN_MESSAGE);
  } else {
    item = await one(client, q.insertItem, [classId, value.title, ...params, userId]);
  }
  if (value.audience === 'some') await replaceStudents(client, item.item_id, value);
  // An assignment or quiz filling an unpublished column takes its cells as drafts (D3).
  if (assessmentId && TURN_IN_KINDS.has(value.kind)) await cellsToDrafts(client, { itemId: item.item_id, assessmentId });
  return { itemId: item.item_id, gradebookChanged: Boolean(assessmentId) };
}

const sameList = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Does the gradebook choice differ from the column the item has now? */
function columnChoiceDiffers(gb, cur) {
  if (gb.mode === 'keep') return false;
  if (gb.mode === 'none') return Boolean(cur.assessmentId);
  if (gb.mode === 'category') {
    return !cur.assessmentId || gb.categoryId !== lower(cur.categoryId ?? '') || gb.maxScore !== cur.maxScore;
  }
  return true; // another existing column
}

/** Did an edit change what students read (not just its status or schedule)? */
function contentChanged(value, cur) {
  return value.kind !== cur.kind || value.title !== cur.title || value.instructions !== cur.instructions
    || value.topicId !== (cur.topicId ? lower(cur.topicId) : null) || value.dueAt !== cur.dueAt
    || (value.kind === 'assessment' && value.date !== cur.date) || value.submissionMode !== cur.submissionMode
    || value.audience !== cur.audience || !sameList(value.studentIds, cur.audience === 'some' ? cur.studentIds.map(lower) : [])
    || value.emailStudents !== cur.emailStudents || value.remindStudents !== cur.remindStudents
    || value.showEarly !== cur.showEarly || columnChoiceDiffers(value.gradebook, cur);
}

/**
 * Applies a validated edit, in the caller's transaction. `row` is the item's
 * ITEM_SELECT row (before), `cur` its toCurrent form.
 * @returns {Promise<{ gradebookChanged: boolean }>}
 */
async function updateItem(client, { classId, userId, row, cur, value }) {
  const itemId = row.item_id;
  const target = value.gradebook;
  let assessmentId = row.assessment_id ?? null;
  // Going ungraded removes the column; filling another existing column (the
  // same column was turned into 'keep' by validation) hands the current one
  // back to the gradebook as a plain assessment, grades and all.
  const dropping = Boolean(assessmentId) && target.mode === 'none';
  const switching = Boolean(assessmentId) && target.mode === 'existing';
  const moving = Boolean(assessmentId) && target.mode === 'category' && lower(target.categoryId) !== lower(row.category_id ?? '');
  let gradebookChanged = false;

  // Grades on the students' work (drafts, or published through Classwork)
  // belong to this column: they never move to another column, are never
  // dropped, and are never left behind by the item becoming a plain
  // assessment. The teacher clears them first (T16).
  const leavesTurnIn = TURN_IN_KINDS.has(cur.kind) && !TURN_IN_KINDS.has(value.kind);
  const newMax = target.mode === 'category' ? target.maxScore : null;
  const maxChanges = Boolean(assessmentId) && newMax !== null && newMax !== cur.maxScore;
  if (assessmentId && (dropping || switching || leavesTurnIn || maxChanges)) {
    const work = await one(client, q.selectGradedWork, [itemId]);
    if ((work?.n ?? 0) > 0) {
      if (dropping || switching || leavesTurnIn) throw httpError(409, GRADED_WORK_MESSAGE, GRADED_WORK_CODE);
      if (work.max_score !== null && work.max_score > newMax) {
        throw httpError(409, `Some grades on students' work are above ${newMax}. Change them in the grading view first.`, DRAFT_ABOVE_MAX_CODE);
      }
    }
  }
  // A column with grades in it is never dropped from under them.
  if (dropping && (await gradeCount(client, assessmentId)) > 0) throw httpError(409, GRADES_EXIST_MESSAGE);
  // A column that counts on its own (no category) holds top-level points;
  // putting it in a category would take them out of the class's 100.
  if (moving && !row.category_id) throw httpError(409, STANDALONE_MOVE_MESSAGE);

  const willBeLinked = target.mode === 'keep' || target.mode === 'category' || target.mode === 'existing';
  // The item's own columns first, so a kind change is in place before any
  // column is removed (the delete trigger only removes plain-assessment rows).
  await client.query(q.updateItem, [
    itemId, willBeLinked ? null : value.title, ...itemParams(value), contentChanged(value, cur),
  ]);

  if (dropping) {
    await removeColumn(client, assessmentId); // the item's link goes NULL with the column
    assessmentId = null;
    gradebookChanged = true;
  } else if (switching) {
    await client.query(q.setItemAssessment, [itemId, null]);
    await client.query(q.insertPlainItem, [classId, assessmentId, userId ?? null]);
    assessmentId = null;
  }

  const newlyLinked = !assessmentId && (target.mode === 'category' || target.mode === 'existing');
  if (newlyLinked) {
    assessmentId = target.mode === 'category'
      ? await addColumnUnderCategory(client, {
        classId, categoryId: target.categoryId, title: value.title, maxScore: target.maxScore, date: gradebookDate(value),
      })
      : target.assessmentId;
    await client.query(q.movePlainItemAttachments, [assessmentId, itemId]);
    await client.query(q.deletePlainItemOf, [assessmentId, itemId]);
    await client.query(q.setItemAssessment, [itemId, assessmentId]);
    gradebookChanged = true;
  } else if (moving) {
    await moveColumn(client, { assessmentId, classId, fromCategoryId: row.category_id, toCategoryId: target.categoryId });
    gradebookChanged = true;
  }

  if (assessmentId) {
    const setDate = newlyLinked || value.kind !== cur.kind || (value.kind === 'assessment' ? value.date !== cur.date : value.dueAt !== cur.dueAt);
    const maxScore = target.mode === 'category' ? target.maxScore : null;
    await client.query(q.updateLinkedAssessment, [assessmentId, value.title, setDate, gradebookDate(value), maxScore]);
    if (maxScore !== null && maxScore !== cur.maxScore) gradebookChanged = true;
  }

  await replaceStudents(client, itemId, value);
  // An assignment or quiz newly filling an unpublished column (or a plain
  // assessment becoming one) takes the column's cells as drafts (D3).
  if (assessmentId && TURN_IN_KINDS.has(value.kind) && (newlyLinked || !TURN_IN_KINDS.has(cur.kind))) {
    await cellsToDrafts(client, { itemId, assessmentId });
  }
  return { gradebookChanged };
}

/**
 * Deletes an item, in the caller's transaction. An item with no column is
 * soft-deleted; a linked one takes its column (and its scores) with it and
 * the category refills.
 * @returns {Promise<{ removedColumn: boolean }>}
 */
async function deleteItem(client, { row }) {
  if (!row.assessment_id) {
    await client.query(q.softDeleteItem, [row.item_id]);
    return { removedColumn: false };
  }
  // A turn-in item stays (soft-deleted, link nulled by the column's delete);
  // a plain assessment's row goes with its column (the delete trigger).
  if (row.kind !== 'assessment') await client.query(q.softDeleteItem, [row.item_id]);
  await removeColumn(client, row.assessment_id);
  return { removedColumn: true };
}

/** Runs `fn(client)` in a transaction. */
async function inTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ── Copy (another class → this one, and class duplication) ────────────────

/**
 * Copies an item's attachments to another item: links as rows, files with a
 * storage copy into the new item's folder. Best effort: a file that fails to
 * copy is skipped and reported. `copied` collects new object paths so the
 * caller can remove them if its transaction rolls back.
 * @returns {Promise<string[]>} names of files that could not be copied
 */
async function copyAttachments(client, { fromItemId, toItemId, school, userId, copied }) {
  const { rows } = await client.query(q.selectAttachments, [fromItemId]);
  const failed = [];
  for (const a of rows) {
    if (a.kind === 'link') {
      await client.query(q.insertLinkAttachment, [toItemId, a.url, a.title, userId]);
      continue;
    }
    const newPath = `${school}/classwork/${toItemId}/${crypto.randomUUID()}${path.extname(a.file_path || '').toLowerCase()}`;
    try {
      const { error } = await supabase.storage.from(BUCKET).copy(a.file_path, newPath);
      if (error) throw error;
      copied.push(newPath);
      const inserted = await one(client, q.insertFileAttachment, [toItemId, newPath, a.file_name, a.mime_type, a.size_bytes, userId]);
      if (a.title) await client.query(q.updateAttachment, [inserted.attachment_id, true, a.title, null]);
    } catch (error) {
      logger.warn({ from: a.file_path, err: error?.message || error }, 'Copying a classwork file failed; skipped');
      failed.push(a.file_name || 'a file');
    }
  }
  return failed;
}

/** Target topic id for each source topic, by name (case-insensitive); missing ones are created. */
async function mapTopics(client, { sourceClassId, targetClassId, topicIds }) {
  const map = new Map();
  if (topicIds.size === 0) return map;
  const [{ rows: sourceTopics }, { rows: targetTopics }] = await Promise.all([
    client.query(q.selectTopics, [sourceClassId]),
    client.query(q.selectTopics, [targetClassId]),
  ]);
  const byName = new Map(targetTopics.map((t) => [t.name.toLowerCase(), t.topic_id]));
  for (const t of sourceTopics) {
    if (!topicIds.has(t.topic_id)) continue;
    let id = byName.get(t.name.toLowerCase());
    if (!id) {
      id = (await one(client, q.insertTopic, [targetClassId, t.name])).topic_id;
      byName.set(t.name.toLowerCase(), id);
    }
    map.set(t.topic_id, id);
  }
  return map;
}

/**
 * Copies classwork from another class as drafts, in the caller's transaction.
 * A graded item goes under the target category with the same name; without
 * one it is copied as not graded (a plain assessment is skipped). Due dates
 * and schedules are cleared: the teacher sets them when posting.
 * @returns {Promise<{ itemIds: string[], warnings: {title, message}[], gradebookChanged: boolean }>}
 */
async function copyClasswork(client, { sourceClassId, targetClassId, school, userId, itemIds, includeTopics, copied }) {
  const { rows: items } = await client.query(q.selectCopyItems, [sourceClassId, itemIds ?? null]);
  if (itemIds && items.length !== new Set(itemIds).size) throw httpError(400, "Some of these items aren't in that class");

  const topicMap = includeTopics
    ? await mapTopics(client, { sourceClassId, targetClassId, topicIds: new Set(items.map((i) => i.topic_id).filter(Boolean)) })
    : new Map();
  const { rows: targetCategories } = await client.query(q.selectCategories, [targetClassId]);
  const categoryByName = new Map(targetCategories.map((c) => [c.name.trim().toLowerCase(), c.assessment_id]));

  const warnings = [];
  const created = [];
  let gradebookChanged = false;
  for (const src of items) {
    let gradebook = { mode: 'none' };
    if (src.assessment_id) {
      const categoryId = src.category_name ? categoryByName.get(src.category_name.trim().toLowerCase()) : null;
      if (categoryId) {
        gradebook = { mode: 'category', categoryId, maxScore: Number(src.max_score) > 0 ? Number(src.max_score) : 100 };
      } else if (src.kind === 'assessment') {
        warnings.push({
          title: src.title,
          message: src.category_name ? `No ${src.category_name} category here, so it was not copied.` : "It isn't in a category, so it was not copied.",
        });
        continue;
      } else {
        warnings.push({
          title: src.title,
          message: src.category_name ? `No ${src.category_name} category here, so it was copied as not graded.` : "It isn't in a category, so it was copied as not graded.",
        });
      }
    }
    const value = {
      kind: src.kind, title: src.title, instructions: src.instructions ?? null,
      topicId: src.topic_id ? topicMap.get(src.topic_id) ?? null : null,
      dueAt: null, date: null, submissionMode: src.submission_mode, gradebook,
      status: 'draft', publishAt: null, audience: 'all', studentIds: [],
      emailStudents: Boolean(src.email_students), remindStudents: Boolean(src.remind_students), showEarly: Boolean(src.show_early),
    };
    const { itemId, gradebookChanged: changed } = await createItem(client, { classId: targetClassId, userId, value });
    gradebookChanged = gradebookChanged || changed;
    created.push(itemId);
    const failed = await copyAttachments(client, { fromItemId: src.item_id, toItemId: itemId, school, userId, copied });
    for (const name of failed) warnings.push({ title: src.title, message: `${name} could not be copied.` });
  }
  return { itemIds: created, warnings, gradebookChanged };
}

/** Signed URL for one file (1 h). */
async function signedFileUrl(filePath) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, SIGNED_URL_TTL);
  if (error || !data?.signedUrl) throw error || new Error('No signed URL');
  return data.signedUrl;
}

module.exports = {
  ITEM_KINDS, SUBMISSION_MODES, STATUSES, D2_MESSAGE, GRADES_EXIST_MESSAGE, STANDALONE_MOVE_MESSAGE,
  GRADED_WORK_CODE, GRADED_WORK_MESSAGE, DRAFT_ABOVE_MAX_CODE,
  httpError, isCalendarDate, torontoDate, gradebookDate, validateItemInput,
  toAttachment, toItemSummary, toItem, toCurrent, toCategoryOption, toColumnOption, toTopic,
  loadContext, loadItem, loadAttachments, withClassAverages,
  createItem, updateItem, deleteItem, inTransaction, copyClasswork, copyAttachments, signedFileUrl,
};
