// services/reportEmails.js
//
// Report card and progress report emails through the email outbox. A send
// (one student or many) is a report_email_runs row; each of its emails is an
// outbox row (one per address), queued in one transaction and sent by the
// notifier at once (outbox.kick), the PDF attached. The page shows the send
// as it goes (runDelivery) and resends what failed (retryRun); closing it
// stops nothing, and a restart picks up where it left off.
//
// The email is built when it is sent, from the run, the student and the
// report as they are then: a regenerated PDF goes out, a parent address taken
// off the student since is skipped. Recipients are the student's mother and
// father emails, as before (a single send: the addresses the sender typed).

const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const q = require('../queries/reportEmailRuns.queries');
const outboxQueries = require('../queries/emailOutbox.queries');
const schoolQueries = require('../queries/school.queries');
const reportCardQueries = require('../queries/reportCard.queries');
const progressReportsQueries = require('../queries/progressReports.queries');
const { getProgressReportEmailHTML, getReportCardEmailHTML } = require('../templates/emailTemplate');
const { cleanEmailArray } = require('../utils/emailUtils');
const { getSchoolName } = require('../utils/schoolUtils');
const { schoolSender } = require('./email/senderIdentity');
const outbox = require('./email/outbox');

const KIND = 'report_email';
const SUBJECT_TYPE = 'report_email_run';
// Someone is watching the progress bar: ahead of the digests.
const PRIORITY = 2;

const REPORTS = {
  report_card: {
    label: 'Report Card',
    noun: 'report card',
    bucket: 'report-cards',
    files: q.selectReportCardFiles,
    html: getReportCardEmailHTML,
    markEmailed: reportCardQueries.updateReportCardEmailStatus,
  },
  progress_report: {
    label: 'Progress Report',
    noun: 'progress report',
    bucket: 'progress-reports',
    files: q.selectProgressReportFiles,
    html: getProgressReportEmailHTML,
    markEmailed: progressReportsQueries.updateProgressReportEmailStatus,
  },
};

const SKIP = {
  NO_REPORT: (spec, term) => `No ${spec.noun} for ${term}`,
  NO_EMAIL: 'No parent email on file',
  BUSY: 'Already being sent',
  NOT_PARENT: 'No longer a parent address',
  ARCHIVED: 'Student archived',
  GONE: 'Send removed',
};

const lower = (emails) => [...new Set(cleanEmailArray(emails).map((e) => e.toLowerCase()))];
const parentEmails = (student) => lower([student.mother_email, student.father_email]);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// ── Queueing a send ────────────────────────────────────────────────────────

/**
 * Queues one send: a run plus one outbox row per address, in one
 * transaction, then starts sending. A student with no report for the term,
 * no address, or an address already being sent gets a skipped row instead,
 * so the page lists why. The CC goes on each student's first email only.
 * `chosen`: the addresses typed for a one-student send (else the parents on
 * file).
 * @returns {Promise<{ runId, total, queued, skipped }>} students
 */
