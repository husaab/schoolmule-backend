// services/classroom/classroomNotifier.js
//
// The classroom emails (spec §7, T21), through one outbox
// (classroom_email_jobs) drained by the message notifier's tick:
//   new_work       a student, 2 minutes after an item is posted
//   due_reminder   a student, from 5 pm, for work due tomorrow not turned in
//   graded         a student, every grade published in a 15-minute bucket
//                  (Classwork and whole columns published in Grades)
//   missing_alert  a guardian address, from 4 pm: one job per child × item
//                  that went missing in (yesterday 4 pm, today 4 pm], sent as
//                  one email per family; not for daily-summary readers
//   weekly_summary a guardian address, from 4 pm on their day (or daily), in
//                  schools with the parents' summary on (its own switch, apart
//                  from the student portal); also an address with no account
//                  (weekly, the school's day, no way to turn it off)
// Students are emailed like T10's announcement emails: classrooms on, student
// email on for their grade, a usable login (consent, set password, address,
// at or above the sign-in grade), re-checked when the email is sent. Every
// email is the school's letterhead from the school's "messages" sender, with
// the office's Reply-To only (never a teacher's: students talk to teachers in
// SchoolMule, with their parents in the conversation, D14).
//
// Idempotency: each enqueue is INSERT ... ON CONFLICT DO NOTHING on (address,
// kind, digest key), so a tick, a restart or a second instance re-running it
// adds nothing; the sweeps read windows anchored to 4 pm Toronto, so a re-run
// the same day reads the same window; `lastRun` only saves re-running their
// SQL within a day.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/classroomEmail.queries');
const schoolQueries = require('../../queries/school.queries');
const { getResend, sendOrThrow } = require('../../utils/emailUtils');
const { schoolSender } = require('../email/senderIdentity');
const { getSchoolName } = require('../../utils/schoolUtils');
const { avatarPngUrl } = require('../../utils/avatar');
const { askFields } = require('../../utils/parentLinks');
const digest = require('./classroomDigest');
const templates = require('../../templates/classroomEmailTemplates');

const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MS = 600;
const DRAIN_LIMIT = 40;
const NEW_WORK_DELAY_MS = 2 * 60 * 1000;
const BUCKET_MS = 15 * 60 * 1000;
const POST_NOTE_MAX = 90;
// The new-work email carries the start of the instructions; the rest is in SchoolMule.
const INSTRUCTIONS_MAX = 600;
// Postgres: relation does not exist (student_portal_23 not applied).
const UNDEFINED_TABLE = '42P01';

// Set when the outbox is missing: say so once and stand down until restart.
let disabled = null;
// Toronto date each sweep last ran in this process.
const lastRun = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = () => process.env.FRONTEND_URL || '';
const iso = (d) => new Date(d).toISOString();

/** True (after one log line) when the error is the missing-table one. */
function standDown(error) {
  if (error?.code !== UNDEFINED_TABLE) return false;
  if (!disabled) {
    disabled = 'student_portal_23_classroom_emails.sql has not been applied';
    logger.error('Classroom emails disabled: classroom_email_jobs is missing. Apply student_portal_23_classroom_emails.sql and restart.');
  }
  return true;
}

/** Forget the sweeps' last runs and any stand-down (worker start, tests). */
function resetScheduleState() {
  for (const key of Object.keys(lastRun)) delete lastRun[key];
  disabled = null;
}

/** Runs an enqueue; never throws (a failure is logged). Returns the jobs added. */
async function enqueue(label, sql, params, context = {}) {
  if (disabled) return 0;
  try {
    const { rows } = await db.query(sql, params);
    return rows.length;
  } catch (error) {
    if (!standDown(error)) logger.warn({ err: error, ...context }, `Queueing ${label} emails failed`);
    return 0;
  }
}

// ── Enqueue ────────────────────────────────────────────────────────────────

