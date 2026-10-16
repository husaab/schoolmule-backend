/*
  controllers/grading.controller.js
  Grading turned-in work (/api/classroom, staff only). Item routes run
  requireClassroomResource('item'); the grid overlay runs
  requireClassOwnership.

  Spec D3: a score on an assignment or quiz with a gradebook column is a
  draft on the student's submission (only the teacher sees it) until Publish
  copies it into the gradebook; the column's assessment is published on its
  first Publish. D17: once the assessment is published, a grade edit goes
  live as it saves (no email). An item with no gradebook column carries
  feedback only, published the same way.

  The words: Draft, Publish, Published. Students and parents see "Graded".
*/

const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const q = require('../queries/grading.queries');
const classworkQueries = require('../queries/classwork.queries');
const publishQueries = require('../queries/assessmentPublish.queries');
const { toItemSummary, httpError, inTransaction } = require('../services/classroom/classworkItems');
const { publishSubmissions, afterPublish } = require('../services/classroom/publish');
const { sendGradeDigest } = require('./assessmentPublish.controller');
const { SUBMISSION_BUCKET, SIGNED_URL_TTL } = require('../utils/classworkUpload');
const { STATUSES } = require('../services/gradeEngine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_MAX = 5000;
const MAX_STUDENTS = 500;
const GRADED_KINDS = new Set(['assignment', 'quiz']);

const MESSAGES = {
  NOT_GRADED_HERE: 'Only assignments and quizzes are graded here.',
  STUDENT_NOT_FOUND: 'Student not found',
  NO_COLUMN_SCORE: 'Scores need a gradebook column.',
  NO_COLUMN_MISSING: 'Missing needs a gradebook column.',
  NO_COLUMN_EXCUSED: 'Excused needs a gradebook column.',
};

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });
const has = (body, key) => Boolean(body) && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
const iso = (value) => (value ? new Date(value).toISOString() : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));

/** A service error (httpError) answers with its own status; anything else is logged as a 500. */
function fail(res, error, userMessage, context) {
  if (error && error.expose && error.status) return failed(res, error.status, error.message);
  logger.error({ err: error, ...context }, userMessage);
  return failed(res, 500, userMessage);
}

// ── Shapes ────────────────────────────────────────────────────────────────

/** The row's label in the grading list, in the order a teacher reads it. */
function gradingLabel(row) {
  if (row.isDraft) return 'Graded · draft';
  if (row.publishedStatus === 'excused') return 'Excused';
  if (row.publishedStatus === 'missing') return 'Missing';
  if (row.publishedStatus === 'graded' || (!row.linked && row.publishedAt)) return 'Published';
  if (row.status === 'turned_in') return row.isLate ? 'Turned in · late' : 'Turned in';
  if (row.status === 'missing') return 'Missing';
  return 'Not turned in yet';
}

/**
 * A selectGradingRows row → GradingRow. `linked`: the item fills a gradebook
 * column; `assessmentPublished`: that column is published. published* are
 * what the student and parents see now (spec 0.8); needsPublish is what
 * "Publish to N students" counts: a draft not published yet, or any draft
 * while the column itself is unpublished (unpublished in the gradebook after
 * a publish), since nothing of it shows until it is published again.
 */
function toGradingRow(r, { linked, assessmentPublished = false }) {
  const draftScore = linked ? num(r.draft_score) : null;
  const draftStatus = linked ? r.draft_status ?? null : null;
  const hasDraft = draftScore !== null || draftStatus !== null;
  const feedback = r.feedback ?? null;
  const unpublished = !r.sub_published_at || (linked && !assessmentPublished);
  const turnedInAt = iso(r.turned_in_at);
  const publishedStatus = linked ? r.visible_status ?? null : null;
  const row = {
    studentId: r.student_id,
    name: r.name,
    avatar: r.avatar ?? null,
    status: r.work_status,
    isLate: Boolean(turnedInAt && r.sub_is_late),
    turnedInAt,
    draftScore,
    draftStatus,
    publishedScore: publishedStatus === 'graded' ? num(r.visible_score) : null,
    publishedStatus,
    publishedAt: iso(linked ? r.visible_published_at : r.sub_published_at),
    feedback,
    needsPublish: (hasDraft || (!linked && feedback !== null)) && unpublished,
    hasThread: false, // T17
  };
  const label = gradingLabel({ ...row, linked, isDraft: linked && hasDraft && unpublished });
  return {
    row: { ...row, label },
    awaitingGrade: Boolean(turnedInAt) && !hasDraft && !r.sub_published_at && !r.grade_visible,
  };
}

