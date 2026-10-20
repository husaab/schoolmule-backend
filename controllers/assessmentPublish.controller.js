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


const db = require('../config/database');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const publishQueries = require('../queries/assessmentPublish.queries');
const classQueries = require('../queries/class.queries');
const schoolQueries = require('../queries/school.queries');
const { getAssessmentPublishedEmailHTML } = require('../templates/emailTemplate');
const { cleanEmailArray, getResend, sendOrThrow } = require('../utils/emailUtils');
const { schoolSender } = require('../services/email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const {
  computeAssessmentForStudent,
  buildScoreLookup,
  computeClassGrade,
  formatCoverage,
  cellState,
} = require('../services/gradeEngine');
const { invalidateWeeklySummaries } = require('../services/aiWeeklySummary.service');
const gradingQueries = require('../queries/grading.queries');
const { publishSubmissions, afterPublish } = require('../services/classroom/publish');
const { enqueueGraded } = require('../services/classroom/classroomNotifier');

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

/** Format one assessment's result for the email table. */
function formatAssessmentLine(assessment, result) {
  const pct = Math.round(result.pct * 10) / 10;
  const isMissing = result.state === 'missing';
  return {
    name: assessment.name,
    // A category has no raw score — only a weighted rollup of its children.
    scoreLabel: isMissing
      ? 'Missing'
      : result.earned != null && result.max != null ? `${result.earned}/${result.max}` : '',
    pctLabel: `(${pct}%)`,
    comment: assessment.parent_comment || null,
  };
}

/**
 * The assessments a parent can see once `publishedIds` are published:
 * published ones plus any category with a published child (same structural
 * rule as analyticsEngine.prunePublishedOnly).
 */