async function queueSend({ school, userId = null, reportType, term, studentIds, customHeader = null, customMessage = null, ccAddresses = [], chosen = null }) {
  const spec = REPORTS[reportType];
  if (!spec) throw httpError(400, 'Invalid report type. Must be "progress_report" or "report_card"');
  const ids = [...new Set((studentIds || []).map((id) => String(id).toLowerCase()))];
  const { rows: students } = await db.query(q.selectStudents, [ids, school]);
  if (students.length === 0) throw httpError(404, 'No students found with provided IDs');

  const { rows: files } = await db.query(spec.files, [students.map((s) => s.student_id), term, school]);
  const hasReport = new Set(files.filter((f) => f.file_path).map((f) => f.student_id));
  const cc = lower(ccAddresses);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Another send of this report and term waits here until this one commits,
    // then reads its emails as already being sent (a double click, two tabs).
    await client.query(q.lockSends, [`report_email:${school}:${reportType}:${term}`]);
    const { rows: busyRows } = await client.query(q.selectPendingForStudents, [school, reportType, term, students.map((s) => s.student_id)]);
    const busy = new Set(busyRows.map((b) => `${b.student_id}:${b.email}`));
    const { rows: [run] } = await client.query(q.insertRun, [
      school, reportType, term, customHeader || null, customMessage || null, JSON.stringify(cc),
      chosen ? 'chosen' : 'guardians', students.length, userId,
    ]);
    const base = (student) => ({
      kind: KIND,
      school,
      subjectType: SUBJECT_TYPE,
      subjectId: run.run_id,
      studentId: student.student_id,
      dedupeKey: `${run.run_id}:${student.student_id}`,
      priority: PRIORITY,
      createdBy: userId,
    });
    const rows = students.flatMap((student) => {
      if (!hasReport.has(student.student_id)) {
        return [{ ...base(student), recipientEmail: null, status: 'skipped', skipReason: SKIP.NO_REPORT(spec, term) }];
      }
      const addresses = chosen ? lower(chosen) : parentEmails(student);
      if (addresses.length === 0) return [{ ...base(student), recipientEmail: null, status: 'skipped', skipReason: SKIP.NO_EMAIL }];
      // The CC rides on the student's first email that goes.
      const ccOn = addresses.find((email) => !busy.has(`${student.student_id}:${email}`));
      return addresses.map((email) => (busy.has(`${student.student_id}:${email}`)
        ? { ...base(student), recipientEmail: email, status: 'skipped', skipReason: SKIP.BUSY }
        : { ...base(student), recipientEmail: email, payload: { cc: email === ccOn && cc.length > 0 } }));
    });
    await outbox.enqueue(client, rows);
    await client.query('COMMIT');

    outbox.kick();
    const queuedStudents = new Set(rows.filter((r) => (r.status ?? 'pending') === 'pending').map((r) => r.studentId));
    return { runId: run.run_id, createdAt: run.created_at, total: students.length, queued: queuedStudents.size, skipped: students.length - queuedStudents.size };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ── Sending one email ──────────────────────────────────────────────────────

// A student's PDF goes to each parent in turn: read it once. Keyed by its
// version too (generated_at): a regenerated report keeps its path, and the
// old PDF must never go out after it.
const pdfCache = new Map();
const PDF_TTL_MS = 5 * 60 * 1000;
const PDF_CACHE_MAX = 20;

async function reportPdf(spec, file) {
  const filePath = file.file_path;
  const version = file.generated_at ? new Date(file.generated_at).toISOString() : 'unversioned';
  const key = `${spec.bucket}/${filePath}@${version}`;
  const hit = pdfCache.get(key);
  if (hit && Date.now() - hit.at < PDF_TTL_MS) return hit.buffer;
  const { data, error } = await supabase.storage.from(spec.bucket).download(filePath);
  if (error || !data) throw new Error(`Could not read the ${spec.noun} file`);
  const buffer = Buffer.from(await data.arrayBuffer());
  pdfCache.set(key, { buffer, at: Date.now() });
  if (pdfCache.size > PDF_CACHE_MAX) pdfCache.delete(pdfCache.keys().next().value);
  return buffer;
}

/** Forget the cached PDFs (tests). */
function clearPdfCache() {
  pdfCache.clear();
}

async function schoolInfoOf(school) {
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    return rows[0] || null;
  } catch (error) {
    logger.warn({ err: error, school }, 'School lookup failed for a report email');
    return null;
  }
}

/** Builds one queued report email at send time (services/email/outbox.js). */
const reportEmailHandler = {
  async build(job) {
    const { rows: [run] } = await db.query(q.selectRun, [job.subject_id]);
    if (!run) return { skip: SKIP.GONE };
    const spec = REPORTS[run.report_type];
    const { rows: [student] } = await db.query(q.selectStudent, [job.student_id]);
    if (!student || student.is_archived) return { skip: SKIP.ARCHIVED };
    const address = job.recipient_email;
    if (run.recipients === 'guardians' && !parentEmails(student).includes(address)) return { skip: SKIP.NOT_PARENT };
    const { rows: [file] } = await db.query(spec.files, [[student.student_id], run.term, run.school]);
    if (!file?.file_path) return { skip: SKIP.NO_REPORT(spec, run.term) };

    const pdf = await reportPdf(spec, file);
    const schoolInfo = await schoolInfoOf(run.school);
    const subject = run.custom_header || `${student.name} — ${spec.label} (${run.term})`;
    const cc = job.payload?.cc ? lower(run.cc_addresses || []) : [];
    return {
      message: {
        ...schoolSender({ school: run.school, schoolInfo, role: 'academics' }),
        to: [address],
        ...(cc.length ? { cc } : {}),
        subject,
        html: spec.html({
          studentName: student.name,
          term: run.term,
          customMessage: run.custom_message,
          customHeader: run.custom_header,
          schoolName: getSchoolName(run.school),
          schoolInfo,
        }),
        attachments: [{ filename: `${student.name}_${run.term}_${run.report_type}.pdf`, content: pdf }],
      },
      sentContent: { subject, file: file.file_path, cc },
      // The log the report card pages read, and the report's "emailed" mark.
      afterSend: async () => {
        await db.query(q.upsertReportEmail, [
          run.report_type, student.student_id, run.term, job.created_by, JSON.stringify([address]),
          run.custom_header, run.custom_message, file.file_path, cc.length ? JSON.stringify(cc) : null, run.school, run.run_id,
        ]);
        await db.query(spec.markEmailed, [student.student_id, run.term, true, new Date().toISOString(), job.created_by]);
      },
    };
  },
};