/** GradingList counts over the shaped rows. */
function gradingCounts(shaped) {
  const rows = shaped.map((s) => s.row);
  return {
    all: rows.length,
    turnedIn: rows.filter((r) => r.turnedInAt).length,
    toGrade: shaped.filter((s) => s.awaitingGrade).length,
    missing: rows.filter((r) => r.status === 'missing').length,
    drafts: rows.filter((r) => r.needsPublish).length,
    published: rows.filter((r) => r.publishedAt).length,
  };
}

// ── Guards and loaders ────────────────────────────────────────────────────

/** The item being graded (an assignment or quiz), or an httpError. `runner` is the pool or a client. */
async function loadGradingItem(itemId, runner = db) {
  const { rows: [item] } = await runner.query(q.selectGradingItem, [itemId]);
  if (!item) throw httpError(404, 'Item not found');
  if (!GRADED_KINDS.has(item.kind)) throw httpError(400, MESSAGES.NOT_GRADED_HERE);
  return item;
}

const shapeOptions = (item) => ({ linked: Boolean(item.assessment_id), assessmentPublished: Boolean(item.is_published) });

/** One student's GradingRow, or null when the item is not for them. */
async function loadRow(item, studentId, runner = db) {
  const { rows } = await runner.query(q.selectGradingRows, [item.item_id, studentId]);
  return rows[0] ? { raw: rows[0], ...toGradingRow(rows[0], shapeOptions(item)) } : null;
}

/** `studentIds` from a body: a non-empty list of student ids (deduped, lower-cased), or an httpError. */
function parseStudentIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw httpError(400, 'studentIds must list at least one student');
  if (value.length > MAX_STUDENTS) throw httpError(400, `At most ${MAX_STUDENTS} students at a time`);
  if (value.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) throw httpError(400, 'studentIds must be student ids');
  return [...new Set(value.map((v) => v.toLowerCase()))];
}

/**
 * The PATCH body, checked. Returns { score?, status?, feedback? } with only
 * the keys sent. A score is 0..max (an unset max is 100, as in the grid).
 */
function parseGradeBody(body, item) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Send the grade as JSON');
  const out = {};
  if (has(body, 'draftScore')) {
    if (body.draftScore === null || body.draftScore === '') {
      out.score = null;
    } else {
      const value = Number(body.draftScore);
      const max = parseFloat(item.max_score) || 100;
      if (typeof body.draftScore === 'boolean' || !Number.isFinite(value) || value < 0 || value > max) {
        throw httpError(400, `Score must be between 0 and ${max}`);
      }
      out.score = value;
    }
  }
  if (has(body, 'draftStatus')) {
    if (body.draftStatus !== null && !STATUSES.includes(body.draftStatus)) {
      throw httpError(400, `draftStatus must be one of ${STATUSES.join(', ')}`);
    }
    out.status = body.draftStatus;
  }
  if (has(body, 'feedback')) {
    if (body.feedback !== null && typeof body.feedback !== 'string') throw httpError(400, 'feedback must be text');
    const text = typeof body.feedback === 'string' ? body.feedback.trim() : '';
    if (text.length > FEEDBACK_MAX) throw httpError(400, `Feedback must be at most ${FEEDBACK_MAX} characters`);
    out.feedback = text || null;
  }
  if (Object.keys(out).length === 0) throw httpError(400, 'Send draftScore, draftStatus or feedback');
  if (!item.assessment_id && (has(out, 'score') || has(out, 'status'))) throw httpError(400, MESSAGES.NO_COLUMN_SCORE);
  return out;
}

/** Signed URLs (1 h) for a submission's files. */
async function signedFiles(submissionId) {
  if (!submissionId) return [];
  const { rows } = await db.query(q.selectSubmissionFiles, [submissionId]);
  if (rows.length === 0) return [];
  let byPath = new Map();
  try {
    const { data } = await supabase.storage.from(SUBMISSION_BUCKET).createSignedUrls(rows.map((r) => r.file_path), SIGNED_URL_TTL);
    byPath = new Map((data || []).map((d) => [d.path, d.signedUrl || null]));
  } catch (error) {
    logger.warn({ err: error, submissionId }, 'Signing submission files failed');
  }
  return rows.map((r) => ({
    fileId: r.file_id, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: Number(r.size_bytes), url: byPath.get(r.file_path) ?? null,
  }));
}

