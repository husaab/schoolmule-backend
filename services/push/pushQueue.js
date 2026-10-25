// services/push/pushQueue.js
//
// The push queue (push_jobs). Events write one row per person with the
// notification's text and the app screen it opens (pushEvents); the message
// notifier's tick sends what is due (drain), and a new row kicks a send at
// once, so a message reaches the phone in about a second.
//
// Delivery is at most once in practice: a row is leased for 2 minutes when it
// is claimed and marked sent as soon as Expo takes it. Only a request Expo
// refused or never answered is retried (3 attempts), and a phone reached by a
// retry it had already received shows the same notification twice; nothing
// else can repeat one. Expo's receipts arrive ~15 minutes later: a phone that
// no longer has the app loses its device row then (or at once, when the send
// itself says so).

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/push.queries');
const expo = require('./expoClient');

const MAX_ATTEMPTS = 3;
const DRAIN_LIMIT = 100;
const TTL_SECONDS = 24 * 60 * 60;
const RECEIPTS_EVERY_MS = 15 * 60 * 1000;
const HOUSEKEEPING_EVERY_MS = 24 * 60 * 60 * 1000;
// Postgres: relation does not exist (push_notifications_migration.sql not applied).
const UNDEFINED_TABLE = '42P01';

let disabled = null;
let started = false;
let draining = false;
let drainAgain = false;
let lastReceipts = 0;
let lastHousekeeping = 0;

/** True (after one log line) when the error is the missing-table one. */
function standDown(error) {
  if (error?.code !== UNDEFINED_TABLE) return false;
  if (!disabled) {
    disabled = 'push_notifications_migration.sql has not been applied';
    logger.error('Push notifications disabled: push_jobs is missing. Apply push_notifications_migration.sql and restart.');
  }
  return true;
}

const off = () => Boolean(disabled) || process.env.PUSH_DISABLED === 'true';

/**
 * An app screen, never a web address or a sign-in link: the app opens it
 * with its router, so anything else is dropped before it is queued.
 */
const isAppPath = (path) =>
  typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\s\\]/.test(path) && !/token=/i.test(path);

/** A body for the lock screen: one line, at most `max` characters. */
const preview = (text, max = 120) => {
  // Rich text (announcements): a block ends a word, an inline tag doesn't.
  const flat = String(text ?? '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/**
 * Queues notifications for people with the app; never throws.
 * rows: [{ recipientId, kind, category, dedupeKey, title, body, path,
 *          subtitle?, threadKey?, payload?, delaySeconds? }]
 * @returns {Promise<number>} the rows queued
 */
async function enqueue(rows) {
  if (off() || !rows?.length) return 0;
  const json = rows
    .filter((r) => r.recipientId && isAppPath(r.path) && r.title && r.body)
    .map((r) => ({
      kind: r.kind,
      category: r.category,
      recipient_id: r.recipientId,
      dedupe_key: r.dedupeKey,
      title: preview(r.title, 80),
      subtitle: r.subtitle ? preview(r.subtitle, 80) : null,
      body: preview(r.body),
      path: r.path,
      thread_key: r.threadKey ?? null,
      payload: r.payload ?? {},
      delay_seconds: r.delaySeconds ?? 0,
    }));
  if (!json.length) return 0;
  return run('enqueue', q.insertJobs, [JSON.stringify(json)]);
}

/** Runs one of the queries that queue rows itself; never throws. @returns the rows queued */
async function run(label, sql, params) {
  if (off()) return 0;
  try {
    const { rows } = await db.query(sql, params);
    if (rows.length) kick();
    return rows.length;
  } catch (error) {
    if (!standDown(error)) logger.warn({ err: error, label }, 'Queueing push notifications failed');
    return 0;
  }
}

// What a row must still be true of when it is sent, by kind.
const RECHECKS = {
  // New work waits 2 minutes; it may have been taken down or rescheduled since.
  new_work: async (job, now) => {
    const { itemId, studentId } = job.payload || {};
    const { rows } = await db.query(q.selectItemVisible, [itemId, studentId, now.toISOString()]);
    return rows.length ? null : 'not visible';
  },
};

const messageFor = (job, token) => ({
  to: token,
  title: job.title,
  ...(job.subtitle && { subtitle: job.subtitle }),
  body: job.body,
  data: { path: job.path, category: job.category, kind: job.kind },
  sound: 'default',
  priority: 'high',
  ttl: TTL_SECONDS,
  // Android shows it in the category's channel; iOS groups a conversation's.
  channelId: job.category,
  ...(job.thread_key && { threadId: job.thread_key }),
});

const groupBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) || []), r]), new Map());

/** Sends one request's worth of messages and records what Expo said. */
async function sendChunk(chunk) {
  const ids = [...new Set(chunk.map((o) => o.job.job_id))];
  let tickets;
  try {
    tickets = await expo.sendBatch(chunk.map((o) => o.message));
  } catch (error) {
    await db.query(q.retryOrFail, [ids, String(error.message || error).slice(0, 500), MAX_ATTEMPTS]);
    logger.warn({ err: error.message, jobs: ids.length }, 'Push send failed; will retry');
    return;
  }
  // Expo has them: record that first, so nothing sends them again.
  await db.query(q.finishSent, [ids]);
  const accepted = [];
  const gone = new Set();
  tickets.forEach((t, i) => {
    const { token, job } = chunk[i];
    if (t?.status === 'ok' && t.id) accepted.push({ ticket_id: t.id, token });
    else if (t?.details?.error === 'DeviceNotRegistered') gone.add(token);
    else logger.warn({ kind: job.kind, error: t?.details?.error, message: t?.message }, 'Push notification refused');
  });
  if (gone.size) await db.query(q.deleteTokens, [[...gone]]);
  if (accepted.length) await db.query(q.insertTickets, [JSON.stringify(accepted)]);
}