/**
 * Items just posted (created, edited or promoted to posted): one new_work job
 * per eligible student in the audience who can see it, sent in 2 minutes.
 * Items with email_students off queue nothing. Never throws.
 */
async function enqueueNewWork(itemIds, { now = new Date() } = {}) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  return enqueue('new work', q.enqueueNewWork, [ids, iso(now), iso(new Date(now).getTime() + NEW_WORK_DELAY_MS)], { itemIds: ids });
}

/**
 * Grades just published (after COMMIT): one graded job per eligible student
 * per 15-minute bucket, sent when the bucket ends, so a teacher publishing
 * several items or columns in a row sends one email (spec D6: every newly
 * published grade). `studentIds`: work published to these students in
 * Classwork; `assessmentIds`: whole columns published in Grades (the students
 * with a grade there that is now visible). Never throws.
 */
async function enqueueGraded({ school, studentIds = [], assessmentIds = [], now = new Date() }) {
  if (!school) return 0;
  const students = [...new Set((studentIds || []).filter(Boolean))];
  const columns = [...new Set((assessmentIds || []).filter(Boolean))];
  const bucket = digest.gradedBucket(now);
  const tail = [school, bucket.key, iso(bucket.end), iso(bucket.start)];
  let queued = 0;
  if (students.length) queued += await enqueue('graded', q.enqueueGraded, [students, ...tail], { school });
  if (columns.length) queued += await enqueue('graded', q.enqueueGradedColumns, [columns, ...tail], { school });
  return queued;
}

async function enqueueDueReminders(now, parts) {
  const { rows } = await db.query(q.enqueueDueReminders, [iso(now), digest.addDays(parts.date, 1)]);
  return rows.length;
}

async function enqueueMissingAlerts(now) {
  const w = digest.sweepWindows(now);
  const { rows } = await db.query(q.enqueueMissingAlerts, [iso(now), iso(w.day), iso(w.until)]);
  return rows.length;
}

async function enqueueSummaries(now, parts) {
  const w = digest.sweepWindows(now);
  const { rows } = await db.query(q.enqueueSummaries, [
    iso(now), parts.dow, `weekly:${digest.isoWeekKey(now)}`, `daily:${parts.date}`, iso(w.week), iso(w.day), iso(w.until),
  ]);
  return rows.length;
}

/**
 * The daily sweeps, each once per Toronto day per process once its gate is
 * open: due reminders (5 pm), missing alerts and summaries (4 pm). A sweep
 * that fails is logged and retried on the next tick.
 * @returns {Promise<{ dueReminders: number, missingAlerts: number, summaries: number }>} jobs added
 */
async function runSchedule(now = new Date()) {
  const out = { dueReminders: 0, missingAlerts: 0, summaries: 0 };
  if (disabled) return out;
  const parts = digest.torontoParts(now);
  const gates = digest.scheduleGates(now);
  const sweeps = [
    ['dueReminders', 'due_reminder', gates.dueReminder, enqueueDueReminders],
    ['missingAlerts', 'missing_alert', gates.missingAlert, enqueueMissingAlerts],
    // Weekly recipients are matched to today's weekday in SQL.
    ['summaries', 'weekly_summary', gates.dailySummary, enqueueSummaries],
  ];
  for (const [key, kind, open, sweep] of sweeps) {
    if (!open || lastRun[kind] === parts.date || disabled) continue;
    try {
      out[key] = await sweep(now, parts);
      lastRun[kind] = parts.date;
    } catch (error) {
      if (!standDown(error)) logger.error({ err: error, kind }, 'Classroom email sweep failed; will retry');
    }
  }
  return out;
}

// ── Send-time content ──────────────────────────────────────────────────────

const studentItemLink = (itemId) => `${base()}/student/items/${itemId}`;

async function studentEmailOn(userId) {
  const { rows } = await db.query(q.selectStudentEmailOn, [userId]);
  return Boolean(rows[0]?.email_on);
}

