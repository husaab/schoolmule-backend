// controllers/assessmentPublish.controller.js
//
// Publishing assessments to parents.
//
// Publish state is a hard gate: the parent portal only ever renders
// published assessments, and unpublished work is excluded from the
// parent-facing average entirely (analyticsEngine's publishedOnly option).
// Teachers therefore control exactly when grades "drop".
//
// Two ordering rules this file exists to get right:
//
//   1. No email is sent inside a request. A publish queues the parents'
//      "New Grades Posted" email in its own transaction (one outbox row per
//      guardian address, services/gradesDigest.js), so the grades and their
//      email commit together or not at all, and the notifier's tick sends it
//      after a short hold (services/email/outbox.js). A Resend outage can
//      never roll back or 500 a publish, and a restart can't lose an email.
//   2. Each address is its own row, retried on its own; the teacher sees
//      every outcome (GET .../batches/:batchId/delivery) and can resend the
//      failed ones (POST .../retry).
//
// All grade math routes through gradeEngine.computeAssessmentForStudent —
// the same null-skip helper the parent portal and report cards use. Never
// re-derive weighting here.


const db = require('../config/database');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const publishQueries = require('../queries/assessmentPublish.queries');
const outboxQueries = require('../queries/emailOutbox.queries');
const { getAssessmentPublishedEmailHTML } = require('../templates/emailTemplate');
const { getResend, sendOrThrow } = require('../utils/emailUtils');
const { schoolSender } = require('../services/email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const {
  computeAssessmentForStudent,
  buildScoreLookup,
  cellState,
} = require('../services/gradeEngine');
const { invalidateWeeklySummaries } = require('../services/aiWeeklySummary.service');
const gradingQueries = require('../queries/grading.queries');
const { publishSubmissions, afterPublish } = require('../services/classroom/publish');
const { enqueueGraded } = require('../services/classroom/classroomNotifier');
const digest = require('../services/gradesDigest');

const {
  groupScoreRowsByStudent,
  buildEmailTasks,
  resolveRecipients,
  topLevelLines,
  publishDigestTasks,
  loadEmailContext,
  speakButton,
  recipientAccess,
  recipientButtons,
  portalOrigin,
} = digest;

// Resend allows 10 requests a second per team; the backfill script paces itself with this.
const EMAIL_RATE_LIMIT_MS = 600;

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * The score rows as they will stand once these classwork drafts are published
 * (spec D3: a turn-in column's scores wait on the submissions until Publish
 * copies them into the gradebook). Returns a new map; `scoreRowsByStudent` is
 * not changed. A draft of a student not in the map (archived) is ignored.
 */
function overlayDrafts(scoreRowsByStudent, drafts) {
  if (!drafts || drafts.length === 0) return scoreRowsByStudent;
  const byKey = new Map(drafts.map((d) => [`${d.student_id}:${d.assessment_id}`, d]));
  const out = new Map();
  for (const [studentId, entry] of scoreRowsByStudent) {
    const rows = entry.rows.map((r) => {
      const d = byKey.get(`${studentId}:${r.assessment_id}`);
      if (!d) return r;
      const status = d.draft_status || 'graded';
      return { ...r, score: status === 'missing' ? null : d.draft_score, status, is_excluded: status === 'excused' };
    });
    out.set(studentId, { ...entry, rows });
  }
  return out;
}

/**
 * Expand the teacher's selection to the set that actually gets published.
 *
 * Selecting a category publishes the category plus every child of it that
 * has at least one score somewhere in the class. Ungraded children are
 * left alone — publishing an empty column tells a parent nothing and would
 * show up as missing work.
 */
