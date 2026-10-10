// services/messageNotifier.js
//
// Drains message_email_jobs. A job is one (conversation, recipient) pair that
// becomes due two minutes after the first message the recipient has not seen;
// every message posted in that window rides in the same email. The job is
// skipped outright when the recipient has read the thread since, muted it,
// or has no address.
//
// IMPORTANT: startWorker() must only be called from a real server process
// (see the require.main guard in server.js). Every test suite requires
// server.js, so a poller started at module load would leave timers running.

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/messaging.queries');
const schoolQueries = require('../queries/school.queries');
const { getResend, sendOrThrow } = require('../utils/emailUtils');
const { schoolSender } = require('./email/senderIdentity');
const { getSchoolName } = require('../utils/schoolUtils');
const { getConversationDigestEmailHTML, getGuardianInviteEmailHTML, getAnnouncementEmailHTML } = require('../templates/emailTemplate');
const aq = require('../queries/announcement.queries');
const { scopeLabel, parentLink } = require('../utils/announcementScope');
const adminUserQueries = require('../queries/adminUser.queries');

const DEFAULT_INTERVAL_MS = 30000;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MS = 600;
const EMAIL_DELAY = '2 minutes';
// Announcement fan-out per tick: bounded so a school-wide post cannot starve message digests.
const ANNOUNCEMENT_BATCH = 40;
// Postgres: relation does not exist.
const UNDEFINED_TABLE = '42P01';

