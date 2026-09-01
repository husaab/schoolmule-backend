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
//   1. The publish transaction COMMITs before a single email is sent. A
//      Resend outage must never roll back or 500 an otherwise-successful
//      publish — see registerUser in auth.controller.js for the bug this
//      avoids (it commits, then emails inside the same try, so an email
//      failure ROLLBACKs an already-committed transaction and returns 500
//      for a user that was in fact created).
//   2. Every email is wrapped individually, so one bad address cannot
//      abort the rest of the batch. Outcomes are logged per recipient and
//      reported back to the teacher.
//
// All grade math routes through studentViewEvaluator.computeAssessmentForStudent —
// the same null-skip helper the parent portal and report cards use. Never
// re-derive weighting here.

const { Resend } = require('resend');

const db = require('../config/database');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const publishQueries = require('../queries/assessmentPublish.queries');
const classQueries = require('../queries/class.queries');
const schoolQueries = require('../queries/school.queries');
const { getAssessmentPublishedEmailHTML } = require('../templates/emailTemplate');
const { cleanEmailArray, getSchoolApiKey, getSchoolDomain } = require('../utils/emailUtils');
const { getSchoolName } = require('../utils/schoolUtils');
const {
  computeAssessmentForStudent,
  buildScoreLookup,
} = require('../services/studentViewEvaluator');
const { invalidateWeeklySummaries } = require('../services/aiWeeklySummary.service');

// Resend allows ~2 requests/second. Matches sendBulkReportEmails.
const EMAIL_RATE_LIMIT_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Group flat score rows into { studentId -> { name, rows[] } }. */
function groupScoreRowsByStudent(rows) {
  const byStudent = new Map();
  for (const r of rows) {
    let entry = byStudent.get(r.student_id);
    if (!entry) {
      entry = { studentId: r.student_id, studentName: r.student_name, rows: [] };
      byStudent.set(r.student_id, entry);
    }
    entry.rows.push(r);
  }
  return byStudent;
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
      if (r.score != null && !r.is_excluded) gradedAssessmentIds.add(r.assessment_id);
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
 * How many enrolled students have no usable grade for each selected
 * assessment. Surfaced as a warning in the publish modal — never a block.
 */
function countUngradedStudents(requested, allAssessments, scoreRowsByStudent) {
  const warnings = [];

  for (const assessment of requested) {
    let ungraded = 0;
    for (const { rows } of scoreRowsByStudent.values()) {
      const lookup = buildScoreLookup(rows);
      const result = computeAssessmentForStudent(assessment, allAssessments, lookup);
      if (!result.isGraded) ungraded += 1;
    }
    if (ungraded > 0) {
      warnings.push({
        assessmentId: assessment.assessment_id,
        assessmentName: assessment.name,
        ungradedStudentCount: ungraded,
        totalStudents: scoreRowsByStudent.size,
      });
    }
  }

  return warnings;
}

/** Format one assessment's result for the email table. */
function formatAssessmentLine(assessment, result) {
  const pct = Math.round(result.pct * 10) / 10;
  return {
    name: assessment.name,
    // A category has no raw score — only a weighted rollup of its children.
    scoreLabel: result.earned != null && result.max != null ? `${result.earned}/${result.max}` : '',
    pctLabel: `(${pct}%)`,
    comment: assessment.parent_comment || null,
  };
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

    const { requested, allAssessments, scoreRowsByStudent } = resolved;
    const cascade = expandCascade(requested, allAssessments, scoreRowsByStudent);
    const warnings = countUngradedStudents(requested, allAssessments, scoreRowsByStudent);
    const tasks = buildEmailTasks(cascade.finalIds, allAssessments, scoreRowsByStudent);
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
  const [{ rows: requested }, { rows: allAssessments }, { rows: scoreRows }] = await Promise.all([
    db.query(publishQueries.selectAssessmentsInClass, [classId, assessmentIds]),
    db.query(publishQueries.selectAllAssessmentsInClass, [classId]),
    db.query(publishQueries.selectClassScoreRows, [classId]),
  ]);

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
  };
}

/**
 * One email task per student who has at least one graded assessment among
 * the published set. A student with nothing graded gets no email at all —
 * an empty digest tells a parent nothing.
 *
 * Only top-level assessments appear in the email body: a cascaded child is
 * already represented by its category's rollup, and listing both would
 * double-report the same work.
 */