async function buildNewWork(job, recipient, now) {
  const { itemId, studentId } = job.payload || {};
  const { rows: [c] } = await db.query(q.selectNewWork, [itemId, studentId, recipient.user_id, iso(now)]);
  if (!c || c.deleted_at) return { skip: 'item removed' };
  if (!c.email_on) return { skip: 'student email off' };
  if (!c.posted) return { skip: 'not posted' };
  if (!c.email_students) return { skip: 'email off for this item' };
  if (!c.visible) return { skip: 'not visible' };
  return {
    render: (school) => templates.newWorkEmail({
      recipientFirstName: recipient.first_name,
      kind: c.kind,
      title: c.title || 'Untitled',
      subject: c.subject,
      teacherName: c.teacher_name || 'Your teacher',
      teacherAvatarUrl: avatarPngUrl(c.teacher_avatar),
      dueLabel: c.due_at ? `${digest.dayLabel(c.due_at)} at ${digest.timeLabel(c.due_at)}` : null,
      dateLabel: !c.due_at && c.date ? digest.dayLabel(c.date) : null,
      points: c.max_score !== null && c.max_score !== undefined ? digest.scoreLabel({ score: c.max_score }) : null,
      instructions: c.instructions ? digest.excerptLines(c.instructions, INSTRUCTIONS_MAX) : null,
      link: studentItemLink(c.item_id),
      ...school,
    }),
  };
}

async function buildDueReminder(job, recipient, now) {
  if (!(await studentEmailOn(recipient.user_id))) return { skip: 'student email off' };
  const dueDate = job.payload?.dueDate;
  const { rows } = await db.query(q.selectDueOn, [recipient.user_id, dueDate, iso(now)]);
  if (!rows.length) return { skip: 'nothing to turn in' };
  return {
    render: (school) => templates.dueReminderEmail({
      recipientFirstName: recipient.first_name,
      items: rows.map((r) => ({ title: r.title || 'Untitled', subject: r.subject, dueLabel: digest.timeLabel(r.due_at) })),
      link: rows.length === 1 ? studentItemLink(rows[0].item_id) : `${base()}/student/todo`,
      ...school,
    }),
  };
}

async function buildGraded(job, recipient, now) {
  if (!(await studentEmailOn(recipient.user_id))) return { skip: 'student email off' };
  // From one bucket before this one: a publish whose enqueue landed just
  // after a bucket boundary is still covered; what an earlier graded email
  // already carried is left out by the query.
  const start = job.payload?.since ? new Date(job.payload.since) : new Date(job.created_at || now);
  const since = new Date(start.getTime() - BUCKET_MS);
  const { rows } = await db.query(q.selectGradedWork, [recipient.user_id, iso(since), iso(now), job.recipient_email, job.job_id]);
  if (!rows.length) return { skip: 'nothing published' };
  return {
    payloadPatch: { emailed: rows.map((r) => ({ id: r.key_id, at: r.published_key })) },
    render: (school) => templates.gradedEmail({
      recipientFirstName: recipient.first_name,
      grades: rows.map((r) => ({
        title: r.title || 'Untitled',
        subject: r.subject,
        scoreLabel: digest.scoreLabel({ score: r.score, maxScore: r.max_score, status: r.status }),
        feedback: r.feedback,
        teacherName: r.teacher_name,
      })),
      // One grade on work the student can open links to it; else the Grades page.
      link: rows.length === 1 && rows[0].item_visible ? studentItemLink(rows[0].item_id) : `${base()}/student/grades`,
      ...school,
    }),
  };
}

/** The parent's choices with the defaults filled in, and the school's day. */
async function loadPrefs(userId, school) {
  const { rows: [p] } = await db.query(q.selectPrefs, [userId, school]);
  const schoolDow = p?.school_dow ?? digest.DEFAULT_SUMMARY_DOW;
  return {
    weeklySummary: p?.weekly_summary ?? true,
    summaryFrequency: p?.summary_frequency ?? 'weekly',
    summaryDow: p?.summary_dow ?? null,
    missingAlerts: p?.missing_alerts ?? true,
    schoolDow: Number(schoolDow),
  };
}

const groupBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) || []), r]), new Map());

const childHeader = (c) => ({
  name: digest.firstName(c.name),
  gradeLabel: digest.gradeLabel(c.grade),
  avatarUrl: avatarPngUrl(c.avatar),
});
const missingLine = (r) => ({ title: r.title || 'Untitled', subject: r.subject, whenLabel: digest.whenLabel(r) });
// The alert's line also asks the class teacher about it. Missing work is
// rarely shared with parents yet, so the portal writes a General message
// titled after the item unless its gradebook column has been published. No
// term gate here (the work is from the last 14 days): a class that can no
// longer be written about opens a short note in the portal instead.
const missingAlertLine = (r) => ({
  ...missingLine(r),
  ...askFields({ studentId: r.student_id, classId: r.class_id, assessmentId: r.assessment_id, about: r.title, teacherName: r.teacher_name }),
});

const prefsLinks = (recipient) => (recipient.role === 'PARENT'
  ? {
    dailyLink: `${base()}/parent/notifications?set=daily`,
    offLink: `${base()}/parent/notifications?set=off`,
    prefsLink: `${base()}/parent/notifications`,
  }
  : { dailyLink: null, offLink: null, prefsLink: null });

// A summary's children: an account's, or an address's with no account.
async function childrenWork(recipient, now, since) {
  const { rows: children } = await db.query(q.selectSummaryChildren, [
    recipient.user_id || null, recipient.user_id ? null : recipient.email]);
  if (!children.length) return { children, work: new Map() };
  const earliest = digest.addDays(digest.torontoParts(now).date, -digest.MISSING_DAYS);
  const { rows } = await db.query(q.selectChildWork, [children.map((c) => c.student_id), iso(now), iso(since), earliest]);
  return { children, work: groupBy(rows, 'student_id') };
}

/**
 * One email per family: this job and the address's other pending alerts
 * (one job per child × item, see enqueueMissingAlerts) go out together and
 * are finished together. What is no longer missing (turned in, graded,
 * excused since), or was confirmed Missing or listed in a publish digest to
 * this address (announced there), is left out.
 */
async function buildMissingAlert(job, recipient, now) {
  const { rows: siblings } = await db.query(q.claimSiblingAlerts, [job.recipient_email, job.job_id]);
  const group = siblings.map((r) => r.job_id);
  const prefs = await loadPrefs(recipient.user_id, job.school);
  if (!prefs.missingAlerts) return { skip: 'prefs off', group };
  // The daily summary lists the day's Missing work: no second email beside it.
  if (prefs.weeklySummary && prefs.summaryFrequency === 'daily') return { skip: 'in daily summary', group };

  const pairs = [job, ...siblings].map((j) => j.payload || {}).filter((p) => p.studentId && p.itemId);
  const { rows: children } = await db.query(q.selectGuardianChildren, [recipient.user_id]);
  const mine = new Set(children.map((c) => c.student_id));
  const wanted = pairs.filter((p) => mine.has(p.studentId));
  const { rows } = wanted.length
    ? await db.query(q.selectAlertItems, [wanted.map((p) => p.studentId), wanted.map((p) => p.itemId), iso(now), job.recipient_email])
    : { rows: [] };
  // One email per Missing: what a publish digest has announced is left out.
  const work = groupBy(rows.filter((r) => !r.announced), 'student_id');
  const blocks = children
    .map((c) => ({ ...childHeader(c), items: digest.stillMissing(work.get(c.student_id) || []).map(missingAlertLine) }))
    .filter((c) => c.items.length);
  if (!blocks.length) return { skip: 'nothing new', group };
  return {
    group,
    render: (school) => templates.missingAlertEmail({
      recipientFirstName: recipient.first_name,
      children: blocks,
      link: `${base()}/parent/classes`,
      prefsLink: prefsLinks(recipient).prefsLink,
      ...school,
    }),
  };
}