let timer = null;
let draining = false;
// Toronto date of the last reminder sweep; one sweep per day.
let lastReminderDate = null;
const torontoDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
// Set when the outbox table is missing: say so once and stand down.
let disabledReason = null;
let announcementsDisabled = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeLabel = (d) =>
  new Date(d).toLocaleString('en-CA', {
    timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

function threadLink(role, conversationId) {
  const base = process.env.FRONTEND_URL || '';
  return role === 'PARENT'
    ? `${base}/parent/messages?thread=${conversationId}`
    : `${base}/messages?thread=${conversationId}`;
}

/** "14/20 (70%)" for the facts block, or null when the score must not be shown. */
async function contextLineFor(ctx) {
  if (!ctx.assessment_id) return null;
  const { rows } = await db.query(q.selectAssessmentContext, [ctx.assessment_id, ctx.student_id]);
  const a = rows[0];
  if (!a) return null;
  if (ctx.recipient_role === 'PARENT' && !a.is_published) return null;
  if (a.status === 'missing') return 'Missing (0%)';
  if (a.status === 'excused') return 'Excused';
  if (a.score == null || !a.max_score) return null;
  const pct = Math.round((Number(a.score) / Number(a.max_score)) * 1000) / 10;
  return `${Number(a.score)}/${Number(a.max_score)} (${pct}%)`;
}

const latest = (...dates) => {
  const times = dates.filter(Boolean).map((d) => new Date(d));
  if (!times.length) return null;
  return new Date(Math.max(...times.map((t) => t.getTime()))).toISOString();
};

/** Process one claimed job. Returns 'sent' | 'skipped'. Throws on a send failure. */
async function processJob(job) {
  const { rows } = await db.query(q.selectJobContext, [job.job_id]);
  const ctx = rows[0];
  if (!ctx) {
    await db.query(q.finishJob, [job.job_id, 'skipped', 'job context missing']);
    return 'skipped';
  }

  const readSince = Boolean(ctx.last_read_at) && new Date(ctx.last_read_at) >= new Date(ctx.last_message_at);
  if (ctx.muted || ctx.recipient_archived || ctx.recipient_invite_pending || !ctx.recipient_email || readSince) {
    const reason = ctx.muted ? 'muted'
      : readSince ? 'read before send'
        : ctx.recipient_invite_pending ? 'invite pending'
          : ctx.recipient_archived ? 'recipient archived' : 'no recipient';
    await db.query(q.finishJob, [job.job_id, 'skipped', reason]);
    return 'skipped';
  }

  const since = latest(ctx.last_emailed_at, ctx.last_read_at);
  const { rows: msgs } = await db.query(q.selectMessagesForEmail, [job.conversation_id, job.recipient_id, since]);
  if (!msgs.length) {
    await db.query(q.finishJob, [job.job_id, 'skipped', 'nothing unread']);
    return 'skipped';
  }

  let schoolInfo = null;
  try {
    const r = await db.query(schoolQueries.selectSchoolByCode, [job.school]);
    schoolInfo = r.rows[0] || null;
  } catch (error) {
    logger.warn('School lookup failed for message email:', error);
  }
  const schoolName = getSchoolName(job.school);

  const html = getConversationDigestEmailHTML({
    recipientFirstName: ctx.recipient_first_name,
    studentName: ctx.student_name,
    className: ctx.class_subject,
    title: ctx.title,
    contextLine: await contextLineFor(ctx),
    messages: msgs.map((m) => ({
      senderName: m.sender_name || 'SchoolMule',
      body: m.body,
      sentAtLabel: timeLabel(m.created_at),
      attachmentCount: m.attachment_count,
    })),
    link: threadLink(ctx.recipient_role, job.conversation_id),
    schoolName,
    schoolInfo,
  });
  const subject = msgs.length === 1
    ? `${msgs[0].sender_name || 'SchoolMule'} sent a message about ${ctx.student_name}'s ${ctx.title}`
    : `${msgs.length} new messages about ${ctx.student_name}'s ${ctx.title}`;

  await sendOrThrow(getResend(), {
    ...schoolSender({ school: job.school, schoolInfo, role: 'messages' }),
    to: [ctx.recipient_email],
    subject,
    html,
  });

  // Resend accepted it: record that FIRST so a bookkeeping hiccup can never resend.
  await db.query(q.finishJob, [job.job_id, 'sent', null]);
  const lastRendered = new Date(msgs[msgs.length - 1].created_at).toISOString();
  try {
    await db.query(q.markEmailed, [job.conversation_id, job.recipient_id, lastRendered]);
    // A message posted while we were sending has no job of its own (the
    // pending row swallowed its enqueue); give it one now.
    const { rows: newer } = await db.query(q.selectMessagesForEmail, [job.conversation_id, job.recipient_id, lastRendered]);
    if (newer.length) {
      await db.query(q.enqueueEmailJobs, [job.conversation_id, [job.recipient_id], job.school, EMAIL_DELAY]);
    }
  } catch (error) {
    logger.warn({ jobId: job.job_id, err: error.message }, 'Sent digest but failed to update participant state');
  }
  return 'sent';
}

/** Build the invite landing link: set a password, then land in the thread. */
function inviteLink(token, conversationId) {
  const base = process.env.FRONTEND_URL || '';
  const next = encodeURIComponent(`/parent/messages?thread=${conversationId}`);
  return `${base}/reset-password?token=${token}&invite=1&next=${next}`;
}

/**
 * One reminder per invited guardian, three days after the invite, while the
 * account is still pending. Runs once per Toronto day from the worker tick.
 * @returns the number of reminders sent
 */
async function sendInviteReminders() {
  const { rows } = await db.query(q.selectInviteReminderCandidates, []);
  let sent = 0;
  for (const link of rows) {
    try {
      const { rows: tok } = await db.query(adminUserQueries.createInviteToken, [link.parent_id]);
      let schoolInfo = null;
      try {
        const r = await db.query(schoolQueries.selectSchoolByCode, [link.school]);
        schoolInfo = r.rows[0] || null;
      } catch (e) {
        logger.warn('School lookup failed for invite reminder:', e);
      }
      const schoolName = getSchoolName(link.school);
      const studentFirstName = String(link.student_name || '').split(' ')[0];
      await sendOrThrow(getResend(), {
        ...schoolSender({ school: link.school, schoolInfo, role: 'messages' }),
        to: [link.email],
        subject: `Still waiting for you: a message about ${studentFirstName}`,
        html: getGuardianInviteEmailHTML({
          recipientFirstName: link.first_name || link.parent_name,
          teacherName: link.invited_by_name || 'A teacher',
          studentFirstName,
          title: 'Your conversation on SchoolMule',
          preview: null,
          url: inviteLink(tok[0].token, link.invite_conversation_id),
          schoolName,
          schoolInfo,
          reminder: true,
        }),
      });
      await db.query(q.markInviteReminded, [link.parent_student_link_id]);
      sent += 1;
      await sleep(RATE_LIMIT_MS);
    } catch (error) {
      logger.warn({ linkId: link.parent_student_link_id, err: error.message }, 'Invite reminder failed');
    }
  }
  return sent;
}

async function remindIfDue(today = torontoDate()) {
  if (today === lastReminderDate) return 0;
  lastReminderDate = today;
  return sendInviteReminders();
}

// ── Announcements ───────────────────────────────────────────────────

function announcementLink(kind, ctx, token) {
  const base = process.env.FRONTEND_URL || '';
  if (kind === 'signup') return `${base}/signup/${String(ctx.school).toLowerCase()}/parent`;
  if (kind === 'invite') {
    return `${base}/reset-password?token=${token}&invite=1&next=${encodeURIComponent(`/parent/messages?tab=announcements&announcement=${ctx.announcement_id}`)}`;
  }
  return parentLink(ctx.announcement_id);
}

/** One announcement job: render the row as it is now and send once. Returns 'sent' | 'skipped'. */
async function processAnnouncementJob(job) {
  const { rows } = await db.query(aq.selectAnnouncementJobContext, [job.job_id]);
  const ctx = rows[0];
  const skip = !ctx ? 'job context missing'
    : ctx.deleted_at ? 'announcement removed'
      : ctx.recipient_archived ? 'recipient archived'
        : !ctx.recipient_email ? 'no recipient' : null;
  if (skip) {
    await db.query(aq.finishAnnouncementJob, [job.job_id, 'skipped', skip]);
    return 'skipped';
  }
  let token = null;
  if (ctx.kind === 'invite' && ctx.recipient_id) {
    await db.query(adminUserQueries.deleteTokensForUser, [ctx.recipient_id]);
    const { rows: tok } = await db.query(adminUserQueries.createInviteToken, [ctx.recipient_id]);
    token = tok[0]?.token;
  }
  let schoolInfo = null;
  try {
    const r = await db.query(schoolQueries.selectSchoolByCode, [ctx.school]);
    schoolInfo = r.rows[0] || null;
  } catch (error) {
    logger.warn('School lookup failed for announcement email:', error);
  }
  const schoolName = getSchoolName(ctx.school);
  const label = scopeLabel(ctx);
  const html = getAnnouncementEmailHTML({
    recipientFirstName: ctx.recipient_first_name,
    authorName: ctx.author_name || 'SchoolMule',
    scopeLabel: label,
    childNames: ctx.scope === 'school' ? [] : ctx.child_names || [],
    title: ctx.title,
    body: ctx.body,
    attachmentCount: ctx.attachment_count,
    link: announcementLink(ctx.kind, ctx, token),
    kind: ctx.kind,
    schoolName,
    schoolInfo,
  });
  await sendOrThrow(getResend(), {
    ...schoolSender({ school: ctx.school, schoolInfo, role: 'messages' }),
    to: [ctx.recipient_email],
    subject: `${label}: ${ctx.title}`,
    html,
  });
  await db.query(aq.finishAnnouncementJob, [job.job_id, 'sent', null]);
  return 'sent';
}

async function drainAnnouncementOnce() {
  if (announcementsDisabled) return 0;
  let rows;
  try {
    ({ rows } = await db.query(aq.claimDueAnnouncementJob, []));
  } catch (error) {
    if (error?.code === UNDEFINED_TABLE) {
      announcementsDisabled = 'announcements_migration.sql has not been applied';
      logger.error('Announcement emails disabled: announcement_email_jobs is missing. Apply announcements_migration.sql and restart.');
      return 0;
    }
    throw error;
  }
  const job = rows[0];
  if (!job) return 0;
  try {
    const outcome = await processAnnouncementJob(job);
    if (outcome === 'sent') await sleep(RATE_LIMIT_MS);
  } catch (error) {
    await db.query(aq.retryOrFailAnnouncementJob, [job.job_id, String(error.message || error), MAX_ATTEMPTS]);
    logger.warn({ jobId: job.job_id, attempts: job.attempts, err: error.message }, 'Announcement email failed; will retry');
  }
  return 1;
}

/** Drains announcement jobs, bounded per tick. */
async function drainAnnouncements(limit = ANNOUNCEMENT_BATCH) {
  let handled = 0;
  while (handled < limit) {
    const n = await drainAnnouncementOnce();
    if (n === 0) break;
    handled += n;
  }
  return handled;
}

/**
 * Claim and process one due job, if any.
 * @returns the number of jobs handled (0 or 1)
 */
async function drainOnce() {
  if (disabledReason) return 0;

  let rows;
  try {
    ({ rows } = await db.query(q.claimDueJob, []));
  } catch (error) {
    if (error?.code === UNDEFINED_TABLE) {
      disabledReason = 'messaging_migration.sql has not been applied';
      stopWorker();
      logger.error('Message notifier disabled: message_email_jobs is missing. Apply messaging_migration.sql and restart.');
      return 0;
    }
    throw error;
  }

  const job = rows[0];
  if (!job) return 0;

  try {
    const outcome = await processJob(job);
    if (outcome === 'sent') await sleep(RATE_LIMIT_MS);
  } catch (error) {
    await db.query(q.retryOrFailJob, [job.job_id, String(error.message || error), MAX_ATTEMPTS]);
    logger.warn({ jobId: job.job_id, attempts: job.attempts, err: error.message }, 'Message email failed; will retry');
  }
  return 1;
}

/** Drains until the queue is empty (bounded), so a backlog clears in one tick. */
async function drainAll(limit = 20) {
  let handled = 0;
  while (handled < limit) {
    const n = await drainOnce();
    if (n === 0) break;
    handled += n;
  }
  return handled;
}

function startWorker(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return;
  disabledReason = null;
  announcementsDisabled = null;
  // A restart part-way through the day must not re-run the reminder sweep.
  lastReminderDate = torontoDate();
  timer = setInterval(async () => {
    // Skip a tick rather than overlapping runs; the next one picks up anyway.
    if (draining) return;
    draining = true;
    try {
      if (!disabledReason) await remindIfDue();
      await drainAll();
      await drainAnnouncements();
    } catch (error) {
      // Never let a worker error take the process down.
      logger.error({ err: error }, 'Message notifier tick failed');
    } finally {
      draining = false;
    }
  }, intervalMs);
  // Don't hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ intervalMs }, 'Message notifier started');
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startWorker, stopWorker, drainOnce, drainAll, processJob, sendInviteReminders, inviteLink, MAX_ATTEMPTS,
  drainAnnouncements, processAnnouncementJob, ANNOUNCEMENT_BATCH,
};