function expandCascade(requested, allAssessments, scoreRowsByStudent) {
  const gradedAssessmentIds = new Set();
  for (const { rows } of scoreRowsByStudent.values()) {
    for (const r of rows) {
      const state = cellState(r);
      if (state === 'graded' || state === 'missing') gradedAssessmentIds.add(r.assessment_id);
    }
  }

  const finalIds = new Set(requested.map((a) => a.assessment_id));
  const cascadedChildIds = [];
  const skippedUngradedChildIds = [];

  for (const assessment of requested) {
    if (!assessment.is_parent) continue;
    const children = allAssessments.filter(
      (c) => c.parent_assessment_id === assessment.assessment_id,
    );
    for (const child of children) {
      if (finalIds.has(child.assessment_id)) continue;
      if (gradedAssessmentIds.has(child.assessment_id)) {
        finalIds.add(child.assessment_id);
        cascadedChildIds.push(child.assessment_id);
      } else {
        skippedUngradedChildIds.push(child.assessment_id);
      }
    }
  }

  return { finalIds: [...finalIds], cascadedChildIds, skippedUngradedChildIds };
}

/**
 * How many enrolled students are not yet graded (blank, carries no weight)
 * and how many are flagged missing (counts as 0) for each selected
 * assessment. Surfaced as a warning in the publish modal — never a block.
 */
function countUngradedStudents(requested, allAssessments, scoreRowsByStudent) {
  const warnings = [];

  for (const assessment of requested) {
    let ungraded = 0;
    let missing = 0;
    for (const { rows } of scoreRowsByStudent.values()) {
      const lookup = buildScoreLookup(rows);
      const result = computeAssessmentForStudent(assessment, allAssessments, lookup);
      if (result.state === 'blank') ungraded += 1;
      else if (result.state === 'missing') missing += 1;
    }
    if (ungraded > 0 || missing > 0) {
      warnings.push({
        assessmentId: assessment.assessment_id,
        assessmentName: assessment.name,
        ungradedStudentCount: ungraded,
        missingStudentCount: missing,
        totalStudents: scoreRowsByStudent.size,
      });
    }
  }

  return warnings;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/assessment-publications/classes/:classId
// Current publish state for every assessment in the class.
// ────────────────────────────────────────────────────────────────────
const getPublicationState = async (req, res) => {
  const { classId } = req.class;

  try {
    const { rows } = await db.query(publishQueries.selectPublicationStateByClass, [classId]);
    return res.status(200).json({
      status: 'success',
      data: rows.map((r) => ({
        assessmentId: r.assessment_id,
        isPublished: r.is_published,
        publishedAt: r.published_at,
        publishedBy: r.published_by,
        comment: r.parent_comment,
        lastBatchId: r.publication_batch_id,
      })),
    });
  } catch (error) {
    logger.error('Error fetching assessment publication state:', error);
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error fetching publication state' });
  }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/assessment-publications/classes/:classId/preview
// What would happen if we published this selection: ungraded warnings,
// cascade expansion, recipient count. Shares every code path with
// publish below, so the modal can never disagree with the send.
// ────────────────────────────────────────────────────────────────────
const previewPublish = async (req, res) => {
  const { classId } = req.class;
  const { assessmentIds } = req.body;

  if (!Array.isArray(assessmentIds) || assessmentIds.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'assessmentIds is required' });
  }

  try {
    const resolved = await resolveSelection(classId, assessmentIds);
    if (resolved.error) {
      return res.status(400).json({ status: 'failed', message: resolved.error, data: resolved.data });
    }

    const { requested, allAssessments } = resolved;
    const { cascade, scoreRowsByStudent } = planPublish(resolved);
    const warnings = countUngradedStudents(requested, allAssessments, scoreRowsByStudent);
    const tasks = publishDigestTasks(cascade.finalIds, allAssessments, scoreRowsByStudent);
    const recipients = await resolveRecipients(tasks);

    return res.status(200).json({
      status: 'success',
      data: {
        publishAssessmentIds: cascade.finalIds,
        cascadedChildIds: cascade.cascadedChildIds,
        skippedUngradedChildIds: cascade.skippedUngradedChildIds,
        warnings,
        studentCount: recipients.filter((r) => r.emails.length > 0).length,
        recipientCount: new Set(recipients.flatMap((r) => r.emails)).size,
        studentsWithoutEmail: recipients.filter((r) => r.emails.length === 0).length,
      },
    });
  } catch (error) {
    logger.error('Error previewing assessment publish:', error);
    return res.status(500).json({ status: 'failed', message: 'Error previewing publish' });
  }
};

