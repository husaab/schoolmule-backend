// services/classroom/publish.js
//
// Spec D3: a turn-in column's scores wait as drafts on the students'
// submissions; Publish copies them into the gradebook (student_assessments)
// and publishes the assessment the first time. Only published scores ever
// reach student_assessments, so a draft can't leak to a student, a parent,
// the parent portal or a report card. Used by the grading view (one student,
// a few, or "every graded one") and by the gradebook's Publish
// (assessmentPublish.controller), so Publish means the same everywhere.

const logger = require('../../logger');
const analyticsEngine = require('../analyticsEngine');
const { invalidateWeeklySummaries } = require('../aiWeeklySummary.service');
const q = require('../../queries/grading.queries');
const publishQueries = require('../../queries/assessmentPublish.queries');
const { enqueueGraded } = require('./classroomNotifier');

const OUTSIDE_AUDIENCE_MESSAGE = "This column also has grades for students this item isn't for. Publish the column in Grades first; then publish here.";

/** A 409 the controllers answer with its message and code. */
function conflict(message, code) {
  const err = new Error(message);
  err.status = 409;
  err.expose = true;
  err.code = code;
  return err;
}

/**
 * D3: copy drafts into the gradebook for these students and flip the
 * assessment to published on its first publish. Runs inside the caller's
 * transaction; the caller commits and then calls afterPublish().
 *
 * `studentIds` 'graded' publishes every pending draft (not yet published);
 * a list publishes those students' drafts, again if already published (a
 * re-publish after a regrade). Students the item is not for are never
 * published. An item with no gradebook column publishes its feedback.
 *
 * Locks the assessment before the submissions, the order every grading
 * writer uses, so a publish and a grade edit cannot deadlock or interleave.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ item: { item_id: string, class_id: string, assessment_id: string|null, is_published?: boolean },
 *           studentIds: string[] | 'graded', userId: string, school: string }} p
 * @returns {Promise<{ publishedStudentIds: string[], assessmentPublished: boolean, batchId: string|null }>}
 */
async function publishSubmissions(client, { item, studentIds, userId, school }) {
  const ids = studentIds === 'graded' ? null : [...new Set(studentIds.map((s) => String(s).toLowerCase()))];
  const linked = Boolean(item.assessment_id);
  let isPublished = Boolean(item.is_published);
  if (linked) {
    const { rows: [a] } = await client.query(q.lockAssessmentUpdate, [item.assessment_id]);
    isPublished = Boolean(a?.is_published);
  }

  const { rows: subs } = await client.query(q.lockPublishable, [item.item_id, ids, linked]);
  if (subs.length === 0) return { publishedStudentIds: [], assessmentPublished: false, batchId: null };
  // Students outside the item's audience are graded like a plain assessment:
  // publishing the column for some of the item's students would show their
  // grades too, so the column must be published in Grades first (round 3).
  if (linked && !isPublished) {
    const { rows: [outside] } = await client.query(q.countOutsideGrades, [item.item_id]);
    if ((outside?.n ?? 0) > 0) throw conflict(OUTSIDE_AUDIENCE_MESSAGE, 'OUTSIDE_AUDIENCE_GRADES');
  }

  if (linked) {
    for (const s of subs) {
      const status = s.draft_status || 'graded';
      await client.query(q.upsertStudentAssessment, [s.student_id, item.assessment_id, status === 'missing' ? null : s.draft_score, status]);
    }
  }
  await client.query(q.markSubmissionsPublished, [subs.map((s) => s.submission_id), userId]);

  let assessmentPublished = false;
  let batchId = null;
  if (linked && !isPublished) {
    // The column's first Publish is for these students only: every other
    // student's cell becomes a draft and any earlier publish of theirs is
    // withdrawn, so publishing the column shows exactly these grades.
    const published = subs.map((s) => s.student_id);
    await client.query(q.withdrawOthers, [item.item_id, published]);
    await client.query(q.moveCellsToDrafts, [item.item_id, item.assessment_id, published]);
    const { rows: [batch] } = await client.query(publishQueries.insertBatch,
      [item.class_id, school, 'publish', [item.assessment_id], null, userId, 0]);
    await client.query(publishQueries.markPublished, [[item.assessment_id], userId, batch.batch_id]);
    assessmentPublished = true;
    batchId = batch.batch_id;
  }
  return { publishedStudentIds: subs.map((s) => s.student_id), assessmentPublished, batchId };
}

