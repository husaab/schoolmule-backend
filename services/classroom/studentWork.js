// services/classroom/studentWork.js
//
// A student's classwork, written once and called twice: by the student portal
// (studentId = the caller's own row; the student may act) and by the parent's
// read-only lens (studentId = a child the parent owns; nothing is written, not
// even the lazy submission row). Status comes from the one rule
// (workStatus.js / WORK_STATE_SQL), so the To-do, home, class pages, the lens
// and the teacher's counts never disagree.
//
// Turn-in: one submission per student × item, created on first open. Files go
// to the private classwork-submissions bucket; a write locks the submission
// row, so an upload, a delete, a typed answer and Turn in never interleave.

const db = require('../../config/database');
const supabase = require('../../config/supabaseClient');
const logger = require('../../logger');
const q = require('../../queries/classworkSubmission.queries');
const classworkQueries = require('../../queries/classwork.queries');
const messagingQueries = require('../../queries/messaging.queries');
const { selectCurrentTerm } = require('../../queries/termScope');
const { identityOf } = require('./classView');
const { todoTab, groupTodo, torontoDay, newestDueFirst } = require('./todoGroups');
const { loadAttachments, httpError, inTransaction } = require('./classworkItems');
const { signedPhotoUrl } = require('../profile/photos');
const {
  SUBMISSION_BUCKET, SIGNED_URL_TTL, MAX_FILES_PER_SUBMISSION, submissionFilePath,
} = require('../../utils/classworkUpload');

const TEXT_MAX = 20000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_LIMIT = 3;
const DUE_SOON_DAYS = 7;
const DUE_SOON_LIMIT = 5;
const HOME_MISSING_LIMIT = 3;
const NOTICE_LIMIT = 20;
const NEEDS_YOU_DAYS = 14;

const MESSAGES = Object.freeze({
  CLOSED: 'This assignment is closed. Ask your teacher.',
  SUBMITTED: "You've turned this in. Unsubmit it to make changes.",
  ALREADY_TURNED_IN: "You've already turned this in.",
  GRADED: 'Your teacher has already graded this.',
  EXCUSED: 'Your teacher excused you from this one.',
  GRADED_NO_UNSUBMIT: "Your teacher has already graded this, so it can't be unsubmitted.",
  NOT_TURNED_IN: "This isn't turned in.",
  QUIZ_UNSUBMIT: "A quiz can't be unsubmitted.",
  NOTHING_TO_TURN_IN: "There's nothing to turn in for this one.",
  QUIZ_TURN_IN: 'Answer the quiz to turn it in.',
  NEEDS_FILE: 'Add a photo or file first.',
  NEEDS_TEXT: 'Write your answer first.',
  NOT_FILE_MODE: "This assignment doesn't take files.",
  NOT_TEXT_MODE: "This assignment doesn't take a typed answer.",
  TOO_MANY_FILES: `You can add up to ${MAX_FILES_PER_SUBMISSION} files.`,
  TEXT_TOO_LONG: `Keep your answer to ${TEXT_MAX.toLocaleString('en-US')} characters.`,
  TEXT_TYPE: 'Your answer must be text.',
  ITEM_NOT_FOUND: 'Item not found',
  FILE_NOT_FOUND: 'File not found',
});

// Messages about one piece of work ("private comments", T17) are for the
// work students turn in: assignments and quizzes.
const THREAD_KINDS = Object.freeze(['assignment', 'quiz']);
const takesThread = (kind) => THREAD_KINDS.includes(kind);