function buildEmailTasks(publishedIds, allAssessments, scoreRowsByStudent) {
  const publishedSet = new Set(publishedIds);
  const topLevelPublished = allAssessments.filter(
    (a) => publishedSet.has(a.assessment_id) && !a.parent_assessment_id,
  );

  const tasks = [];
  for (const student of scoreRowsByStudent.values()) {
    const lookup = buildScoreLookup(student.rows);
    const lines = [];
    const gradedIds = [];

    for (const assessment of topLevelPublished) {
      const result = computeAssessmentForStudent(assessment, allAssessments, lookup);
      if (!result.isGraded) continue;
      lines.push(formatAssessmentLine(assessment, result));
      gradedIds.push(assessment.assessment_id);
    }

    if (lines.length === 0) continue;
    tasks.push({
      studentId: student.studentId,
      studentName: student.studentName,
      lines,
      gradedAssessmentIds: gradedIds,
    });
  }

  return tasks;
}

/** Attach guardian email addresses to each email task. */
async function resolveRecipients(tasks) {
  if (tasks.length === 0) return [];

  const { rows } = await db.query(publishQueries.selectGuardianEmailsByStudent, [
    tasks.map((t) => t.studentId),
  ]);
  const emailsByStudent = new Map(rows.map((r) => [r.student_id, r.guardian_emails || []]));

  return tasks.map((task) => ({
    ...task,
    emails: [...new Set(cleanEmailArray(emailsByStudent.get(task.studentId) || []))],
  }));
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
  let tasksWithEmails;
  let committedScoreRows;

  try {
    const resolved = await resolveSelection(classId, assessmentIds);
    if (resolved.error) {
      return res.status(400).json({ status: 'failed', message: resolved.error, data: resolved.data });
    }

    const { requested, allAssessments, scoreRowsByStudent } = resolved;
    cascade = expandCascade(requested, allAssessments, scoreRowsByStudent);
    const warnings = countUngradedStudents(requested, allAssessments, scoreRowsByStudent);

    // ── Transaction: publish state only. No email inside. ──
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

      await client.query('COMMIT');
    } catch (txError) {
      await client.query('ROLLBACK');
      throw txError;
    } finally {
      client.release();
    }

    committedScoreRows = scoreRowsByStudent;
  } catch (error) {
    logger.error('Error publishing assessments:', error);
    return res.status(500).json({ status: 'failed', message: 'Error publishing assessments' });
  }

  // ── Everything below runs AFTER the commit, so nothing here may turn a
  // durable publish into a 500. A transient DB hiccup while working out who
  // to email must not tell the teacher the publish failed — the assessments
  // are already live, and they'd re-publish and double-notify the class.
  try {
    // Parents must see the change immediately, so drop the cached matrices
    // (both the full and published-only variants) for this school.
    engine.invalidateCache(school);

    // Re-read assessments so the email picks up comments written above.
    const { rows: freshAssessments } = await db.query(
      publishQueries.selectAllAssessmentsInClass,
      [classId],
    );
    const tasks = buildEmailTasks(cascade.finalIds, freshAssessments, committedScoreRows);
    tasksWithEmails = await resolveRecipients(tasks);

    // New marks invalidate this week's AI summary for the affected students.
    await invalidateWeeklySummaries(tasks.map((t) => t.studentId));
  } catch (error) {
    logger.error('Publish committed, but preparing notifications failed:', error);
    return res.status(201).json({
      status: 'success',
      data: {
        batchId,
        classId,
        publishedAssessmentIds: cascade.finalIds,
        cascadedChildIds: cascade.cascadedChildIds,
        skippedUngradedChildIds: cascade.skippedUngradedChildIds,
        emailSummary: {
          attempted: 0,
          sent: 0,
          failed: 0,
          skippedNoEmail: 0,
          results: [],
          notificationError:
            'Grades were published, but notifications could not be prepared. Publish again to notify parents.',
        },
      },
    });
  }

  // ── Post-commit email fan-out. Failures here are reported, never fatal. ──
  const emailSummary = await sendPublishEmails({
    tasks: tasksWithEmails,
    batchId,
    classId,
    school,
    userId,
    batchComment,
  });

  return res.status(201).json({
    status: 'success',
    data: {
      batchId,
      classId,
      publishedAssessmentIds: cascade.finalIds,
      cascadedChildIds: cascade.cascadedChildIds,
      skippedUngradedChildIds: cascade.skippedUngradedChildIds,
      emailSummary,
    },
  });
};