/**
 * Every Classwork publish of a gradebook column is a publish batch: the
 * history shows it and the parent digest is logged against it. The column's
 * first Publish made one already (publishSubmissions); a later one makes it
 * here. Inside the caller's transaction, after publishSubmissions.
 * @returns {Promise<string|null>} the batch id (null: nothing published, or no column)
 */
async function ensurePublishBatch(client, { item, school, userId, published }) {
  if (published.batchId) return published.batchId;
  if (!item.assessment_id || published.publishedStudentIds.length === 0) return null;
  const { rows: [batch] } = await client.query(publishQueries.insertBatch,
    [item.class_id, school, 'publish', [item.assessment_id], null, userId, 0]);
  return batch.batch_id;
}

/**
 * Spec D3, when an assignment or quiz takes over a gradebook column that is
 * not published (it fills an existing column, or a plain assessment becomes
 * one): the column's cells become drafts on the item's submissions, so the
 * grading view shows them as drafts and they show to a student only once
 * that student is published. A published column is left as it is. Inside the
 * caller's transaction.
 */
async function cellsToDrafts(client, { itemId, assessmentId }) {
  if (!assessmentId) return;
  await client.query(q.moveCellsToDrafts, [itemId, assessmentId, []]);
}

/** "Bilal Karim has a grade …" / "A, B and 2 more have grades …" (UNPUBLISHED_DRAFTS_OUTSIDE). */
function unpublishedDraftsMessage(names) {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const who = more > 0 ? `${shown.join(', ')} and ${more} more`
    : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return names.length === 1
    ? `${who} has a grade on this item that isn't published yet. Publish it or clear it in the grading view first, then take them off this item.`
    : `${who} have grades on this item that aren't published yet. Publish or clear them in the grading view first, then take them off this item.`;
}

/**
 * After an item's audience changes (fix rounds 3 to 5), inside the caller's
 * transaction. A student of the class who left it is graded like a plain
 * assessment. An unpublished draft never shows without a Publish (D3), and
 * what was published stays published (its published_at is never cleared):
 * - unpublished column: their draft becomes their gradebook cell, which shows
 *   only once the column is published (in Grades, as on main);
 * - published column: a draft already published is in their cell, so its
 *   copy on the submission is cleared and the grade and feedback stay
 *   published; a draft not published yet refuses the change (409
 *   UNPUBLISHED_DRAFTS_OUTSIDE) until the teacher publishes or clears it.
 *   Only the students this edit takes off are checked: an older draft of a
 *   student who was off the roster or archived then is left as a draft.
 * A student who joined an unpublished column has their cell taken as a draft.
 * `wasFor`: the students the item was for before the edit (null = the class).
 */
async function reconcileAudience(client, { itemId, assessmentId, wasFor = null }) {
  if (!assessmentId) return;
  // The grading writers' lock order (the column before the submissions), so
  // a Publish can't flip the column between this check and the moves.
  const { rows: [a] } = await client.query(q.lockAssessmentShare, [assessmentId]);
  if (a?.is_published) {
    const { rows: held } = await client.query(q.selectUnpublishedDraftsOutside, [itemId, wasFor]);
    if (held.length > 0) throw conflict(unpublishedDraftsMessage(held.map((r) => r.name)), 'UNPUBLISHED_DRAFTS_OUTSIDE');
  }
  await client.query(q.draftsOutsideToCells, [itemId]); // writes unpublished columns only
  await client.query(q.clearDraftsOutside, [itemId]);
  await cellsToDrafts(client, { itemId, assessmentId });
}

/**
 * After COMMIT. Never throws. The grades changed, so the cached grade
 * matrices and this week's AI summaries of these students are stale; the
 * students get their "graded" email, bundled per 15 minutes (T21). Parents
 * keep today's publish digest, sent by the callers.
 */
async function afterPublish({ school, studentIds, itemId }) {
  try {
    analyticsEngine.invalidateCache(school);
    await invalidateWeeklySummaries(studentIds);
  } catch (error) {
    logger.warn({ err: error, itemId }, 'afterPublish bookkeeping failed');
  }
  await enqueueGraded({ school, studentIds });
}

module.exports = {
  publishSubmissions, ensurePublishBatch, cellsToDrafts, reconcileAudience, afterPublish, OUTSIDE_AUDIENCE_MESSAGE,
};