/**
 * Load and validate a selection: the requested assessments must all belong
 * to the class. Returns everything the publish/preview paths need.
 */
async function resolveSelection(classId, assessmentIds) {
  const [{ rows: requested }, { rows: allAssessments }, { rows: cellRows }, { rows: pendingDrafts }, { rows: held }] = await Promise.all([
    db.query(publishQueries.selectAssessmentsInClass, [classId, assessmentIds]),
    db.query(publishQueries.selectAllAssessmentsInClass, [classId]),
    db.query(publishQueries.selectClassScoreRows, [classId]),
    db.query(gradingQueries.selectPendingDrafts, [classId]),
    db.query(gradingQueries.selectHeldCells, [classId]),
  ]);
  // A held draft's student (Fable I1, post-Fable m1): the cell on that
  // turn-in column is the grade from before the new work, which Publish
  // holds back (holdCellsAsDrafts), so every figure reads it as blank.
  const heldPairs = new Set(held.map((h) => `${h.student_id}:${h.assessment_id}`));
  const scoreRows = heldPairs.size === 0 ? cellRows : cellRows.map((r) => (heldPairs.has(`${r.student_id}:${r.assessment_id}`)
    ? { ...r, score: null, status: 'graded', is_excluded: false }
    : r));

  if (requested.length !== assessmentIds.length) {
    const found = new Set(requested.map((a) => a.assessment_id));
    return {
      error: 'One or more assessments do not belong to this class',
      data: { invalid: assessmentIds.filter((id) => !found.has(id)) },
    };
  }

  return {
    requested,
    allAssessments,
    scoreRowsByStudent: groupScoreRowsByStudent(scoreRows),
    pendingDrafts,
  };
}

/**
 * The cascade and the score rows a publish works from. A turn-in column whose
 * scores are still classwork drafts counts as graded for the cascade, and the
 * drafts of the columns being published stand in for their gradebook cells
 * (Publish copies them there), so the preview, the warnings and the digest
 * show what parents will see. Drafts of columns outside the selection stay
 * out of every figure, the running grade included. With no drafts this is
 * exactly the plain-assessment behaviour.
 */
function planPublish({ requested, allAssessments, scoreRowsByStudent, pendingDrafts = [] }) {
  const cascade = expandCascade(requested, allAssessments, overlayDrafts(scoreRowsByStudent, pendingDrafts));
  const published = new Set(cascade.finalIds);
  const drafts = pendingDrafts.filter((d) => published.has(d.assessment_id));
  return { cascade, scoreRowsByStudent: overlayDrafts(scoreRowsByStudent, drafts) };
}