// ── Reads ─────────────────────────────────────────────────────────────────

// GET /api/classroom/items/:itemId/submissions → GradingList
const listSubmissions = async (req, res) => {
  const { itemId } = req.item;
  try {
    const item = await loadGradingItem(itemId);
    const [{ rows: [itemRow] }, { rows }] = await Promise.all([
      db.query(classworkQueries.selectItem, [itemId]),
      db.query(q.selectGradingRows, [itemId, null]),
    ]);
    const summary = toItemSummary(itemRow);
    const shaped = rows.map((r) => toGradingRow(r, shapeOptions(item)));
    return ok(res, {
      item: { ...summary, maxScore: summary.gradebook?.maxScore ?? null, categoryName: summary.gradebook?.categoryName ?? null },
      isAssessmentPublished: Boolean(item.assessment_id && item.is_published),
      counts: gradingCounts(shaped),
      students: shaped.map((s) => s.row),
    });
  } catch (error) {
    return fail(res, error, 'Error loading the submissions', { itemId });
  }
};

// GET /api/classroom/items/:itemId/submissions/:studentId
const getSubmission = async (req, res) => {
  const { itemId } = req.item;
  const studentId = req.params.studentId.toLowerCase();
  try {
    const item = await loadGradingItem(itemId);
    const found = await loadRow(item, studentId);
    if (!found) return failed(res, 404, MESSAGES.STUDENT_NOT_FOUND);
    return ok(res, {
      row: found.row,
      textAnswer: found.raw.text_answer ?? null,
      files: await signedFiles(found.raw.submission_id),
      quiz: null, // T23
      thread: null, // T17
    });
  } catch (error) {
    return fail(res, error, 'Error loading the submission', { itemId, studentId });
  }
};

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * The grade a PATCH leaves: the sent keys over the current draft. A typed
 * score is evidence, so it resets the status to graded unless one is sent
 * (as the grid does); missing never carries a score.
 */
function nextGrade(current, patch) {
  let score = has(patch, 'score') ? patch.score : num(current.draft_score);
  let status = has(patch, 'status') ? patch.status : current.draft_status ?? null;
  if (has(patch, 'score') && patch.score !== null && !has(patch, 'status')) status = 'graded';
  if (status === 'missing') score = null;
  return { score, status };
}

// PATCH /api/classroom/items/:itemId/submissions/:studentId  { draftScore?, draftStatus?, feedback? }
// → { row: GradingRow, live }  (live: the grade and feedback are visible to the student now)
const updateSubmission = async (req, res) => {
  const { itemId } = req.item;
  const { school } = req.class;
  const { userId } = req.user;
  const studentId = req.params.studentId.toLowerCase();
  try {
    const result = await inTransaction(async (client) => {
      const item = await loadGradingItem(itemId, client);
      const patch = parseGradeBody(req.body, item);
      const linked = Boolean(item.assessment_id);
      // Lock order: the assessment, then the submission (as Publish does).
      let isPublished = false;
      if (linked) {
        const { rows: [a] } = await client.query(q.lockAssessmentShare, [item.assessment_id]);
        isPublished = Boolean(a?.is_published);
      }
      const { rows: [inAudience] } = await client.query(q.selectAudienceIds, [itemId, [studentId]]);
      if (!inAudience) throw httpError(404, MESSAGES.STUDENT_NOT_FOUND);
      await client.query(q.ensureSubmission, [itemId, studentId]);
      const { rows: [current] } = await client.query(q.lockSubmission, [itemId, studentId]);

      let wroteLive = false;
      if (has(patch, 'score') || has(patch, 'status')) {
        // Published: the change applies to the cell the student sees.
        const base = isPublished && current.live_status
          ? { draft_score: current.live_score, draft_status: current.live_status }
          : current;
        const { score, status } = nextGrade(base, patch);
        if (isPublished) {
          // D17: the assessment is published, so the grade goes live (no email).
          const liveStatus = status || 'graded';
          const { rows: [cell] } = await client.query(q.upsertStudentAssessment,
            [studentId, item.assessment_id, liveStatus === 'missing' ? null : score, liveStatus]);
          await client.query(q.syncLiveSubmission, [itemId, studentId, cell.score, cell.status, userId]);
          wroteLive = true;
        } else {
          await client.query(q.upsertDraftScore, [itemId, studentId, score, status, userId]);
        }
      }
      if (has(patch, 'feedback') && patch.feedback !== (current.feedback ?? null)) {
        await client.query(q.saveFeedback, [current.submission_id, patch.feedback]);
      }
      const found = await loadRow({ ...item, is_published: isPublished }, studentId, client);
      const { rows: [sub] } = await client.query(q.lockSubmission, [itemId, studentId]);
      const live = Boolean(sub.published_at) && (!linked || isPublished);
      return { row: found.row, live, wroteLive };
    });
    if (result.wroteLive) engine.invalidateCache(school);
    return ok(res, { row: result.row, live: result.live });
  } catch (error) {
    return fail(res, error, 'Error saving the grade', { itemId, studentId });
  }
};