async function buildSummary(job, recipient, now) {
  const prefs = await loadPrefs(recipient.user_id, job.school);
  if (!prefs.weeklySummary) return { skip: 'prefs off' };
  const frequency = job.payload?.frequency === 'daily' ? 'daily' : 'weekly';
  // The window the sweep fixed (4 pm to 4 pm, Toronto); content after its end is the next summary's.
  const windows = digest.sweepWindows(now);
  const since = job.payload?.since ? new Date(job.payload.since) : (frequency === 'daily' ? windows.day : windows.week);
  const until = job.payload?.until ? new Date(job.payload.until) : windows.until;
  const { children, work } = await childrenWork(recipient, now, since);
  if (!children.length) return { skip: 'nothing to report' };
  const { rows: postRows } = await db.query(q.selectChildPosts, [children.map((c) => c.student_id), iso(since), iso(until), recipient.user_id || null]);
  // A post for the whole school or grade reaches several children: list it once, under the first.
  const seen = new Set();
  const posts = new Map();
  for (const c of children) {
    posts.set(c.student_id, postRows.filter((p) => p.student_id === c.student_id && !seen.has(p.announcement_id)));
    for (const p of posts.get(c.student_id)) seen.add(p.announcement_id);
  }
  const blocks = children.map((c) => {
    const sections = digest.summarySections(work.get(c.student_id) || [], { since, until, now, frequency });
    return {
      ...childHeader(c),
      missing: sections.missing.map(missingLine),
      grades: sections.grades.map((r) => ({
        title: r.title || 'Untitled',
        subject: r.subject,
        scoreLabel: digest.scoreLabel({ score: r.score, maxScore: r.max_score, status: r.status }),
        feedback: r.feedback,
        teacherName: r.teacher_name,
      })),
      due: sections.due.map((r) => ({ title: r.title || 'Untitled', subject: r.subject, dayLabel: digest.weekdayShort(r.due_at) })),
      posts: posts.get(c.student_id).map((p) => ({
        title: p.title,
        authorName: p.author_name,
        note: digest.excerpt(p.body, POST_NOTE_MAX) || null,
        // "Got it" needs a sign-in; an address with no account gets the post without it.
        ackLink: p.ack_requested && !p.acked && recipient.user_id
          ? `${base()}/parent/messages?tab=announcements&announcement=${p.announcement_id}&ack=1`
          : null,
      })),
    };
  }).filter((c) => c.missing.length || c.grades.length || c.due.length || c.posts.length);
  if (!blocks.length) return { skip: 'nothing to report' };
  const range = digest.summaryRange(now);
  return {
    render: (school) => templates.weeklySummaryEmail({
      recipientFirstName: recipient.first_name,
      frequency,
      dayName: digest.dowPlural(prefs.summaryDow ?? prefs.schoolDow),
      rangeLabel: frequency === 'daily' ? digest.dayLabel(now) : digest.weekLabel(range.from, range.to),
      children: blocks,
      link: `${base()}/parent/classes`,
      ...prefsLinks(recipient),
      // No account yet: a link to set one up instead of the portal.
      setupLink: recipient.user_id ? null : `${base()}/signup/${String(job.school).toLowerCase()}/parent`,
      ...school,
    }),
  };
}

const BUILDERS = {
  new_work: buildNewWork,
  due_reminder: buildDueReminder,
  graded: buildGraded,
  missing_alert: buildMissingAlert,
  weekly_summary: buildSummary,
};

async function schoolOf(school) {
  let schoolInfo = null;
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    schoolInfo = rows[0] || null;
  } catch (error) {
    logger.warn({ err: error, school }, 'School lookup failed for a classroom email');
  }
  return { schoolInfo, schoolName: getSchoolName(school) };
}

// A summary for an address with no account: no name, no role, no preferences.
const addressRecipient = (job) => ({
  user_id: null, first_name: null, last_name: null, role: null, email: job.recipient_email, is_archived: false, invite_pending: false,
});

