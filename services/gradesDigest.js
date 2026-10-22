// services/gradesDigest.js
//
// The parents' "New Grades Posted" email: which students a publish reports,
// what each email says, and its buttons (a one-tap sign-in for a linked
// parent, "Create your account" for an address with no account).
//
// A publish queues it (enqueueGradeDigest) inside the publish transaction:
// one email_outbox row per guardian address, sent by the notifier's tick
// after a short hold (services/email/outbox.js). The email is built when it
// is sent (gradesDigestHandler), from the committed gradebook: only columns
// still published, the address's other publishes of the class in the hold
// merged into one email, the guardian addresses as they are then.
//
// All grade math routes through gradeEngine.computeAssessmentForStudent,
// the same helper the parent portal and report cards use. Never re-derive
// weighting here.

const db = require('../config/database');
const logger = require('../logger');
const publishQueries = require('../queries/assessmentPublish.queries');
const schoolQueries = require('../queries/school.queries');
const { getAssessmentPublishedEmailHTML } = require('../templates/emailTemplate');
const { parentAskPath, speakLabel } = require('../utils/parentLinks');
const { signEmailLoginToken, emailLoginUrl } = require('../utils/emailLoginLink');
const { cleanEmailArray } = require('../utils/emailUtils');
const { schoolSender } = require('./email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const outbox = require('./email/outbox');
const outboxQueries = require('../queries/emailOutbox.queries');
const {
  computeAssessmentForStudent,
  buildScoreLookup,
  computeClassGrade,
  formatCoverage,
} = require('./gradeEngine');

const KIND = 'grades_digest';
const SUBJECT_TYPE = 'publish_batch';
// How long a queued email waits: time to undo a publish, and for a teacher
// publishing column after column to send one email per family.
const HOLD_SECONDS = 120;
// Teacher-facing: ahead of digests nobody is waiting on.
const PRIORITY = 3;
const NO_EMAIL = 'No guardian email on file';
const SKIP = {
  UNPUBLISHED: 'Unpublished before it was sent',
  NOT_GUARDIAN: 'No longer a guardian address',
  LEFT_CLASS: 'No longer in the class',
  NOTHING: 'Nothing graded to report',
};

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
 * One released column's row in the email: its own score, labelled with its
 * category (`group`) when it sits inside one. `assessmentId` lets the sender
 * link the row to a conversation about it.
 */
function formatAssessmentLine(assessment, result, { group = null, comment = assessment.parent_comment || null } = {}) {
  const isMissing = result.state === 'missing';
  return {
    assessmentId: assessment.assessment_id,
    name: assessment.name,
    group,
    scoreLabel: isMissing ? 'Missing' : `${result.earned}/${result.max}`,
    pctLabel: `${Math.round(result.pct * 10) / 10}%`,
    isMissing,
    comment,
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

/**
 * One email task per student who has at least one graded (or missing) column
 * among those this publish releases. A student with nothing graded gets no
 * email at all — an empty digest tells a parent nothing.
 *
 * `publishedIds` are top-level lines: a standalone column, or a category.
 * Each column released under a line is its own row with its own score: the
 * line itself when standalone; for a category, its children released now
 * (published with it, in `publishing`, or on their own, in `alsoListed`), never
 * an older sibling. A category's running average is not shown — parents asked
 * what the new work scored. The audit ids stay per line, as before.
 */
function buildEmailTasks(publishedIds, allAssessments, scoreRowsByStudent, { alsoListed = new Map(), publishing = [] } = {}) {
  const publishedSet = new Set(publishedIds);
  const topLevelPublished = allAssessments.filter(
    (a) => publishedSet.has(a.assessment_id) && !a.parent_assessment_id,
  );
  const listedUnder = (line) => alsoListed.get(line.assessment_id) || [];

  // Every assessment the parent can see after this publish, including
  // earlier batches, so the running grade in the email matches the portal.
  // `publishing` and `alsoListed` name columns this publish releases that
  // aren't lines themselves (children, before commit).
  const releasing = new Set([...publishedSet, ...publishing, ...[...alsoListed.values()].flat()]);
  const allPublishedIds = new Set(
    allAssessments.filter((a) => a.is_published || releasing.has(a.assessment_id)).map((a) => a.assessment_id),
  );
  const parentVisible = visibleAssessments(allPublishedIds, allAssessments);

  const columnsOf = (line) => (line.is_parent
    ? allAssessments.filter((c) => c.parent_assessment_id === line.assessment_id && !c.is_parent && releasing.has(c.assessment_id))
    : [line]);

  const tasks = [];
  for (const student of scoreRowsByStudent.values()) {
    const lookup = buildScoreLookup(student.rows);
    const lines = [];
    const gradedIds = [];

    for (const line of topLevelPublished) {
      // A category published itself has no alsoListed entry (publishDigestTasks);
      // the note the teacher left on it opens its first row.
      let categoryNote = line.is_parent && !listedUnder(line).length ? line.parent_comment || null : null;
      let listed = false;
      for (const column of columnsOf(line)) {
        const result = computeAssessmentForStudent(column, allAssessments, lookup);
        if (!result.isCounted) continue;
        const comment = [categoryNote, column.parent_comment].filter(Boolean).join('\n') || null;
        lines.push(formatAssessmentLine(column, result, { group: line.is_parent ? line.name : null, comment }));
        categoryNote = null;
        listed = true;
      }
      if (!listed) continue;
      gradedIds.push(line.assessment_id);
      // The audit row also names the columns under that line this publish released.
      for (const extra of listedUnder(line)) gradedIds.push(extra);
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

/**
 * Attach guardian email addresses to each email task. `queryable` is a
 * transaction's client when the publish queues its emails.
 */
async function resolveRecipients(tasks, queryable = db) {
  if (tasks.length === 0) return [];

  const { rows } = await queryable.query(publishQueries.selectGuardianEmailsByStudent, [
    tasks.map((t) => t.studentId),
  ]);
  const emailsByStudent = new Map(rows.map((r) => [r.student_id, r.guardian_emails || []]));

  return tasks.map((task) => ({
    ...task,
    emails: [...new Set(cleanEmailArray(emailsByStudent.get(task.studentId) || []))],
  }));
}

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
 * the preview email) of `finalIds`, the cascade's result. Every column it
 * releases is a row with its own score, grouped through its top-level line:
 * a column inside a category published on its own (the category window's
 * "Publish 1 selected") is listed under that category's name, and the
 * running grade counts what parents will see (published columns plus the
 * ones being published now).
 */
function publishDigestTasks(finalIds, allAssessments, scoreRowsByStudent) {
  const { lineIds, alsoListed } = topLevelLines(finalIds, allAssessments);
  // A category published itself is named alone in the audit row, as before
  // (the 4 pm Missing alert reads it); only a child published without its
  // category is named under the category's line, as Classwork's digest does.
  const selected = new Set(finalIds);
  for (const lineId of [...alsoListed.keys()]) if (selected.has(lineId)) alsoListed.delete(lineId);
  return buildEmailTasks(lineIds, allAssessments, scoreRowsByStudent, { alsoListed, publishing: finalIds });
}

/**
 * Class subject, school letterhead and the "Ask <teacher> about this" label
 * for the email; soft-fails to generic copy and no ask links. `askable` is
 * false for a class parents may not start a conversation about (past term).
 */
async function loadEmailContext(classId, school) {
  let className = 'your child\'s class';
  let schoolInfo = null;
  let teacherName = null;
  let askable = false;
  try {
    const [{ rows: classRows }, { rows: schoolRows }] = await Promise.all([
      db.query(publishQueries.selectEmailClassContext, [classId]),
      db.query(schoolQueries.selectSchoolByCode, [school]),
    ]);
    if (classRows.length > 0) {
      className = classRows[0].subject || className;
      teacherName = classRows[0].teacher_name;
      askable = Boolean(classRows[0].askable);
    }
    if (schoolRows.length > 0) schoolInfo = schoolRows[0];
  } catch (lookupError) {
    logger.warn('Could not resolve class/school info for publish email:', lookupError);
  }
  return { className, schoolInfo, teacherName, askable };
}

/**
 * The email's "Speak to <teacher> about this" button, beside View in Parent
 * Portal, when the class allows it: { label, path }. It opens a new message
 * about the first row's item; the parent can pick another item of the class
 * in the window.
 */
function speakButton(task, classId, { teacherName, askable }) {
  const [first] = task.lines;
  if (!askable || !first) return null;
  return {
    label: speakLabel(teacherName, task.lines.length),
    path: parentAskPath({ studentId: task.studentId, classId, assessmentId: first.assessmentId, about: first.name }),
  };
}

const PORTAL_PATH = '/parent/grades';
const portalOrigin = () => process.env.FRONTEND_URL || '';

/**
 * How one guardian address opens the portal from its email:
 * - signIn: a parent account linked to the child. Its buttons sign that parent
 *   in on one tap (utils/emailLoginLink).
 * - signup: no account at all. "Create your account" with the address filled
 *   in (signup matches the children by email); "Speak to …" goes there too,
 *   since messaging needs an account.
 * - plain: anything else (a staff account, an archived or unlinked parent, two
 *   accounts differing only by case). The buttons ask for a normal sign-in.
 * `accounts` are selectRecipientAccounts rows.
 */
function recipientAccess(address, accounts) {
  const mine = accounts.filter((a) => a.email === address);
  if (mine.length === 0) return { kind: 'signup' };
  const [account] = mine;
  if (mine.length === 1 && account.role === 'PARENT' && account.linked && !account.is_archived) {
    return { kind: 'signIn', userId: account.user_id };
  }
  return { kind: 'plain' };
}

/** The template's buttons for one address: { portalUrl, speak } or { setupUrl, speak }. */
function recipientButtons({ access, address, studentId, school, speak }) {
  if (access.kind === 'signup') {
    const setupUrl = `${portalOrigin()}/signup/${String(school).toLowerCase()}/parent?email=${encodeURIComponent(address)}`;
    return { setupUrl, speak: speak && { label: speak.label, url: setupUrl } };
  }
  const link = access.kind === 'signIn'
    ? ((path) => emailLoginUrl({ token: signEmailLoginToken({ userId: access.userId, studentId, email: address }), next: path }))
    : ((path) => `${portalOrigin()}${path}`);
  return { portalUrl: link(PORTAL_PATH), speak: speak && { label: speak.label, url: link(speak.path) } };
}

/** Each address of a task with its access; an address lookup failure falls back to plain links. */
async function recipientsOf(task) {
  const addresses = task.emails.map((e) => String(e).trim().toLowerCase());
  try {
    const { rows } = await db.query(publishQueries.selectRecipientAccounts, [addresses, task.studentId]);
    return addresses.map((address) => ({ address, access: recipientAccess(address, rows) }));
  } catch (error) {
    logger.warn('Could not look up accounts for the publish email; sending plain links:', error);
    return addresses.map((address) => ({ address, access: { kind: 'plain' } }));
  }
}

// ────────────────────────────────────────────────────────────────────
// The queue
// ────────────────────────────────────────────────────────────────────

/**
 * Queue the "New Grades Posted" email of one publish, inside its transaction
 * (`client`) and after the publish's writes: one row per guardian address of
 * each student with something graded among `assessmentIds` (`studentIds`
 * narrows it: a Classwork publish emails only the students it published). A
 * student with no address on file gets one skipped row, so the delivery list
 * can say so. Reads the transaction's own writes, so the figures are what the
 * publish commits. Throws: the publish must not commit without its email.
 * @returns {Promise<{ families: number, noEmail: number, students: { studentId, studentName, hasEmail }[] }>}
 */
async function enqueueGradeDigest(client, { classId, school, userId = null, batchId, assessmentIds, studentIds = null }) {
  const none = { families: 0, noEmail: 0, students: [] };
  if (!batchId || !assessmentIds || assessmentIds.length === 0) return none;
  if (Array.isArray(studentIds) && studentIds.length === 0) return none;
  const { rows: assessments } = await client.query(publishQueries.selectAllAssessmentsInClass, [classId]);
  const { rows: scoreRows } = await client.query(publishQueries.selectClassScoreRows, [classId]);
  const wanted = Array.isArray(studentIds) ? new Set(studentIds.map((id) => String(id).toLowerCase())) : null;
  const byStudent = groupScoreRowsByStudent(wanted ? scoreRows.filter((r) => wanted.has(r.student_id)) : scoreRows);
  const tasks = await resolveRecipients(publishDigestTasks(assessmentIds, assessments, byStudent), client);

  const base = (task) => ({
    kind: KIND,
    school,
    subjectType: SUBJECT_TYPE,
    subjectId: batchId,
    classId,
    studentId: task.studentId,
    dedupeKey: `${batchId}:${task.studentId}`,
    coalesceKey: `${task.studentId}:${classId}`,
    payload: { assessmentIds },
    priority: PRIORITY,
    delaySeconds: HOLD_SECONDS,
    createdBy: userId,
  });
  const rows = tasks.flatMap((task) => (task.emails.length === 0
    ? [{ ...base(task), recipientEmail: null, status: 'skipped', skipReason: NO_EMAIL }]
    : [...new Set(task.emails.map((e) => e.toLowerCase()))].map((email) => ({ ...base(task), recipientEmail: email }))));
  await outbox.enqueue(client, rows);
  return {
    families: tasks.filter((t) => t.emails.length > 0).length,
    noEmail: tasks.filter((t) => t.emails.length === 0).length,
    students: tasks.map((t) => ({ studentId: t.studentId, studentName: t.studentName, hasEmail: t.emails.length > 0 })),
  };
}

/** The publishes' notes to all parents, oldest first, each once. */
function batchNote(batches) {
  const notes = [...new Set(batches.map((b) => (b.batch_comment || '').trim()).filter(Boolean))];
  return notes.length ? notes.join('\n\n') : null;
}

/**
 * Builds one queued email at send time (services/email/outbox.js). `siblings`
 * are the address's other queued publishes of this child in this class: one
 * email covers them all, listing every column still published.
 */
const gradesDigestHandler = {
  async build(job, siblings = []) {
    const jobs = [job, ...siblings];
    const { class_id: classId, student_id: studentId, recipient_email: address, school } = job;
    const ids = [...new Set(jobs.flatMap((j) => j.payload?.assessmentIds || []))];
    const batchIds = [...new Set(jobs.map((j) => j.subject_id).filter(Boolean))];
    const [{ rows: assessments }, { rows: scoreRows }, { rows: batches }, { rows: guardians }] = await Promise.all([
      db.query(publishQueries.selectAllAssessmentsInClass, [classId]),
      db.query(publishQueries.selectClassScoreRows, [classId]),
      db.query(publishQueries.selectBatchNotes, [batchIds]),
      db.query(publishQueries.selectGuardianEmailsByStudent, [[studentId]]),
    ]);
    const published = new Set(assessments.filter((a) => a.is_published).map((a) => a.assessment_id));
    const live = ids.filter((id) => published.has(id));
    if (live.length === 0) return { skip: SKIP.UNPUBLISHED };
    const onFile = new Set(cleanEmailArray(guardians[0]?.guardian_emails || []).map((e) => e.toLowerCase()));
    if (!onFile.has(String(address).toLowerCase())) return { skip: SKIP.NOT_GUARDIAN };
    const byStudent = groupScoreRowsByStudent(scoreRows.filter((r) => r.student_id === studentId));
    if (byStudent.size === 0) return { skip: SKIP.LEFT_CLASS };
    const [task] = publishDigestTasks(live, assessments, byStudent);
    if (!task) return { skip: SKIP.NOTHING };

    const context = await loadEmailContext(classId, school);
    const [{ access }] = await recipientsOf({ ...task, emails: [address] });
    const speak = speakButton(task, classId, context);
    const subject = `${task.studentName} — New Grades Posted (${context.className})`;
    return {
      message: {
        ...schoolSender({ school, schoolInfo: context.schoolInfo, role: 'academics' }),
        to: [address],
        subject,
        html: getAssessmentPublishedEmailHTML({
          studentName: task.studentName,
          className: context.className,
          assessments: task.lines,
          runningGradeLabel: task.runningGradeLabel,
          batchComment: batchNote(batches),
          schoolName: getSchoolName(school),
          schoolInfo: context.schoolInfo,
          ...recipientButtons({ access, address, studentId, school, speak }),
        }),
      },
      sentContent: {
        subject,
        lines: task.lines.map((l) => ({ name: l.name, group: l.group, score: l.scoreLabel, pct: l.pctLabel })),
        runningGrade: task.runningGradeLabel,
        batchIds,
      },
      // The per-send log the 4 pm missing alert reads (a family already told
      // about a column is not alerted about it), one row per publish covered.
      afterSend: async () => {
        for (const j of jobs) {
          await db.query(publishQueries.insertPublicationEmail, [
            j.subject_id, studentId, j.created_by, JSON.stringify([address]), task.gradedAssessmentIds, school, 'sent', null,
          ]);
        }
      },
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// Delivery: what the publish window and the history show
// ────────────────────────────────────────────────────────────────────

/** A student's state across their addresses: any queued → pending; any failed → failed; any sent → sent. */
function studentStatus(recipients) {
  const states = new Set(recipients.map((r) => r.status));
  if (states.has('pending')) return 'pending';
  if (states.has('failed')) return 'failed';
  if (states.has('sent')) return 'sent';
  return 'skipped';
}

/**
 * One publish's outbox rows per student: { counts, students }. A student
 * counts once (under studentStatus); `recipients` say what happened to each
 * address.
 */
function summarizeDelivery(rows) {
  const byStudent = new Map();
  for (const r of rows) {
    let entry = byStudent.get(r.student_id);
    if (!entry) {
      entry = { studentId: r.student_id, studentName: r.student_name || null, recipients: [], reason: null };
      byStudent.set(r.student_id, entry);
    }
    if (!r.recipient_email) {
      entry.reason = r.skip_reason || NO_EMAIL;
      continue;
    }
    entry.recipients.push({
      email: r.recipient_email,
      status: r.status,
      error: r.status === 'failed' ? r.last_error || 'Email failed' : null,
      reason: r.status === 'skipped' ? r.skip_reason : null,
      sentAt: r.status === 'sent' ? r.finished_at : null,
    });
  }
  const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  const students = [...byStudent.values()].map((s) => {
    const status = studentStatus(s.recipients);
    counts[status] += 1;
    const reason = status === 'skipped' ? s.reason || s.recipients.find((r) => r.reason)?.reason || null : null;
    return { studentId: s.studentId, studentName: s.studentName, status, reason, recipients: s.recipients };
  });
  return { counts, students };
}

/** One publish's delivery. */
async function batchDelivery(batchId, queryable = db) {
  const { rows } = await queryable.query(outboxQueries.selectBySubject, [SUBJECT_TYPE, batchId]);
  return summarizeDelivery(rows);
}

/**
 * Sends a publish's failed emails again: a failed address still on file goes
 * back to the queue, due now and with a new idempotency key; one no longer on
 * file is skipped; an address added since, for a student whose email failed
 * or who had none, is queued. In one transaction.
 * @returns {Promise<{ requeued: number, added: number, dropped: number }>}
 */
async function retryBatch({ batchId, classId, school, userId = null }) {
  const { rows } = await db.query(outboxQueries.selectBySubject, [SUBJECT_TYPE, batchId]);
  const failed = rows.filter((r) => r.status === 'failed');
  const noEmail = rows.filter((r) => r.status === 'skipped' && !r.recipient_email);
  const studentIds = [...new Set([...failed, ...noEmail].map((r) => r.student_id))];
  if (studentIds.length === 0) return { requeued: 0, added: 0, dropped: 0 };

  const { rows: guardians } = await db.query(publishQueries.selectGuardianEmailsByStudent, [studentIds]);
  const onFile = new Map(guardians.map((g) => [
    g.student_id, [...new Set(cleanEmailArray(g.guardian_emails || []).map((e) => e.toLowerCase()))],
  ]));
  const keep = failed.filter((r) => (onFile.get(r.student_id) || []).includes(r.recipient_email));
  const dropped = failed.filter((r) => !keep.includes(r));
  const known = new Set(rows.filter((r) => r.recipient_email).map((r) => `${r.student_id}:${r.recipient_email}`));
  const assessmentIds = rows.find((r) => r.payload?.assessmentIds)?.payload.assessmentIds || [];
  const added = assessmentIds.length === 0 ? [] : studentIds.flatMap((studentId) => (onFile.get(studentId) || [])
    .filter((email) => !known.has(`${studentId}:${email}`))
    .map((email) => ({
      kind: KIND,
      school,
      recipientEmail: email,
      subjectType: SUBJECT_TYPE,
      subjectId: batchId,
      classId,
      studentId,
      dedupeKey: `${batchId}:${studentId}`,
      coalesceKey: `${studentId}:${classId}`,
      payload: { assessmentIds },
      priority: PRIORITY,
      createdBy: userId,
    })));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: requeued } = keep.length
      ? await client.query(outboxQueries.requeueFailed, [SUBJECT_TYPE, batchId, keep.map((r) => r.id)])
      : { rows: [] };
    if (dropped.length) await client.query(outboxQueries.finishSkipped, [dropped.map((r) => r.id), SKIP.NOT_GUARDIAN]);
    const addedCount = await outbox.enqueue(client, added);
    await client.query('COMMIT');
    return { requeued: requeued.length, added: addedCount, dropped: dropped.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * After an unpublish, inside its transaction: queued emails of this class
 * whose columns are all unpublished now are never sent.
 * @returns {Promise<number>} the emails cancelled
 */
async function cancelUnpublished(client, classId) {
  const { rows } = await client.query(publishQueries.skipUnpublishedDigests, [classId, SKIP.UNPUBLISHED]);
  return rows.length;
}

module.exports = {
  KIND,
  SUBJECT_TYPE,
  HOLD_SECONDS,
  NO_EMAIL,
  SKIP,
  groupScoreRowsByStudent,
  formatAssessmentLine,
  visibleAssessments,
  buildEmailTasks,
  resolveRecipients,
  topLevelLines,
  publishDigestTasks,
  loadEmailContext,
  speakButton,
  recipientAccess,
  recipientButtons,
  recipientsOf,
  portalOrigin,
  enqueueGradeDigest,
  gradesDigestHandler,
  summarizeDelivery,
  batchDelivery,
  retryBatch,
  cancelUnpublished,
};