// ────────────────────────────────────────────────────────────────────
// POST /api/assessment-publications/classes/:classId/publish
// ────────────────────────────────────────────────────────────────────
const publishAssessments = async (req, res) => {
  const { classId, school } = req.class;
  const { userId } = req.user;
  const { assessmentIds, batchComment, assessmentComments } = req.body;

  if (!Array.isArray(assessmentIds) || assessmentIds.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'assessmentIds is required' });
  }

  let batchId;
  let cascade;
  let queued;
  // Turn-in columns in the batch: their drafts are published in the same
  // transaction (spec D3), so "Publish" means the same here and in Classwork.
  const classworkPublished = [];
  const classworkStudents = new Map();

  try {
    const resolved = await resolveSelection(classId, assessmentIds);
    if (resolved.error) {
      return res.status(400).json({ status: 'failed', message: resolved.error, data: resolved.data });
    }

    const { requested, allAssessments } = resolved;
    const plan = planPublish(resolved);
    cascade = plan.cascade;
    const { scoreRowsByStudent } = plan;
    const warnings = countUngradedStudents(requested, allAssessments, scoreRowsByStudent);

    // ── Transaction: the publish and its queued emails, together. ──
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: batchRows } = await client.query(publishQueries.insertBatch, [
        classId,
        school,
        'publish',
        cascade.finalIds,
        batchComment || null,
        userId,
        warnings.reduce((sum, w) => sum + w.ungradedStudentCount, 0),
      ]);
      batchId = batchRows[0].batch_id;

      await client.query(publishQueries.markPublished, [cascade.finalIds, userId, batchId]);

      for (const [assessmentId, comment] of Object.entries(assessmentComments || {})) {
        await client.query(publishQueries.updateParentComment, [
          comment || null,
          assessmentId,
          classId,
        ]);
      }

      const { rows: turnInItems } = await client.query(gradingQueries.selectTurnInItemsForAssessments, [
        classId,
        cascade.finalIds,
      ]);
      for (const row of turnInItems) {
        // A held draft (Fable I1) is skipped exactly as "Publish to N" skips
        // it, and the grade from before the column was unpublished by hand
        // goes back to a draft instead of showing again (post-Fable m1).
        // The columns are locked (markPublished) before the submissions.
        const { rows: heldRows } = await client.query(gradingQueries.selectHeldStudents, [row.item_id]);
        const heldIds = heldRows.map((h) => h.student_id);
        if (heldIds.length > 0) {
          await client.query(gradingQueries.holdCellsAsDrafts, [row.item_id, row.assessment_id, heldIds]);
          await client.query(gradingQueries.withdrawHeldPublish, [row.item_id, heldIds]);
        }
        const result = await publishSubmissions(client, {
          item: { ...row, is_published: true },
          studentIds: 'graded',
          userId,
          school,
        });
        classworkPublished.push({
          assessmentId: row.assessment_id,
          itemId: row.item_id,
          studentCount: result.publishedStudentIds.length,
          skipped: heldIds.map((studentId) => ({ studentId, reason: 'draft_predates_work' })),
        });
        if (result.publishedStudentIds.length > 0) classworkStudents.set(row.item_id, result.publishedStudentIds);
      }

      // Last, so it reads the gradebook exactly as this publish leaves it
      // (comments, copied drafts, held cells): what the email will say.
      queued = await digest.enqueueGradeDigest(client, {
        classId, school, userId, batchId, assessmentIds: cascade.finalIds,
      });

      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Error publishing assessments:', error);
    return res.status(500).json({ status: 'failed', message: 'Error publishing assessments' });
  }

  // ── After the commit: bookkeeping only, so nothing here may turn a durable
  // publish into a 500 (the teacher would publish again).
  try {
    // Parents must see the change immediately, so drop the cached matrices
    // (both the full and published-only variants) for this school.
    engine.invalidateCache(school);
    // New marks invalidate this week's AI summary for the affected students.
    await invalidateWeeklySummaries(queued.students.map((s) => s.studentId));
    for (const [itemId, studentIds] of classworkStudents) {
      await afterPublish({ school, studentIds, itemId });
    }
    // Students get their "graded" email for every column published here
    // (spec D6), bundled with the Classwork ones above into one per student
    // per 15 minutes. Never throws.
    await enqueueGraded({ school, assessmentIds: cascade.finalIds });
  } catch (error) {
    logger.error('Publish committed, but its bookkeeping failed:', error);
  }

  return res.status(201).json({
    status: 'success',
    data: {
      batchId,
      classId,
      publishedAssessmentIds: cascade.finalIds,
      cascadedChildIds: cascade.cascadedChildIds,
      skippedUngradedChildIds: cascade.skippedUngradedChildIds,
      classworkPublished,
      delivery: deliveryReceipt(batchId, queued),
      emailSummary: legacyEmailSummary(queued),
    },
  });
};

