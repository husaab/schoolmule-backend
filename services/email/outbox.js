// services/email/outbox.js
//
// The email outbox: features queue an email inside their own transaction
// (enqueue), and the notifier's tick sends it (drainOutbox). Rows hold ids;
// each kind's handler builds the email from the database as it is when it is
// sent, so a correction, an undo or a newer address is honoured.
//
// Delivery is at least once, made exactly once by Resend's idempotency key
// (24 hours): the key is the row id, its error count and the rows merged into
// the email, and the count only rises when Resend definitely refused the
// email or a person pressed Retry. A crash or a timeout after Resend accepted
// an email therefore retries with the same key, and Resend answers without
// sending it again; a retry that picked up another row is a new email.
//
// Handlers: { build(job, siblings, { now }) } → { skip } |
//   { message, sentContent?, afterSend?() }. `siblings` are the address's
// other due rows with the same coalesce key, sent in the same email.

const crypto = require('crypto');
const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/emailOutbox.queries');
const { getResend, sendOrThrow } = require('../../utils/emailUtils');

const MAX_ATTEMPTS = 3;
const DRAIN_LIMIT = 40;
// Resend allows 10 requests a second per team; every queue in the tick shares it.
const PAUSE_MS = 600;
// Postgres: relation does not exist (email_outbox_migration.sql not applied).
const UNDEFINED_TABLE = '42P01';

// Required lazily: a handler module enqueues through this one.
const HANDLERS = {
  grades_digest: () => require('../gradesDigest').gradesDigestHandler,
};

// Refusals that a retry can't fix (a bad address, a misconfigured sender or key).
const PERMANENT = new Set([
  'validation_error', 'missing_required_field', 'invalid_parameter', 'invalid_from_address', 'invalid_access',
  'invalid_region', 'invalid_api_Key', 'missing_api_key', 'not_found', 'method_not_allowed', 'invalid_idempotency_key',
]);
// Refused for now; nothing was sent.
const REFUSED = new Set(['rate_limit_exceeded', 'daily_quota_exceeded']);

let disabled = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a failed send means for its retry:
 * - 'already_sent': Resend saw this key before (it has the email);
 * - 'permanent': refused, and retrying can't help;
 * - 'refused': refused for now (rate limit, quota), definitely not sent;
 * - 'unknown': a server error, a timeout or our own error: it may have been
 *   sent, so the retry keeps the key.
 */
function classify(error) {
  const name = error?.resend?.name;
  if (name === 'invalid_idempotent_request') return 'already_sent';
  if (PERMANENT.has(name)) return 'permanent';
  if (REFUSED.has(name)) return 'refused';
  return 'unknown';
}

/**
 * The row, its error count and, when rows were merged into it, which: the
 * same email retried keeps its key, and a retry that took in a newer row
 * (one the accepted email never listed) is a new email with a new key.
 */
function idempotencyKey(job, siblings = []) {
  const key = `${job.kind}:${job.id}:${job.error_count}`;
  if (siblings.length === 0) return key;
  const merged = crypto.createHash('sha1').update(siblings.map((s) => s.id).sort().join(',')).digest('hex').slice(0, 16);
  return `${key}:${merged}`;
}

/**
 * Queue emails inside the caller's transaction. Each row:
 *   { kind, school, recipientEmail (null only with status 'skipped'), recipientUserId?, subjectType,
 *     subjectId?, classId?, studentId?, dedupeKey, coalesceKey?, payload?, priority?, delaySeconds?,
 *     status?: 'pending' | 'skipped', skipReason?, createdBy? }
 * The same (kind, address, dedupe key) is added once. Throws: a publish that
 * can't queue its email must not commit without it.
 * @returns {Promise<number>} the rows added
 */
async function enqueue(client, rows) {
  if (!rows || rows.length === 0) return 0;
  const json = rows.map((r) => ({
    kind: r.kind,
    school: r.school,
    recipient_user_id: r.recipientUserId ?? null,
    recipient_email: r.recipientEmail ? String(r.recipientEmail).trim().toLowerCase() : null,
    subject_type: r.subjectType,
    subject_id: r.subjectId ?? null,
    class_id: r.classId ?? null,
    student_id: r.studentId ?? null,
    dedupe_key: r.dedupeKey,
    coalesce_key: r.coalesceKey ?? null,
    payload: r.payload ?? {},
    priority: r.priority ?? 5,
    delay_seconds: r.delaySeconds ?? 0,
    status: r.status ?? 'pending',
    skip_reason: r.skipReason ?? null,
    created_by: r.createdBy ?? null,
  }));
  const { rows: inserted } = await client.query(q.insertJobs, [JSON.stringify(json)]);
  return inserted.length;
}