/**
 * Renders one claimed job as things stand now and sends it once.
 * @returns {Promise<'sent'|'skipped'>} throws when the send fails (the caller retries)
 */
async function processClassroomJob(job, { now = new Date() } = {}) {
  // `group`: other jobs this email answers for (a family's missing alerts),
  // finished with this one.
  const skip = async (reason, group = []) => {
    await db.query(q.finishJob, [job.job_id, 'skipped', reason, null]);
    if (group.length) await db.query(q.finishJobs, [group, 'skipped', reason]);
    return 'skipped';
  };
  const build = BUILDERS[job.kind];
  if (!build) return skip('unknown kind');
  const { rows: [recipient] } = job.recipient_id
    ? await db.query(q.selectRecipient, [job.recipient_id])
    : { rows: job.kind === 'weekly_summary' ? [addressRecipient(job)] : [] };
  if (!recipient || !recipient.email) return skip('no recipient');
  if (recipient.is_archived) return skip('recipient archived');
  if (recipient.invite_pending) return skip('invite pending');

  const built = await build(job, recipient, now);
  const group = built.group || [];
  if (built.skip) return skip(built.skip, group);

  const school = await schoolOf(job.school);
  const { subject, html } = built.render(school);
  await sendOrThrow(getResend(), {
    ...schoolSender({ school: job.school, schoolInfo: school.schoolInfo, role: 'messages' }),
    to: [recipient.email],
    subject,
    html,
  });
  // Resend accepted it: record that first so nothing can send it again.
  await db.query(q.finishJob, [job.job_id, 'sent', null, built.payloadPatch ? JSON.stringify(built.payloadPatch) : null]);
  if (group.length) await db.query(q.finishJobs, [group, 'sent', null]);
  return 'sent';
}

/**
 * Claims and sends due jobs, at most `limit` per call, 600 ms between sends.
 * A failed send is retried 5 minutes later, then again, then marked failed.
 * @returns {Promise<number>} the jobs handled
 */
async function drainClassroomJobs({ limit = DRAIN_LIMIT } = {}) {
  let handled = 0;
  while (handled < limit && !disabled) {
    let rows;
    try {
      ({ rows } = await db.query(q.claimDueJob, []));
    } catch (error) {
      if (standDown(error)) break;
      throw error;
    }
    const job = rows[0];
    if (!job) break;
    handled += 1;
    try {
      const outcome = await processClassroomJob(job);
      if (outcome === 'sent') await sleep(RATE_LIMIT_MS);
    } catch (error) {
      await db.query(q.retryOrFailJob, [job.job_id, String(error.message || error), MAX_ATTEMPTS]);
      logger.warn({ jobId: job.job_id, kind: job.kind, attempts: job.attempts, err: error.message }, 'Classroom email failed; will retry');
    }
  }
  return handled;
}

/**
 * A parent's summary as it would go out now, built the same way, without
 * sending or recording anything: { subject, html }, or { skip } when there is
 * nothing to send. For an account pass its userId; an address with no
 * account passes only its email. (scripts/previewParentSummaries.js)
 */
async function previewSummary({ school, email, userId = null, now = new Date() }) {
  const job = { kind: 'weekly_summary', school, recipient_id: userId, recipient_email: String(email).trim().toLowerCase(), payload: { frequency: 'weekly' } };
  const { rows: [recipient] } = userId ? await db.query(q.selectRecipient, [userId]) : { rows: [addressRecipient(job)] };
  if (!recipient) return { skip: 'no recipient' };
  const built = await buildSummary(job, recipient, now);
  if (built.skip) return { skip: built.skip };
  return built.render(await schoolOf(school));
}

module.exports = {
  MAX_ATTEMPTS,
  previewSummary,
  enqueueNewWork,
  enqueueGraded,
  runSchedule,
  drainClassroomJobs,
  processClassroomJob,
  resetScheduleState,
  loadPrefs,
};