/**
 * Claims due rows (at most `limit`) and sends them to every device their
 * person has, unless the person turned the category off.
 * @returns {Promise<number>} the rows claimed
 */
async function drainOnce({ limit = DRAIN_LIMIT, now = new Date() } = {}) {
  if (off()) return 0;
  let jobs;
  try {
    ({ rows: jobs } = await db.query(q.claimDue, [limit]));
  } catch (error) {
    if (standDown(error)) return 0;
    throw error;
  }
  if (!jobs.length) return 0;

  const { rows: targets } = await db.query(q.selectTargets, [[...new Set(jobs.map((j) => j.recipient_id))]]);
  const devicesOf = groupBy(targets, 'user_id');
  const skipped = new Map();
  const outgoing = [];
  for (const job of jobs) {
    const devices = devicesOf.get(job.recipient_id) || [];
    const reason = !devices.length ? 'no device'
      : devices[0].is_archived ? 'recipient archived'
        : !devices[0][job.category] ? 'switched off'
          : RECHECKS[job.kind] ? await RECHECKS[job.kind](job, now) : null;
    if (reason) skipped.set(reason, [...(skipped.get(reason) || []), job.job_id]);
    else devices.forEach((d) => outgoing.push({ job, token: d.token, message: messageFor(job, d.token) }));
  }
  for (const [reason, ids] of skipped) await db.query(q.finishSkipped, [ids, reason]);

  // A row's messages never straddle two requests, so one row is sent once.
  let chunk = [];
  for (const job of jobs) {
    const mine = outgoing.filter((o) => o.job === job);
    if (chunk.length + mine.length > expo.BATCH && chunk.length) {
      await sendChunk(chunk);
      chunk = [];
    }
    chunk.push(...mine);
  }
  if (chunk.length) await sendChunk(chunk);
  return jobs.length;
}

/**
 * Every ~15 minutes: Expo's receipts for what was sent. A phone without the
 * app any more loses its device row. Once a day: old rows and stale devices.
 */
async function checkReceipts(now = Date.now()) {
  if (off() || now - lastReceipts < RECEIPTS_EVERY_MS) return;
  lastReceipts = now;
  const { rows } = await db.query(q.selectDueTickets);
  if (rows.length) {
    const receipts = await expo.getReceipts(rows.map((r) => r.ticket_id));
    const gone = [];
    for (const r of rows) {
      const error = receipts[r.ticket_id]?.details?.error;
      if (error === 'DeviceNotRegistered') gone.push(r.token);
      else if (error === 'InvalidCredentials' || error === 'MismatchSenderId') {
        logger.error({ error }, 'Push credentials are wrong: check the APNs key and the FCM service account on EAS');
      } else if (error) logger.warn({ error }, 'Push notification not delivered');
    }
    if (gone.length) await db.query(q.deleteTokens, [gone]);
    const answered = rows.filter((r) => receipts[r.ticket_id]).map((r) => r.ticket_id);
    if (answered.length) await db.query(q.deleteTickets, [answered]);
  }
  if (now - lastHousekeeping >= HOUSEKEEPING_EVERY_MS) {
    lastHousekeeping = now;
    await db.query(q.purgeTickets);
    await db.query(q.purgeJobs);
    await db.query(q.pruneStaleDevices);
  }
}

/** Sends everything due, then the receipts check when it's time. Never overlaps itself; never throws. */
async function drain() {
  if (draining) {
    drainAgain = true;
    return 0;
  }
  draining = true;
  let sent = 0;
  try {
    do {
      drainAgain = false;
      let n;
      do {
        n = await drainOnce();
        sent += n;
      } while (n >= DRAIN_LIMIT);
    } while (drainAgain);
    await checkReceipts();
  } catch (error) {
    if (!standDown(error)) logger.error({ err: error }, 'Push queue drain failed');
  } finally {
    draining = false;
  }
  return sent;
}

/** A row was queued: send now rather than at the next tick (only once the worker runs). */
function kick() {
  if (started && !off()) setImmediate(() => { void drain(); });
}

/** Called by the message notifier's startWorker / stopWorker. */
function start() {
  started = true;
  disabled = null;
  // The first receipts check comes 15 minutes after start, like every later one.
  lastReceipts = Date.now();
}
function stop() {
  started = false;
}

/** Forget all state (tests). */
function resetState() {
  disabled = null;
  started = false;
  draining = false;
  drainAgain = false;
  lastReceipts = 0;
  lastHousekeeping = 0;
}

module.exports = {
  enqueue, run, drain, drainOnce, checkReceipts, kick, start, stop, resetState, isAppPath, preview, MAX_ATTEMPTS, DRAIN_LIMIT,
};