/** What a publish queued: "Emailing N families". */
function deliveryReceipt(batchId, queued) {
  return { batchId, families: queued.families, noEmail: queued.noEmail };
}

/**
 * The old response's shape for a frontend from before the queue (between the
 * backend and frontend deploys): every family reads as queued, none as sent.
 */
function legacyEmailSummary(queued) {
  return {
    attempted: queued.students.length,
    sent: 0,
    failed: 0,
    skippedNoEmail: queued.noEmail,
    results: queued.students.map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      status: 'skipped',
      reason: s.hasEmail ? 'Email queued' : digest.NO_EMAIL,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────
// POST /api/assessment-publications/classes/:classId/preview-email
//
// Emails the caller one digest exactly as a parent will receive it, for the
// first graded student in the selection. Unsaved per-assessment notes from
// the modal are overlaid so the preview matches what Publish will send.
// Nothing is published, no audit row is written.
// ────────────────────────────────────────────────────────────────────
const previewPublishEmail = async (req, res) => {
  const { classId, school } = req.class;
  const { assessmentIds, batchComment, assessmentComments } = req.body;

  if (!Array.isArray(assessmentIds) || assessmentIds.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'assessmentIds is required' });
  }
  if (!req.user.email) {
    return res.status(400).json({ status: 'failed', message: 'Your account has no email address to send the preview to' });
  }

  try {
    const resolved = await resolveSelection(classId, assessmentIds);
    if (resolved.error) {
      return res.status(400).json({ status: 'failed', message: resolved.error, data: resolved.data });
    }

    const comments = assessmentComments && typeof assessmentComments === 'object' ? assessmentComments : {};
    const allAssessments = resolved.allAssessments.map((a) => {
      const draft = comments[a.assessment_id];
      return typeof draft === 'string' && draft.trim() ? { ...a, parent_comment: draft.trim() } : a;
    });
    const { cascade, scoreRowsByStudent } = planPublish({ ...resolved, allAssessments });
    const tasks = publishDigestTasks(cascade.finalIds, allAssessments, scoreRowsByStudent);
    if (tasks.length === 0) {
      return res.status(400).json({ status: 'failed', message: 'Nobody has a score for this selection yet, so there is no email to preview' });
    }

    const [recipients, emailContext] = await Promise.all([
      resolveRecipients(tasks),
      loadEmailContext(classId, school),
    ]);
    const { className, schoolInfo } = emailContext;
    const sample = tasks[0];
    // The preview goes to the teacher, so its buttons are plain links.
    const previewSpeak = speakButton(sample, classId, emailContext);
    const trimmedBatchComment = typeof batchComment === 'string' && batchComment.trim() ? batchComment.trim() : null;

    await sendOrThrow(getResend(), {
      ...schoolSender({ school, schoolInfo, role: 'academics' }),
      to: [req.user.email],
      subject: `[Preview] ${sample.studentName} — New Grades Posted (${className})`,
      html: getAssessmentPublishedEmailHTML({
        studentName: sample.studentName,
        className,
        assessments: sample.lines,
        speak: previewSpeak && { label: previewSpeak.label, url: `${portalOrigin()}${previewSpeak.path}` },
        runningGradeLabel: sample.runningGradeLabel,
        batchComment: trimmedBatchComment,
        schoolName: getSchoolName(school),
        schoolInfo,
        portalUrl: `${process.env.FRONTEND_URL}/parent/grades`,
      }),
    });

    return res.status(200).json({
      status: 'success',
      data: {
        sentTo: req.user.email,
        sampleStudentName: sample.studentName,
        recipientCount: new Set(recipients.flatMap((r) => r.emails)).size,
      },
    });
  } catch (error) {
    logger.error('Error sending publish preview email:', error);
    return res.status(500).json({ status: 'failed', message: 'Could not send the preview email' });
  }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/assessment-publications/classes/:classId/unpublish
//
// Deliberately does NOT cascade. Publish-cascade spares a teacher from
// clicking every child; unpublish is corrective, and silently pulling back
// siblings the teacher didn't select is the worse failure. To roll back a
// whole category, select the category and its children.
// ────────────────────────────────────────────────────────────────────
const unpublishAssessments = async (req, res) => {
  const { classId, school } = req.class;
  const { assessmentIds } = req.body;

  if (!Array.isArray(assessmentIds) || assessmentIds.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'assessmentIds is required' });
  }

  try {
    const { rows: requested } = await db.query(publishQueries.selectAssessmentsInClass, [
      classId,
      assessmentIds,
    ]);
    if (requested.length !== assessmentIds.length) {
      const found = new Set(requested.map((a) => a.assessment_id));
      return res.status(400).json({
        status: 'failed',
        message: 'One or more assessments do not belong to this class',
        data: { invalid: assessmentIds.filter((id) => !found.has(id)) },
      });
    }

    const targetIds = requested.filter((a) => a.is_published).map((a) => a.assessment_id);
    if (targetIds.length === 0) {
      return res.status(200).json({
        status: 'success',
        data: { batchId: null, classId, unpublishedAssessmentIds: [] },
      });
    }

    const client = await db.connect();
    let batchId;
    try {
      await client.query('BEGIN');

      const { rows: batchRows } = await client.query(publishQueries.insertBatch, [
        classId,
        school,
        'unpublish',
        targetIds,
        null,
        req.user.userId,
        0,
      ]);
      batchId = batchRows[0].batch_id;

      await client.query(publishQueries.markUnpublished, [targetIds, batchId]);
      // Queued emails about these columns alone are never sent (an undo
      // inside the hold); an email already sent can't be recalled.
      await digest.cancelUnpublished(client, classId);
      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }

    engine.invalidateCache(school);

    return res.status(200).json({
      status: 'success',
      data: { batchId, classId, unpublishedAssessmentIds: targetIds },
    });
  } catch (error) {
    logger.error('Error unpublishing assessments:', error);
    return res.status(500).json({ status: 'failed', message: 'Error unpublishing assessments' });
  }
};