/**
 * Send one digest per (guardian set, child), sequentially, respecting
 * Resend's rate limit. Every send is wrapped individually and logged to
 * assessment_publication_emails; nothing in here can throw out to the
 * request handler, because the publish is already committed.
 *
 * A guardian with two children in this class receives two emails, one per
 * child — no cross-child data ever shares a template render.
 */
async function sendPublishEmails({ tasks, batchId, classId, school, userId, batchComment }) {
  const summary = { attempted: 0, sent: 0, failed: 0, skippedNoEmail: 0, results: [] };
  if (!tasks || tasks.length === 0) return summary;

  let className = 'your child\'s class';
  let schoolInfo = null;
  try {
    const [{ rows: classRows }, { rows: schoolRows }] = await Promise.all([
      db.query(classQueries.selectClassById, [classId]),
      db.query(schoolQueries.selectSchoolByCode, [school]),
    ]);
    if (classRows.length > 0) {
      className = classRows[0].subject || className;
    }
    if (schoolRows.length > 0) schoolInfo = schoolRows[0];
  } catch (lookupError) {
    logger.warn('Could not resolve class/school info for publish email:', lookupError);
  }

  const schoolName = getSchoolName(school);
  const schoolDomain = getSchoolDomain(school);
  const resend = new Resend(getSchoolApiKey(school));
  const portalUrl = `${process.env.FRONTEND_URL}/parent/grades`;

  const logEmail = async (task, status, errorMessage) => {
    try {
      await db.query(publishQueries.insertPublicationEmail, [
        batchId,
        task.studentId,
        userId,
        JSON.stringify(task.emails),
        task.gradedAssessmentIds,
        school,
        status,
        errorMessage || null,
      ]);
    } catch (logError) {
      logger.error('Failed to write publication email audit row:', logError);
    }
  };

  for (const [index, task] of tasks.entries()) {
    summary.attempted += 1;

    if (task.emails.length === 0) {
      summary.skippedNoEmail += 1;
      summary.results.push({
        studentId: task.studentId,
        studentName: task.studentName,
        status: 'skipped',
        reason: 'No guardian email on file',
      });
      await logEmail(task, 'skipped', 'No guardian email on file');
      continue;
    }

    try {
      const result = await resend.emails.send({
        from: `reports@${schoolDomain}`,
        to: task.emails,
        subject: `${task.studentName} — New Grades Posted (${className})`,
        html: getAssessmentPublishedEmailHTML({
          studentName: task.studentName,
          className,
          assessments: task.lines,
          batchComment: batchComment || null,
          schoolName,
          schoolInfo,
          portalUrl,
        }),
      });

      if (result.error) {
        throw new Error(result.error.message || 'Email sending failed');
      }

      summary.sent += 1;
      summary.results.push({
        studentId: task.studentId,
        studentName: task.studentName,
        status: 'sent',
        sentTo: task.emails,
      });
      await logEmail(task, 'sent', null);
    } catch (sendError) {
      logger.error(`Failed to send publish email for ${task.studentName}:`, sendError);
      summary.failed += 1;
      summary.results.push({
        studentId: task.studentId,
        studentName: task.studentName,
        status: 'failed',
        error: sendError.message,
      });
      await logEmail(task, 'failed', sendError.message);
    }

    if (index < tasks.length - 1) await sleep(EMAIL_RATE_LIMIT_MS);
  }

  return summary;
}

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

    return res.status(200).json({
      status: 'success',
      data: rows.map((r) => ({
        batchId: r.batch_id,
        action: r.action,
        batchComment: r.batch_comment,
        studentWarningCount: r.student_warning_count,
        createdAt: r.created_at,
        triggeredBy: r.triggered_by
          ? { userId: r.triggered_by, name: r.triggered_by_name || null }
          : null,
        assessments: r.assessments || [],
        emailSummary: {
          sent: Number(r.emails_sent),
          failed: Number(r.emails_failed),
          skipped: Number(r.emails_skipped),
        },
      })),
    });
  } catch (error) {
    logger.error('Error fetching publication history:', error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching history' });
  }
};

module.exports = {
  getPublicationState,
  previewPublish,
  publishAssessments,
  unpublishAssessments,
  updateAssessmentComment,
  getPublicationHistory,
  // exported for unit testing
  expandCascade,
  countUngradedStudents,
  buildEmailTasks,
};
