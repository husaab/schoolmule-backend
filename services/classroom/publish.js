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
    const { rows: [batch] } = await client.query(publishQueries.insertBatch,
      [item.class_id, school, 'publish', [item.assessment_id], null, userId, 0]);
    await client.query(publishQueries.markPublished, [[item.assessment_id], userId, batch.batch_id]);
    assessmentPublished = true;
    batchId = batch.batch_id;
  }
  return { publishedStudentIds: subs.map((s) => s.student_id), assessmentPublished, batchId };
}

/**
 * After COMMIT. Never throws. The grades changed, so the cached grade
 * matrices and this week's AI summaries of these students are stale.
 * T21 adds the students' 'graded' emails here.
 */
async function afterPublish({ school, studentIds, itemId }) {
  try {
    analyticsEngine.invalidateCache(school);
    await invalidateWeeklySummaries(studentIds);
  } catch (error) {
    logger.warn({ err: error, itemId }, 'afterPublish bookkeeping failed');
  }
}

module.exports = { publishSubmissions, afterPublish };