// ────────────────────────────────────────────────────────────────────
// PATCH /api/assessment-publications/classes/:classId/assessments/:assessmentId/comment
//
// Silent by design: fixing a typo in a comment must not re-email every
// parent. Re-notifying is an explicit publish action.
// ────────────────────────────────────────────────────────────────────
const updateAssessmentComment = async (req, res) => {
  const { classId, school } = req.class;
  const { assessmentId } = req.params;
  const { comment } = req.body;

  try {
    const { rows } = await db.query(publishQueries.updateParentComment, [
      comment || null,
      assessmentId,
      classId,
    ]);

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ status: 'failed', message: 'Assessment not found in this class' });
    }

    // The comment is carried in the cached analytics matrix rows.
    engine.invalidateCache(school);

    return res.status(200).json({
      status: 'success',
      data: { assessmentId: rows[0].assessment_id, comment: rows[0].parent_comment },
    });
  } catch (error) {
    logger.error('Error updating assessment comment:', error);
    return res.status(500).json({ status: 'failed', message: 'Error updating comment' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/assessment-publications/classes/:classId/history
// ────────────────────────────────────────────────────────────────────
const getPublicationHistory = async (req, res) => {
  const { classId } = req.class;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const { rows } = await db.query(publishQueries.selectPublicationHistory, [
      classId,
      limit,
      offset,
    ]);
    // A publish since the queue: its counts come from its outbox rows (one
    // per family, with what is still waiting); an older one from its log.
    const { rows: outboxRows } = rows.length
      ? await db.query(outboxQueries.selectBySubjects, [digest.SUBJECT_TYPE, rows.map((r) => r.batch_id)])
      : { rows: [] };
    const queuedByBatch = new Map();
    for (const r of outboxRows) {
      queuedByBatch.set(r.subject_id, [...(queuedByBatch.get(r.subject_id) || []), r]);
    }

    return res.status(200).json({
      status: 'success',
      data: rows.map((r) => {
        const queued = queuedByBatch.get(r.batch_id);
        const emailSummary = queued
          ? { ...digest.summarizeDelivery(queued).counts, queued: true }
          : {
            pending: 0,
            sent: Number(r.emails_sent),
            failed: Number(r.emails_failed),
            skipped: Number(r.emails_skipped),
            queued: false,
          };
        return {
          batchId: r.batch_id,
          action: r.action,
          batchComment: r.batch_comment,
          studentWarningCount: r.student_warning_count,
          createdAt: r.created_at,
          triggeredBy: r.triggered_by
            ? { userId: r.triggered_by, name: r.triggered_by_name || null }
            : null,
          assessments: r.assessments || [],
          emailSummary,
        };
      }),
    });
  } catch (error) {
    logger.error('Error fetching publication history:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching history' });
  }
};

/** The publish, or a 404 answered: it must be this class's. */
async function loadBatch(req, res) {
  const { classId } = req.class;
  const { batchId } = req.params;
  if (!UUID.test(String(batchId || ''))) {
    res.status(404).json({ status: 'failed', message: 'Publish not found' });
    return null;
  }
  const { rows } = await db.query(publishQueries.selectBatchInClass, [batchId, classId]);
  if (rows.length === 0) {
    res.status(404).json({ status: 'failed', message: 'Publish not found' });
    return null;
  }
  return rows[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ────────────────────────────────────────────────────────────────────
// GET /api/assessment-publications/classes/:classId/batches/:batchId/delivery
// Each family's "New Grades Posted" email of one publish: waiting, sent,
// failed (with why) or skipped (with why).
// ────────────────────────────────────────────────────────────────────
const getBatchDelivery = async (req, res) => {
  try {
    const batch = await loadBatch(req, res);
    if (!batch) return undefined;
    return res.status(200).json({ status: 'success', data: { batchId: batch.batch_id, ...(await digest.batchDelivery(batch.batch_id)) } });
  } catch (error) {
    logger.error('Error fetching publish delivery:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching email status' });
  }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/assessment-publications/classes/:classId/batches/:batchId/retry
// Send a publish's failed emails again (to the addresses on file now).
// ────────────────────────────────────────────────────────────────────
const retryBatchEmails = async (req, res) => {
  const { classId, school } = req.class;
  try {
    const batch = await loadBatch(req, res);
    if (!batch) return undefined;
    const outcome = await digest.retryBatch({ batchId: batch.batch_id, classId, school, userId: req.user.userId });
    return res.status(200).json({
      status: 'success',
      data: { batchId: batch.batch_id, ...outcome, ...(await digest.batchDelivery(batch.batch_id)) },
    });
  } catch (error) {
    logger.error('Error retrying publish emails:', error);
    return res.status(500).json({ status: 'failed', message: 'Could not retry the emails' });
  }
};

module.exports = {
  getPublicationState,
  previewPublish,
  previewPublishEmail,
  publishAssessments,
  unpublishAssessments,
  updateAssessmentComment,
  getPublicationHistory,
  getBatchDelivery,
  retryBatchEmails,
  // exported for unit testing
  expandCascade,
  countUngradedStudents,
  buildEmailTasks,
  publishDigestTasks,
  recipientAccess,
  recipientButtons,
  topLevelLines,
  overlayDrafts,
  planPublish,
  // also used by scripts/backfillPublishDigests.js
  groupScoreRowsByStudent,
  resolveRecipients,
  loadEmailContext,
  EMAIL_RATE_LIMIT_MS,
};