/**
 * Publishes in a transaction: `prepare(client, item, audienceIds)` writes any
 * drafts first and returns { studentIds, extra }; then the drafts are
 * published (publishSubmissions). After COMMIT: afterPublish and today's
 * parent digest for the published students. Answers
 * { publishedStudentIds, skipped, assessmentPublished, emailSummary, ...extra }.
 */
async function runPublish(req, res, { requested, prepare, errorMessage }) {
  const { itemId } = req.item;
  const { school } = req.class;
  const { userId } = req.user;
  try {
    const outcome = await inTransaction(async (client) => {
      const item = await loadGradingItem(itemId, client);
      // Lock the column first: drafts and the publish below see one state.
      if (item.assessment_id) await client.query(q.lockAssessmentUpdate, [item.assessment_id]);
      const audienceRows = requested === 'graded'
        ? (await client.query(q.selectAllAudienceIds, [itemId])).rows
        : (await client.query(q.selectAudienceIds, [itemId, requested])).rows;
      const audience = audienceRows.map((r) => r.student_id);
      const prepared = prepare ? await prepare(client, item, audience) : { studentIds: requested === 'graded' ? 'graded' : audience };
      const targets = prepared.studentIds;
      const published = (targets === 'graded' || targets.length > 0)
        ? await publishSubmissions(client, { item, studentIds: targets, userId, school })
        : { publishedStudentIds: [], assessmentPublished: false, batchId: null };
      // Every Classwork publish of a gradebook column is a publish batch:
      // the history shows it and the parent digest is logged against it.
      let { batchId } = published;
      if (item.assessment_id && published.publishedStudentIds.length > 0 && !batchId) {
        const { rows: [batch] } = await client.query(publishQueries.insertBatch,
          [item.class_id, school, 'publish', [item.assessment_id], null, userId, 0]);
        batchId = batch.batch_id;
      }
      return { item, audience, published, batchId, extra: prepared.extra || {} };
    });

    const { item, audience, published, batchId, extra } = outcome;
    const publishedSet = new Set(published.publishedStudentIds);
    const audienceSet = new Set(audience);
    const skipped = (requested === 'graded' ? audience : requested)
      .filter((id) => !publishedSet.has(id))
      .map((id) => ({ studentId: id, reason: audienceSet.has(id) ? 'no_draft' : 'not_in_audience' }));

    let emailSummary = { attempted: 0, sent: 0, failed: 0, skippedNoEmail: 0, results: [] };
    if (published.publishedStudentIds.length > 0) {
      await afterPublish({ school, studentIds: published.publishedStudentIds, itemId });
      if (item.assessment_id) {
        emailSummary = await sendGradeDigest({
          classId: item.class_id, school, userId, batchId, assessmentIds: [item.assessment_id], studentIds: published.publishedStudentIds,
        });
      }
    }
    return ok(res, {
      publishedStudentIds: published.publishedStudentIds,
      skipped,
      assessmentPublished: published.assessmentPublished,
      ...extra,
      emailSummary,
    });
  } catch (error) {
    return fail(res, error, errorMessage, { itemId });
  }
}