/** Sends one claimed row (and its siblings). @returns {Promise<'sent'|'skipped'>}; throws when the send fails. */
async function processJob(job, { now = new Date() } = {}) {
  const resolve = HANDLERS[job.kind];
  if (!resolve) {
    await db.query(q.finishSkipped, [[job.id], 'Unknown kind']);
    return 'skipped';
  }
  const handler = resolve();
  const { rows: siblings } = job.coalesce_key && job.recipient_email
    ? await db.query(q.claimSiblings, [job.kind, job.recipient_email, job.coalesce_key, job.id])
    : { rows: [] };
  const all = [job, ...siblings];
  try {
    const built = await handler.build(job, siblings, { now });
    if (built.skip) {
      await db.query(q.finishSkipped, [all.map((j) => j.id), built.skip]);
      return 'skipped';
    }
    let providerId = null;
    try {
      const result = await sendOrThrow(getResend(), built.message, { idempotencyKey: idempotencyKey(job, siblings) });
      providerId = result?.data?.id ?? null;
    } catch (error) {
      if (classify(error) !== 'already_sent') throw error;
      logger.info({ jobId: job.id, kind: job.kind }, 'Outbox email was already accepted by Resend; marking it sent');
    }
    // Resend has it: record that first (the row and the rows merged into it,
    // in one statement), so nothing sends it again.
    await db.query(q.finishSent, [
      job.id, providerId, built.sentContent ? JSON.stringify(built.sentContent) : null, siblings.map((j) => j.id),
    ]);
    if (built.afterSend) {
      try {
        await built.afterSend();
      } catch (error) {
        logger.error({ err: error, jobId: job.id, kind: job.kind }, 'Outbox email sent, but its follow-up write failed');
      }
    }
    return 'sent';
  } catch (error) {
    error.outboxJobs = all;
    throw error;
  }
}

/** Records a failed send on the row and the siblings that shared its email. */
async function recordFailure(jobs, error) {
  const outcome = classify(error);
  const message = String(error?.message || error).slice(0, 1000);
  await db.query(q.retryOrFail, [jobs.map((j) => j.id), message, MAX_ATTEMPTS, outcome === 'refused', outcome === 'permanent']);
  return outcome;
}

/**
 * Claims and sends due rows, at most `limit` per call, `pauseMs` between
 * sends. Never throws for one row's failure (it is retried or failed).
 * @returns {Promise<number>} the rows handled
 */
async function drainOutbox({ limit = DRAIN_LIMIT, pauseMs = PAUSE_MS, now } = {}) {
  let handled = 0;
  while (handled < limit && !disabled) {
    let rows;
    try {
      ({ rows } = await db.query(q.claimDue, []));
    } catch (error) {
      if (error?.code === UNDEFINED_TABLE) {
        disabled = 'email_outbox_migration.sql has not been applied';
        logger.error('Email outbox disabled: email_outbox is missing. Apply email_outbox_migration.sql and restart.');
        break;
      }
      throw error;
    }
    const job = rows[0];
    if (!job) break;
    handled += 1;
    try {
      const outcome = await processJob(job, { now: now ?? new Date() });
      if (outcome === 'sent' && pauseMs > 0) await sleep(pauseMs);
    } catch (error) {
      const jobs = error.outboxJobs || [job];
      try {
        const outcome = await recordFailure(jobs, error);
        logger.warn({ jobId: job.id, kind: job.kind, attempts: job.attempts, outcome, err: error.message }, 'Outbox email failed');
      } catch (recordError) {
        // The lease runs out and the row is tried again.
        logger.error({ err: recordError, jobId: job.id }, 'Outbox email failed and the failure could not be recorded');
      }
    }
  }
  return handled;
}

/** Clears the stand-down (worker start, tests). */
function resetOutboxState() {
  disabled = null;
}

module.exports = {
  MAX_ATTEMPTS,
  enqueue,
  drainOutbox,
  processJob,
  classify,
  idempotencyKey,
  resetOutboxState,
};