const iso = (value) => (value ? new Date(value).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const time = (value) => (value ? Date.parse(value) : null);

/** An API error with a code (§0.1), e.g. 409 ITEM_CLOSED. */
function codedError(status, code, message) {
  const err = httpError(status, message);
  err.code = code;
  return err;
}

// ── Rows → shapes ─────────────────────────────────────────────────────────

/** A visible grade's score: missing and excused carry none. */
const visibleScore = (row) => (row.grade_status === 'graded' ? num(row.grade_score) : null);

/** A selectStudentWork / selectStudentItem row → the internal work item (every payload picks from it). */
function toWork(row, identity = identityOf(row)) {
  return {
    itemId: row.item_id,
    classId: row.class_id,
    subject: row.subject,
    teacherName: row.teacher_name ?? null,
    iconUrl: identity.iconUrl,
    title: row.title,
    kind: row.kind,
    submissionMode: row.submission_mode,
    dueAt: iso(row.due_at),
    date: row.date ?? null,
    status: row.work_status,
    isLate: Boolean(row.is_late),
    questionCount: Number(row.question_count) || 0, // a quiz's questions; 0 for other kinds
    turnedInAt: iso(row.turned_in_at),
    publishedAt: iso(row.grade_published_at),
    topicId: row.topic_id ?? null,
    postedAt: iso(row.posted_at),
    grade: row.grade_visible ? { score: visibleScore(row), maxScore: num(row.max_score) } : null,
    assessmentId: row.assessment_id ?? null,
    teacher: row.teacher_id ? { userId: row.teacher_id, name: row.teacher_name, avatar: row.teacher_avatar ?? null } : null,
  };
}

/** TodoItem (plus turnedInAt and the grade's publishedAt, for "Done" and "graded …" lines). */
const toTodoItem = (w) => ({
  itemId: w.itemId,
  classId: w.classId,
  subject: w.subject,
  teacherName: w.teacherName,
  iconUrl: w.iconUrl,
  title: w.title,
  kind: w.kind,
  submissionMode: w.submissionMode,
  dueAt: w.dueAt,
  date: w.date,
  status: w.status,
  isLate: w.isLate,
  questionCount: w.questionCount,
  turnedInAt: w.turnedInAt,
  publishedAt: w.publishedAt,
});

/** StudentItemSummary: a TodoItem with its topic, posted time and visible grade. */
const toStudentItemSummary = (w) => ({ ...toTodoItem(w), topicId: w.topicId, postedAt: w.postedAt, grade: w.grade });

const toSubmissionFile = (r) => ({ fileId: r.file_id, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes) });

// ── Pure selectors over a student's work (same rule everywhere) ───────────

/** The day an item falls on: the Toronto day of its due time, else its gradebook date. */
const dayOf = (w) => (w.dueAt ? torontoDay(w.dueAt) : w.date);

/** Still ahead for the student: work to turn in, or something done in class (a test). */
const isAhead = (w) => w.kind !== 'material' && (w.status === 'assigned' || w.status === 'no_turn_in');

/**
 * What's coming up: items still ahead, falling today or later, soonest first.
 * @returns {object[]} TodoItem[]
 */
function upcomingOf(work, now = new Date(), limit = UPCOMING_LIMIT) {
  const today = torontoDay(now);
  return work
    .filter(isAhead)
    .map((w) => ({ w, day: dayOf(w) }))
    .filter((x) => x.day && x.day >= today)
    .sort((x, y) => x.day.localeCompare(y.day)
      || (time(x.w.dueAt) ?? -Infinity) - (time(y.w.dueAt) ?? -Infinity)
      || x.w.title.localeCompare(y.w.title))
    .slice(0, limit)
    .map((x) => toTodoItem(x.w));
}

/** Each class's next item ({ itemId, title, kind, dueAt, date }) and missing count. */
function classSummaries(work, now = new Date()) {
  const byClass = new Map();
  for (const w of work) {
    if (!byClass.has(w.classId)) byClass.set(w.classId, []);
    byClass.get(w.classId).push(w);
  }
  const out = new Map();
  for (const [classId, items] of byClass) {
    const [next] = upcomingOf(items, now, 1);
    out.set(classId, {
      next: next ? { itemId: next.itemId, title: next.title, kind: next.kind, dueAt: next.dueAt, date: next.date } : null,
      missingCount: items.filter((w) => w.status === 'missing').length,
    });
  }
  return out;
}