// POST /api/classroom/items/:itemId/publish  { studentIds: uuid[] | 'graded' }
const publish = async (req, res) => {
  let requested;
  try {
    requested = req.body?.studentIds === 'graded' ? 'graded' : parseStudentIds(req.body?.studentIds);
  } catch (error) {
    return fail(res, error, 'Error publishing grades');
  }
  return runPublish(req, res, { requested, errorMessage: 'Error publishing grades' });
};

/** Sets the draft status of the audience students, then publishes them (Mark missing, Excuse). */
const markAndPublish = (status, noColumnMessage, errorMessage) => async (req, res) => {
  let requested;
  try {
    requested = parseStudentIds(req.body?.studentIds);
  } catch (error) {
    return fail(res, error, errorMessage);
  }
  return runPublish(req, res, {
    requested,
    errorMessage,
    prepare: async (client, item, audience) => {
      if (!item.assessment_id) throw httpError(400, noColumnMessage);
      for (const studentId of audience) {
        await client.query(q.setDraftStatus, [item.item_id, studentId, status, req.user.userId]);
      }
      return { studentIds: audience, extra: { updatedStudentIds: audience } };
    },
  });
};

// POST /api/classroom/items/:itemId/mark-missing  { studentIds }
// D7: the zero is written when the teacher confirms. Missing is published at once.
const markMissing = markAndPublish('missing', MESSAGES.NO_COLUMN_MISSING, 'Error marking work missing');

const excuseStudents = markAndPublish('excused', MESSAGES.NO_COLUMN_EXCUSED, 'Error excusing students');

/**
 * Lifts an excuse: the draft keeps its score as a graded one (or is cleared,
 * keeping an explicit clear when the gradebook still holds the excuse). On a
 * published column the change goes live at once (D17); on an unpublished one
 * it stays a draft.
 */
const unexcuseStudents = async (req, res) => {
  let requested;
  try {
    requested = parseStudentIds(req.body?.studentIds);
  } catch (error) {
    return fail(res, error, 'Error excusing students');
  }
  return runPublish(req, res, {
    requested,
    errorMessage: 'Error excusing students',
    prepare: async (client, item, audience) => {
      if (!item.assessment_id) throw httpError(400, MESSAGES.NO_COLUMN_EXCUSED);
      const { rows: excused } = await client.query(q.selectExcused, [item.item_id, audience]);
      for (const e of excused) {
        await client.query(q.upsertDraftScore, [item.item_id, e.student_id, e.draft_score, 'graded', req.user.userId]);
      }
      const ids = excused.map((e) => e.student_id);
      const { rows: [a] } = await client.query(q.lockAssessmentShare, [item.assessment_id]);
      return { studentIds: a?.is_published ? ids : [], extra: { updatedStudentIds: ids } };
    },
  });
};

// POST /api/classroom/items/:itemId/excuse  { studentIds, excused }
const excuse = (req, res) => {
  if (typeof req.body?.excused !== 'boolean') return failed(res, 400, 'excused must be true or false');
  return req.body.excused ? excuseStudents(req, res) : unexcuseStudents(req, res);
};

// ── The gradebook grid's classwork layer ─────────────────────────────────

// GET /api/classroom/classes/:classId/grid-overlay
const getGridOverlay = async (req, res) => {
  const { classId } = req.class;
  try {
    const [{ rows: items }, { rows: cells }] = await Promise.all([
      db.query(q.selectOverlayItems, [classId]),
      db.query(q.selectOverlayCells, [classId]),
    ]);
    return ok(res, {
      items: items.map((r) => ({ assessmentId: r.assessment_id, itemId: r.item_id, kind: r.kind, submissionMode: r.submission_mode })),
      cells: cells.map((r) => ({
        studentId: r.student_id,
        assessmentId: r.assessment_id,
        state: r.state,
        draftScore: r.state === 'draft' ? num(r.draft_score) : null,
        draftStatus: r.state === 'draft' ? r.draft_status ?? null : null,
        isLate: Boolean(r.is_late),
      })),
    });
  } catch (error) {
    logger.error({ err: error, classId }, 'Failed to load the grid overlay');
    return failed(res, 500, 'Error loading the classwork grades');
  }
};

module.exports = {
  listSubmissions, getSubmission, updateSubmission, publish, markMissing, excuse, getGridOverlay,
  // exported for unit testing
  toGradingRow, gradingCounts, gradingLabel, nextGrade,
};