function visibleAssessments(publishedSet, allAssessments) {
  const visible = new Set(publishedSet);
  for (const a of allAssessments) {
    if (!a.is_parent) continue;
    if (allAssessments.some((c) => c.parent_assessment_id === a.assessment_id && publishedSet.has(c.assessment_id))) {
      visible.add(a.assessment_id);
    }
  }
  return allAssessments.filter((a) => visible.has(a.assessment_id));
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

/**
 * One email task per student who has at least one graded assessment among
 * the published set. A student with nothing graded gets no email at all —
 * an empty digest tells a parent nothing.
 *
 * Only top-level assessments appear in the email body: a cascaded child is
 * already represented by its category's rollup, and listing both would
 * double-report the same work.
 */
function buildEmailTasks(publishedIds, allAssessments, scoreRowsByStudent, { visibleLines = false, alsoListed = null, publishing = [] } = {}) {
  const publishedSet = new Set(publishedIds);
  const topLevelPublished = allAssessments.filter(
    (a) => publishedSet.has(a.assessment_id) && !a.parent_assessment_id,
  );

  // Every assessment the parent can see after this publish, including
  // earlier batches, so the running grade in the email matches the portal.
  // `publishing` names columns this publish releases that aren't lines
  // themselves (a child listed through its category's line, before commit).
  const releasing = new Set([...publishedSet, ...publishing]);
  const allPublishedIds = new Set(
    allAssessments.filter((a) => a.is_published || releasing.has(a.assessment_id)).map((a) => a.assessment_id),
  );
  const parentVisible = visibleAssessments(allPublishedIds, allAssessments);
  // A Classwork publish of one column under a category (sendGradeDigest)
  // lists the category's line from what parents can see: a sibling column
  // that isn't published never enters it. (The gradebook's own Publish
  // publishes the category's graded children with it, so there the two
  // lists agree.)
  const lineAssessments = visibleLines ? parentVisible : allAssessments;

  const tasks = [];
  for (const student of scoreRowsByStudent.values()) {
    const lookup = buildScoreLookup(student.rows);
    const lines = [];
    const gradedIds = [];

    for (const assessment of topLevelPublished) {
      const result = computeAssessmentForStudent(assessment, lineAssessments, lookup);
      if (!result.isCounted) continue;
      lines.push(formatAssessmentLine(assessment, result));
      gradedIds.push(assessment.assessment_id);
      // The audit row also names the columns under that line this publish released.
      for (const extra of (alsoListed && alsoListed.get(assessment.assessment_id)) || []) gradedIds.push(extra);
    }

    if (lines.length === 0) continue;
    const running = computeClassGrade(parentVisible, student.rows);
    tasks.push({
      studentId: student.studentId,
      studentName: student.studentName,
      lines,
      gradedAssessmentIds: gradedIds,
      runningGradeLabel:
        running.pct == null
          ? null
          : `${Math.round(running.pct * 10) / 10}% · based on ${formatCoverage(running.coverage)}`,
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
  // Turn-in columns in the batch: their drafts are published in the same
  // transaction (spec D3), so "Publish" means the same here and in Classwork.
  const classworkPublished = [];
  const classworkStudents = new Map();
  // A held student's old cell went back to a draft (post-Fable m1).
  let heldAny = false;

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
          heldAny = true;
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
    // Classwork drafts were copied under lock inside the transaction: the
    // email reads the committed gradebook, so it says exactly what was
    // published (a draft edited meanwhile is never emailed unpublished).
    if (classworkStudents.size > 0 || heldAny) {
      const { rows: committedRows } = await db.query(publishQueries.selectClassScoreRows, [classId]);
      committedScoreRows = groupScoreRowsByStudent(committedRows);
    }
    const tasks = publishDigestTasks(cascade.finalIds, freshAssessments, committedScoreRows);
    tasksWithEmails = await resolveRecipients(tasks);

    // New marks invalidate this week's AI summary for the affected students.
    await invalidateWeeklySummaries(tasks.map((t) => t.studentId));
    for (const [itemId, studentIds] of classworkStudents) {
      await afterPublish({ school, studentIds, itemId });
    }
    // Students get their "graded" email for every column published here
    // (spec D6), bundled with the Classwork ones above into one per student
    // per 15 minutes. Parents' digest below is unchanged. Never throws.
    await enqueueGraded({ school, assessmentIds: cascade.finalIds });
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
        classworkPublished,
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
      classworkPublished,
      emailSummary,
    },
  });
};

/**
 * Each assessment's top-level line: itself, or the category it sits under
 * (walking up). Returns the line ids and, per line, the columns under it
 * that were asked for (named in the email's audit row too).
 */
function topLevelLines(assessmentIds, allAssessments) {
  const byId = new Map(allAssessments.map((a) => [a.assessment_id, a]));
  const lineIds = [];
  const alsoListed = new Map();
  for (const id of assessmentIds) {
    let a = byId.get(id);
    const seen = new Set();
    while (a && a.parent_assessment_id && !seen.has(a.assessment_id)) {
      seen.add(a.assessment_id);
      a = byId.get(a.parent_assessment_id);
    }
    if (!a) continue;
    if (!lineIds.includes(a.assessment_id)) lineIds.push(a.assessment_id);
    if (a.assessment_id !== id) alsoListed.set(a.assessment_id, [...(alsoListed.get(a.assessment_id) || []), id]);
  }
  return { lineIds, alsoListed };
}

/**
 * The parent digest for the gradebook's Publish (its preview, the send and
 * the preview email) of `finalIds`, the cascade's result. Each column is
 * listed through its top-level line, so a column inside a category published
 * on its own (the category window's "Publish 1 selected") is emailed as its
 * category's line, built from what parents will see: published columns plus
 * the ones being published now. A category published with its children, or
 * a column on its own, reads exactly as before.
 */
function publishDigestTasks(finalIds, allAssessments, scoreRowsByStudent) {
  const { lineIds, alsoListed } = topLevelLines(finalIds, allAssessments);
  // A category published itself is named alone in the audit row, as before
  // (the 4 pm Missing alert reads it); only a child published without its
  // category is named under the category's line, as Classwork's digest does.
  const selected = new Set(finalIds);
  for (const lineId of [...alsoListed.keys()]) if (selected.has(lineId)) alsoListed.delete(lineId);
  return buildEmailTasks(lineIds, allAssessments, scoreRowsByStudent, { visibleLines: true, alsoListed, publishing: finalIds });
}

/**
 * Today's publish digest for a publish made from Classwork (the grading
 * view's Publish, Mark missing, Excuse, a quiz released on submit): the same
 * email the gradebook's Publish sends, for `assessmentIds` (a column under a
 * category is listed as its category's line, as main's digest does), to the
 * guardians of `studentIds` only. Built from the committed gradebook, so
 * another student's draft never enters it. After COMMIT; never throws.
 */
async function sendGradeDigest({ classId, school, userId, batchId, assessmentIds, studentIds }) {
  const none = { attempted: 0, sent: 0, failed: 0, skippedNoEmail: 0, results: [] };
  if (!batchId || !studentIds || studentIds.length === 0) return none;
  try {
    const wanted = new Set(studentIds);
    const [{ rows: freshAssessments }, { rows: scoreRows }] = await Promise.all([
      db.query(publishQueries.selectAllAssessmentsInClass, [classId]),
      db.query(publishQueries.selectClassScoreRows, [classId]),
    ]);
    const byStudent = groupScoreRowsByStudent(scoreRows.filter((r) => wanted.has(r.student_id)));
    // The email lists top-level assessments only (main's digest): a column
    // under a category is reported through its category's line (S2).
    const { lineIds, alsoListed } = topLevelLines(assessmentIds, freshAssessments);
    const tasks = await resolveRecipients(
      buildEmailTasks(lineIds, freshAssessments, byStudent, { visibleLines: true, alsoListed }),
    );
    return await sendPublishEmails({ tasks, batchId, classId, school, userId, batchComment: null });
  } catch (error) {
    logger.error('Classwork publish committed, but the parent digest failed:', error);
    return { ...none, notificationError: 'Grades were published, but parents could not be emailed.' };
  }
}

/**
 * Send one digest per (guardian set, child), sequentially, respecting
 * Resend's rate limit. Every send is wrapped individually and logged to
 * assessment_publication_emails; nothing in here can throw out to the
 * request handler, because the publish is already committed.
 *
 * A guardian with two children in this class receives two emails, one per
 * child — no cross-child data ever shares a template render.
 */
/** Class subject and school letterhead for the email; soft-fails to generic copy. */
async function loadEmailContext(classId, school) {
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
  return { className, schoolInfo };
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

    const [recipients, { className, schoolInfo }] = await Promise.all([
      resolveRecipients(tasks),
      loadEmailContext(classId, school),
    ]);
    const sample = tasks[0];
    const trimmedBatchComment = typeof batchComment === 'string' && batchComment.trim() ? batchComment.trim() : null;

    await sendOrThrow(getResend(), {
      ...schoolSender({ school, schoolInfo, role: 'academics' }),
      to: [req.user.email],
      subject: `[Preview] ${sample.studentName} — New Grades Posted (${className})`,
      html: getAssessmentPublishedEmailHTML({
        studentName: sample.studentName,
        className,
        assessments: sample.lines,
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

async function sendPublishEmails({ tasks, batchId, classId, school, userId, batchComment }) {
  const summary = { attempted: 0, sent: 0, failed: 0, skippedNoEmail: 0, results: [] };
  if (!tasks || tasks.length === 0) return summary;

  const { className, schoolInfo } = await loadEmailContext(classId, school);
  const schoolName = getSchoolName(school);
  const sender = schoolSender({ school, schoolInfo, role: 'academics' });
  const resend = getResend();
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
        ...sender,
        to: task.emails,
        subject: `${task.studentName} — New Grades Posted (${className})`,
        html: getAssessmentPublishedEmailHTML({
          studentName: task.studentName,
          className,
          assessments: task.lines,
          runningGradeLabel: task.runningGradeLabel,
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
  previewPublishEmail,
  publishAssessments,
  unpublishAssessments,
  updateAssessmentComment,
  getPublicationHistory,
  sendGradeDigest,
  // exported for unit testing
  expandCascade,
  countUngradedStudents,
  buildEmailTasks,
  publishDigestTasks,
  topLevelLines,
  overlayDrafts,
  planPublish,
  // also used by scripts/backfillPublishDigests.js
  groupScoreRowsByStudent,
  resolveRecipients,
  loadEmailContext,
  EMAIL_RATE_LIMIT_MS,
};