/** Assigned work due within the next `days`, soonest first. */
function dueWithin(work, now = new Date(), days = DUE_SOON_DAYS) {
  const from = now.getTime();
  const to = from + days * DAY_MS;
  return work
    .filter((w) => w.status === 'assigned' && w.dueAt && time(w.dueAt) >= from && time(w.dueAt) <= to)
    .sort((a, b) => time(a.dueAt) - time(b.dueAt));
}

/** Home "Due soon": assigned work due within 7 days, at most 5. */
const dueSoonOf = (work, now = new Date()) => dueWithin(work, now).slice(0, DUE_SOON_LIMIT).map(toTodoItem);

/** Missing work (derived and confirmed), newest due first: the To-do's Missing order. */
const missingOf = (work, limit = Infinity) => work
  .filter((w) => w.status === 'missing')
  .sort(newestDueFirst)
  .slice(0, limit)
  .map(toTodoItem);

/** Home "Missing": at most 3, newest due first. */
const homeMissingOf = (work) => missingOf(work, HOME_MISSING_LIMIT);

/** The class Stream's classwork notices: posted assignments, quizzes and materials, newest first. */
function noticesOf(work, limit = NOTICE_LIMIT) {
  return work
    .filter((w) => w.kind === 'assignment' || w.kind === 'quiz' || w.kind === 'material')
    .sort((a, b) => (time(b.postedAt) ?? 0) - (time(a.postedAt) ?? 0) || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((w) => ({ itemId: w.itemId, kind: w.kind, title: w.title, postedAt: w.postedAt, dueAt: w.dueAt }));
}

/**
 * "Needs you" missing rows for a parent: missing work due within the last 14
 * days (a dated test by its date), newest due first, one per child × item.
 */
function needsYouMissing(work, studentId, now = new Date()) {
  const since = now.getTime() - NEEDS_YOU_DAYS * DAY_MS;
  const today = torontoDay(now);
  const sinceDay = torontoDay(since);
  const recent = (w) => (w.dueAt
    ? time(w.dueAt) >= since && time(w.dueAt) <= now.getTime()
    : Boolean(w.date) && w.date >= sinceDay && w.date <= today);
  return work
    .filter((w) => w.status === 'missing' && recent(w))
    .sort(newestDueFirst)
    .map((w) => ({
      kind: 'missing',
      itemId: w.itemId,
      assessmentId: w.assessmentId,
      title: w.title,
      classId: w.classId,
      classSubject: w.subject,
      teacher: w.teacher,
      studentId,
      dueAt: w.dueAt,
      date: w.date,
    }));
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** The school's active term within the year, or null. */
async function currentTermOf(school, schoolYearId, runner = db) {
  const { rows } = await runner.query(selectCurrentTerm, [school, schoolYearId ?? null]);
  return rows[0] || null;
}

/**
 * The student's visible items with their status. One class (any term of the
 * year), or every live current-term class of the year when classId is null.
 * @param {{ studentId, school, schoolYearId?, classId?, term? }} p  term: the current
 *   term row when the caller already has it (undefined = look it up)
 * @returns {Promise<object[]>} work items
 */
async function listWork({ studentId, school, schoolYearId = null, classId = null, term }) {
  const t = classId || term !== undefined ? term : await currentTermOf(school, schoolYearId);
  const { rows } = await db.query(q.selectStudentWork, [
    studentId, school, classId, schoolYearId ?? null, t?.term_id ?? null, t?.name ?? null,
  ]);
  const identities = new Map();
  return rows.map((row) => {
    if (!identities.has(row.class_id)) identities.set(row.class_id, identityOf(row));
    return toWork(row, identities.get(row.class_id));
  });
}

/**
 * The To-do: counts per tab and the tab's groups, optionally one class.
 * @returns {Promise<{ counts: {assigned, missing, done}, groups: {label, items}[] }>}
 */
async function getTodo({ studentId, school, schoolYearId, tab, classId = null, now = new Date() }) {
  const work = await listWork({ studentId, school, schoolYearId });
  const items = (classId ? work.filter((w) => w.classId === classId) : work).map(toTodoItem);
  const counts = { assigned: 0, missing: 0, done: 0 };
  for (const i of items) {
    const t = todoTab(i);
    if (t) counts[t] += 1;
  }
  return { counts, groups: groupTodo(items, tab, now) };
}

/**
 * A class's Classwork for the student: the topics that hold something they
 * can see (with that count), their items, and what's coming up.
 * Callers check the student is in the class first.
 */
async function getClasswork({ studentId, school, classId, now = new Date() }) {
  const [work, { rows: topicRows }] = await Promise.all([
    listWork({ studentId, school, classId }),
    db.query(classworkQueries.selectTopics, [classId]),
  ]);
  const perTopic = new Map();
  for (const w of work) if (w.topicId) perTopic.set(w.topicId, (perTopic.get(w.topicId) || 0) + 1);
  return {
    topics: topicRows.filter((t) => perTopic.has(t.topic_id)).map((t) => ({
      topicId: t.topic_id, name: t.name, sortOrder: Number(t.sort_order) || 0, itemCount: perTopic.get(t.topic_id),
    })),
    items: work.map(toStudentItemSummary),
    upcoming: upcomingOf(work, now),
  };
}

/** A class's "Coming up" (≤ 3). Callers check the student is in the class first. */
async function getUpcoming({ studentId, school, classId, now = new Date() }) {
  return upcomingOf(await listWork({ studentId, school, classId }), now);
}

/** One item the student can see (selectStudentItem row), or null. */
async function loadItemRow(runner, { studentId, school, itemId }) {
  const { rows } = await runner.query(q.selectStudentItem, [studentId, school, itemId]);
  return rows[0] || null;
}

/** What the student may do with an item, from its row and (locked) submission. */
function permissions(row, { turnedInAt, textAnswer, fileCount }) {
  const turnedIn = Boolean(turnedInAt);
  const closed = Boolean(row.turn_in && row.closed);
  const settled = row.work_status === 'graded' || row.work_status === 'excused'; // a visible grade
  const canEdit = Boolean(row.turn_in) && !turnedIn && !closed && !settled;
  const mode = row.submission_mode;
  const hasWork = row.kind === 'assignment'
    && (mode === 'done' || (mode === 'file' && fileCount > 0) || (mode === 'text' && Boolean(textAnswer && textAnswer.trim())));
  return {
    closed,
    canEdit,
    canTurnIn: canEdit && hasWork,
    canUnsubmit: Boolean(row.turn_in) && turnedIn && !row.grade_visible && !closed && row.kind !== 'quiz',
  };
}

/**
 * The item's grade block, only when visible (spec 0.8), with the teacher's
 * feedback once that is visible too. An item with no gradebook column has no
 * grade, but its feedback is published the same way: it comes as a block
 * with no score and no maximum.
 */
function gradeBlock(row, w) {
  const feedback = row.visible_feedback ?? null;
  if (row.grade_visible) {
    return { score: visibleScore(row), maxScore: num(row.max_score), status: row.grade_status, feedback, publishedAt: w.publishedAt };
  }
  if (!row.assessment_id && feedback !== null) {
    return { score: null, maxScore: null, status: 'graded', feedback, publishedAt: iso(row.sub_published_at) };
  }
  return null;
}

/**
 * The student's thread about this item, as StudentItem.thread
 * ({ conversationId, messageCount }), or null: none yet, not a turn-in kind,
 * or (`forGuardian`, the parent lens) a thread the school keeps from guardians.
 */
async function itemThreadOf(row, { studentId, forGuardian }) {
  if (!takesThread(row.kind)) return null;
  const { rows } = await db.query(messagingQueries.findClassworkThread, [studentId, row.item_id]);
  const t = rows[0];
  if (!t || (forGuardian && t.guardians_hidden)) return null;
  return { conversationId: t.conversation_id, messageCount: Number(t.message_count) || 0 };
}

/**
 * The StudentItem payload. `canAct` is false for the parent lens (every can*
 * false). No grade or feedback leaves unless visible (spec 0.8).
 */
async function buildStudentItem(row, { canAct, studentId, forGuardian = !canAct }) {
  const [attachments, fileRows, photoUrl, thread] = await Promise.all([
    loadAttachments(row.item_id),
    row.submission_id ? db.query(q.selectSubmissionFiles, [row.submission_id]).then((r) => r.rows) : Promise.resolve([]),
    row.teacher_id ? signedPhotoUrl(row.teacher_photo_path) : Promise.resolve(null),
    itemThreadOf(row, { studentId, forGuardian }),
  ]);
  const identity = identityOf(row);
  const w = toWork(row, identity);
  const files = fileRows.map(toSubmissionFile);

  let submission = null;
  if (row.turn_in) {
    const can = permissions(row, { turnedInAt: row.turned_in_at, textAnswer: row.text_answer, fileCount: files.length });
    submission = {
      status: w.status,
      isLate: w.isLate,
      turnedInAt: w.turnedInAt,
      textAnswer: row.text_answer ?? null,
      textSavedAt: iso(row.text_saved_at),
      files,
      canEdit: canAct && can.canEdit,
      canTurnIn: canAct && can.canTurnIn,
      canUnsubmit: canAct && can.canUnsubmit,
      closed: can.closed,
    };
  }

  return {
    itemId: w.itemId,
    classId: w.classId,
    subject: w.subject,
    identity,
    kind: w.kind,
    submissionMode: w.submissionMode,
    title: w.title,
    instructions: row.instructions ?? null,
    teacher: w.teacher ? { ...w.teacher, photoUrl: photoUrl ?? null } : null,
    postedAt: w.postedAt,
    dueAt: w.dueAt,
    date: w.date,
    points: num(row.max_score),
    attachments,
    submission,
    grade: gradeBlock(row, w),
    thread,
    // Whether the student's parents read the messages about this work (the
    // school's parents_read_private_comments), for the page's copy.
    parentsCanRead: Boolean(row.parents_can_read),
  };
}

/**
 * One item for the student or the parent lens, or null (404) when the student
 * can't see it. `open` (the student, not a preview) creates the submission
 * row of a turn-in item on first open and stamps opened_at.
 */
async function getStudentItem({ studentId, school, itemId, canAct, open }) {
  const row = await loadItemRow(db, { studentId, school, itemId });
  if (!row) return null;
  if (open && row.turn_in) await db.query(q.openSubmission, [itemId, studentId]);
  return buildStudentItem(row, { canAct, studentId });
}

/** The item row when the student can see it (ITEM_VISIBLE, live class, their school), else null. */
const findVisibleItem = ({ studentId, school, itemId }) => loadItemRow(db, { studentId, school, itemId });

// ── Writes (the student's own work) ───────────────────────────────────────

/**
 * Runs `fn(client, row, sub)` in a transaction with the item checked (404
 * when the student can't see it, 400 when nothing is turned in online) and
 * the student's submission created if needed and locked.
 */
function withSubmission({ studentId, school, itemId }, fn) {
  return inTransaction(async (client) => {
    const row = await loadItemRow(client, { studentId, school, itemId });
    if (!row) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
    if (!row.turn_in) throw httpError(400, MESSAGES.NOTHING_TO_TURN_IN);
    await client.query(q.ensureSubmission, [itemId, studentId]);
    const { rows: [sub] } = await client.query(q.lockSubmission, [itemId, studentId]);
    return fn(client, row, sub);
  });
}

/** The 409s for a change to the student's work: turned in, closed, or already graded or excused. */
function assertEditable(row, turnedInAt) {
  if (turnedInAt) throw codedError(409, 'ALREADY_SUBMITTED', MESSAGES.SUBMITTED);
  if (row.closed) throw codedError(409, 'ITEM_CLOSED', MESSAGES.CLOSED);
  if (row.work_status === 'excused') throw codedError(409, 'ITEM_CLOSED', MESSAGES.EXCUSED);
  if (row.work_status === 'graded') throw codedError(409, 'ITEM_CLOSED', MESSAGES.GRADED);
}

/** Checks for an upload before the files are read (the route's guard). */
async function checkUploadable({ studentId, school, itemId }) {
  const row = await loadItemRow(db, { studentId, school, itemId });
  if (!row) throw httpError(404, MESSAGES.ITEM_NOT_FOUND);
  if (!row.turn_in) throw httpError(400, MESSAGES.NOTHING_TO_TURN_IN);
  if (row.submission_mode !== 'file') throw httpError(400, MESSAGES.NOT_FILE_MODE);
  assertEditable(row, row.turned_in_at);
}

/** Validates a typed answer: text up to 20 000 characters (blank clears it). */
function parseTextAnswer(value) {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: MESSAGES.TEXT_TYPE };
  if (value.length > TEXT_MAX) return { error: MESSAGES.TEXT_TOO_LONG };
  return { value: value === '' ? null : value };
}

/** PUT …/text: autosave of a typed answer. @returns {{ savedAt }} */
async function saveText({ studentId, school, itemId, text }) {
  return withSubmission({ studentId, school, itemId }, async (client, row, sub) => {
    if (row.submission_mode !== 'text') throw httpError(400, MESSAGES.NOT_TEXT_MODE);
    assertEditable(row, sub.turned_in_at);
    const { rows: [saved] } = await client.query(q.saveText, [sub.submission_id, text]);
    return { savedAt: iso(saved.text_saved_at) };
  });
}

/** Best-effort removal of stored submission files; logs and never throws. */
async function removeSubmissionObjects(paths) {
  if (!paths.length) return;
  try {
    const { error } = await supabase.storage.from(SUBMISSION_BUCKET).remove(paths);
    if (error) logger.warn({ err: error.message || error, paths }, 'Removing submission files failed');
  } catch (error) {
    logger.warn({ err: error?.message || error, paths }, 'Removing submission files failed');
  }
}

/**
 * POST …/files: stores the files, then lists every file of the submission.
 * Objects are stored inside the transaction; a failure removes them.
 * @returns {Promise<object[]>} SubmissionFile[]
 */
async function addFiles({ studentId, school, itemId, userId, files }) {
  const stored = [];
  try {
    return await withSubmission({ studentId, school, itemId }, async (client, row, sub) => {
      if (row.submission_mode !== 'file') throw httpError(400, MESSAGES.NOT_FILE_MODE);
      assertEditable(row, sub.turned_in_at);
      const { rows: [{ n }] } = await client.query(q.countSubmissionFiles, [sub.submission_id]);
      if (n + files.length > MAX_FILES_PER_SUBMISSION) throw httpError(400, MESSAGES.TOO_MANY_FILES);
      for (const f of files) {
        const filePath = submissionFilePath(school, itemId, studentId, f.originalname);
        const { error } = await supabase.storage.from(SUBMISSION_BUCKET).upload(filePath, f.buffer, { contentType: f.mimetype, upsert: false });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        stored.push(filePath);
        await client.query(q.insertSubmissionFile, [sub.submission_id, filePath, f.originalname, f.mimetype, f.size, userId]);
      }
      await client.query(q.touchSubmission, [sub.submission_id]);
      const { rows } = await client.query(q.selectSubmissionFiles, [sub.submission_id]);
      return rows.map(toSubmissionFile);
    });
  } catch (error) {
    await removeSubmissionObjects(stored);
    throw error;
  }
}

/** A file of the student's own submission on an item they can see, or null. */
async function loadOwnFile({ studentId, school, fileId }) {
  const { rows } = await db.query(q.selectOwnFile, [fileId, studentId, school]);
  return rows[0] || null;
}

/** DELETE /files/:fileId: the student's own file, while the work is still editable. */
async function deleteFile({ studentId, school, fileId }) {
  const file = await loadOwnFile({ studentId, school, fileId });
  if (!file) throw httpError(404, MESSAGES.FILE_NOT_FOUND);
  const removed = await withSubmission({ studentId, school, itemId: file.item_id }, async (client, row, sub) => {
    assertEditable(row, sub.turned_in_at);
    const { rows } = await client.query(q.deleteSubmissionFile, [fileId, sub.submission_id]);
    if (!rows[0]) throw httpError(404, MESSAGES.FILE_NOT_FOUND);
    await client.query(q.touchSubmission, [sub.submission_id]);
    return rows[0].file_path;
  });
  await removeSubmissionObjects([removed]);
  return { deleted: true };
}

/** POST …/turn-in: file needs ≥ 1 file, text a non-blank answer, done nothing; late past the due time. */
async function turnIn({ studentId, school, itemId }) {
  await withSubmission({ studentId, school, itemId }, async (client, row, sub) => {
    if (sub.turned_in_at) throw codedError(409, 'ALREADY_SUBMITTED', MESSAGES.ALREADY_TURNED_IN);
    assertEditable(row, null);
    const mode = row.submission_mode;
    if (row.kind === 'quiz' || mode === 'none') throw httpError(400, MESSAGES.QUIZ_TURN_IN);
    if (mode === 'file') {
      const { rows: [{ n }] } = await client.query(q.countSubmissionFiles, [sub.submission_id]);
      if (n === 0) throw httpError(400, MESSAGES.NEEDS_FILE);
    }
    if (mode === 'text' && !(sub.text_answer && sub.text_answer.trim())) throw httpError(400, MESSAGES.NEEDS_TEXT);
    await client.query(q.turnIn, [sub.submission_id]);
  });
}

/** POST …/unsubmit: only while no grade is visible, the item isn't closed, and it isn't a quiz. */
async function unsubmit({ studentId, school, itemId }) {
  await withSubmission({ studentId, school, itemId }, async (client, row, sub) => {
    if (!sub.turned_in_at) throw httpError(409, MESSAGES.NOT_TURNED_IN);
    if (row.grade_visible) throw codedError(409, 'ITEM_CLOSED', MESSAGES.GRADED_NO_UNSUBMIT);
    if (row.closed) throw codedError(409, 'ITEM_CLOSED', MESSAGES.CLOSED);
    if (row.kind === 'quiz') throw httpError(409, MESSAGES.QUIZ_UNSUBMIT);
    await client.query(q.unsubmit, [sub.submission_id]);
  });
}

/** A one-hour signed URL for one of the student's own files (null when not theirs or not visible). */
async function fileUrl({ studentId, school, fileId }) {
  const file = await loadOwnFile({ studentId, school, fileId });
  if (!file) return null;
  const { data, error } = await supabase.storage.from(SUBMISSION_BUCKET).createSignedUrl(file.file_path, SIGNED_URL_TTL);
  if (error || !data?.signedUrl) throw error || new Error('No signed URL');
  return data.signedUrl;
}

/** Each class's confirmed + derived missing count for the student. @returns {Promise<Map<string, number>>} */
async function missingCountsByClass({ studentId, school, classIds }) {
  if (!classIds.length) return new Map();
  const { rows } = await db.query(q.selectMissingByClass, [studentId, school, classIds]);
  return new Map(rows.map((r) => [r.class_id, Number(r.n) || 0]));
}

module.exports = {
  MESSAGES,
  TEXT_MAX,
  THREAD_KINDS,
  takesThread,
  findVisibleItem,
  toWork,
  toTodoItem,
  toStudentItemSummary,
  upcomingOf,
  classSummaries,
  dueWithin,
  dueSoonOf,
  missingOf,
  homeMissingOf,
  noticesOf,
  needsYouMissing,
  currentTermOf,
  listWork,
  getTodo,
  getClasswork,
  getUpcoming,
  getStudentItem,
  checkUploadable,
  parseTextAnswer,
  saveText,
  addFiles,
  deleteFile,
  turnIn,
  unsubmit,
  fileUrl,
  missingCountsByClass,
};
