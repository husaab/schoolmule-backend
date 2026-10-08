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

const { Resend } = require('resend');
const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/messaging.queries');
const schoolQueries = require('../queries/school.queries');
const { getSchoolApiKey, getSchoolDomain } = require('../utils/emailUtils');
const { getSchoolName } = require('../utils/schoolUtils');
const { getConversationDigestEmailHTML } = require('../templates/emailTemplate');

const DEFAULT_INTERVAL_MS = 30000;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MS = 600;
const EMAIL_DELAY = '2 minutes';
// Postgres: relation does not exist.
const UNDEFINED_TABLE = '42P01';

let timer = null;
let draining = false;
// Set when the outbox table is missing: say so once and stand down.
let disabledReason = null;

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
  if (ctx.muted || ctx.recipient_archived || !ctx.recipient_email || readSince) {
    const reason = ctx.muted ? 'muted' : readSince ? 'read before send' : ctx.recipient_archived ? 'recipient archived' : 'no recipient';
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

  const resend = new Resend(getSchoolApiKey(job.school));
  const result = await resend.emails.send({
    from: `messages@${getSchoolDomain(job.school)}`,
    to: [ctx.recipient_email],
    subject,
    html,
  });
  if (result?.error) throw new Error(result.error.message || 'Email sending failed');

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
  timer = setInterval(async () => {
    // Skip a tick rather than overlapping runs; the next one picks up anyway.
    if (draining) return;
    draining = true;
    try {
      await drainAll();
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

module.exports = { startWorker, stopWorker, drainOnce, drainAll, processJob, MAX_ATTEMPTS };