// ── The send's page ────────────────────────────────────────────────────────

const runSummary = (run) => ({
  runId: run.run_id,
  reportType: run.report_type,
  term: run.term,
  recipients: run.recipients,
  studentCount: run.student_count,
  createdAt: run.created_at,
});

/** A send of this school with each student's emails, or null. */
async function runDelivery(runId, school) {
  const { rows: [run] } = await db.query(q.selectRunInSchool, [runId, school]);
  if (!run) return null;
  const { rows } = await db.query(outboxQueries.selectBySubject, [SUBJECT_TYPE, run.run_id]);
  return { ...runSummary(run), ...outbox.summarizeDelivery(rows, { noRecipient: SKIP.NO_EMAIL }) };
}

/** The school's latest sends with their counts (a send still going first to look for). */
async function recentRuns({ school, reportType = null, term = null, limit = 10 }) {
  const { rows: runs } = await db.query(q.selectRecentRuns, [school, reportType, term, limit]);
  if (runs.length === 0) return [];
  const { rows } = await db.query(outboxQueries.selectBySubjects, [SUBJECT_TYPE, runs.map((r) => r.run_id)]);
  const bySubject = new Map();
  for (const r of rows) bySubject.set(r.subject_id, [...(bySubject.get(r.subject_id) || []), r]);
  return runs.map((run) => ({
    ...runSummary(run),
    createdByName: run.created_by_name || null,
    counts: outbox.summarizeDelivery(bySubject.get(run.run_id) || []).counts,
  }));
}

/**
 * Sends a send's failed emails again. A failed parent address still on file
 * goes back to the queue (due now, a new idempotency key); one taken off the
 * student is skipped; a parent address added since, for a student whose
 * email failed or who had none, is queued. Typed addresses (one-student
 * send) are simply retried. Then sending starts.
 * @returns {Promise<{ requeued, added, dropped } | null>} null: no such send
 */
async function retryRun({ runId, school, userId = null }) {
  const { rows: [run] } = await db.query(q.selectRunInSchool, [runId, school]);
  if (!run) return null;
  const { rows } = await db.query(outboxQueries.selectBySubject, [SUBJECT_TYPE, run.run_id]);
  const failed = rows.filter((r) => r.status === 'failed');
  const noEmail = rows.filter((r) => r.status === 'skipped' && !r.recipient_email && r.skip_reason === SKIP.NO_EMAIL);

  let keep = failed;
  let dropped = [];
  let added = [];
  if (run.recipients === 'guardians') {
    const studentIds = [...new Set([...failed, ...noEmail].map((r) => r.student_id))];
    const { rows: students } = studentIds.length ? await db.query(q.selectStudents, [studentIds, school]) : { rows: [] };
    const onFile = new Map(students.map((s) => [s.student_id, parentEmails(s)]));
    keep = failed.filter((r) => (onFile.get(r.student_id) || []).includes(r.recipient_email));
    dropped = failed.filter((r) => !keep.includes(r));
    const known = new Set(rows.filter((r) => r.recipient_email).map((r) => `${r.student_id}:${r.recipient_email}`));
    added = studentIds.flatMap((studentId) => (onFile.get(studentId) || [])
      .filter((email) => !known.has(`${studentId}:${email}`))
      .map((email) => ({
        kind: KIND,
        school,
        recipientEmail: email,
        subjectType: SUBJECT_TYPE,
        subjectId: run.run_id,
        studentId,
        dedupeKey: `${run.run_id}:${studentId}`,
        priority: PRIORITY,
        createdBy: userId,
      })));
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: requeued } = keep.length
      ? await client.query(outboxQueries.requeueFailed, [SUBJECT_TYPE, run.run_id, keep.map((r) => r.id)])
      : { rows: [] };
    if (dropped.length) await client.query(outboxQueries.finishSkipped, [dropped.map((r) => r.id), SKIP.NOT_PARENT]);
    const addedCount = await outbox.enqueue(client, added);
    await client.query('COMMIT');
    outbox.kick();
    return { requeued: requeued.length, added: addedCount, dropped: dropped.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  KIND,
  SUBJECT_TYPE,
  SKIP,
  REPORTS,
  queueSend,
  reportEmailHandler,
  runDelivery,
  recentRuns,
  retryRun,
  clearPdfCache,
};
