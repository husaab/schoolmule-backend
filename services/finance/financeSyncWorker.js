// services/finance/financeSyncWorker.js
//
// Drains the QuickBooks sync outbox. Same shape as the Google Sheets worker:
// a job row per school is claimed with SKIP LOCKED, run, and deleted; a
// failure is requeued with exponential backoff; a dead grant fails the job
// permanently until an admin reconnects.
//
// The 15-minute schedule is SQL-side (enqueueDueJobs) so several server
// instances stay idempotent, and once per Toronto day old runs are pruned.
//
// IMPORTANT: startWorker() must only be called from a real server process
// (see the require.main guard in server.js).

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/finance.queries');
const { runSync } = require('./qboSync');

const DEFAULT_INTERVAL_MS = 5000;
// 4^attempts seconds over six attempts spans roughly an hour.
const MAX_ATTEMPTS = 6;
const UNDEFINED_TABLE = '42P01';

let timer = null;
let draining = false;
let lastDailyDate = null;
let disabledReason = null;

const torontoDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

/** Queue a job for every connection whose last success is older than the interval. */
async function enqueueDueJobs() {
  const { rows } = await db.query(queries.enqueueDueJobs, []);
  if (rows.length > 0) logger.debug({ jobs: rows.length }, 'QuickBooks sync jobs queued');
  return rows.length;
}

/** Once per Toronto day: prune old runs and clear stale alert markers. */
async function runDailyIfDue(today = torontoDate()) {
  if (today === lastDailyDate) return false;
  lastDailyDate = today;
  await db.query(queries.pruneRuns, []);
  await db.query(queries.pruneFailedJobs, []);
  await db.query(queries.failOrphanedRuns, []);
  await db.query(queries.clearStaleAlerts, []);
  return true;
}

async function drainOnce() {
  if (disabledReason) return 0;

  let rows;
  try {
    ({ rows } = await db.query(queries.claimNextJob, []));
  } catch (error) {
    if (error?.code === UNDEFINED_TABLE) {
      disabledReason = 'finance_qbo_migration.sql has not been applied';
      stopWorker();
      logger.error({ migration: 'finance_qbo_migration.sql' }, 'QuickBooks sync worker disabled: tables are missing. Apply the migration and restart.');
      return 0;
    }
    throw error;
  }

  const job = rows[0];
  if (!job) return 0;

  const target = { jobId: job.job_id, kind: job.kind, school: job.school };
  try {
    await runSync(job.school, { kind: job.kind, jobId: job.job_id, triggeredBy: job.requested_by || null });
    await db.query(queries.completeJob, [job.job_id]);
    return 1;
  } catch (error) {
    if (error?.needsReconnect) {
      await db.query(queries.failJobPermanently, [job.job_id, 'QuickBooks access needs to be reconnected']);
      logger.warn(target, 'QuickBooks sync halted: reconnect required');
      return 1;
    }
    await db.query(queries.failJob, [job.job_id, String(error.message || error), MAX_ATTEMPTS]);
    logger.warn({ ...target, attempts: job.attempts, err: error.message }, 'QuickBooks sync failed; will retry');
    return 1;
  }
}

async function drainAll(limit = 10) {
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
  if (!process.env.QBO_CLIENT_ID) {
    logger.info('QuickBooks sync worker not started: QBO OAuth is not configured');
    return;
  }
  disabledReason = null;
  lastDailyDate = torontoDate();

  timer = setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      if (!disabledReason) {
        await runDailyIfDue();
        await enqueueDueJobs();
      }
      await drainAll();
    } catch (error) {
      if (error?.code === UNDEFINED_TABLE && !disabledReason) {
        disabledReason = 'finance_qbo_migration.sql has not been applied';
        stopWorker();
        logger.error('QuickBooks sync worker disabled: tables are missing. Apply the migration and restart.');
      } else {
        logger.error({ err: error }, 'QuickBooks sync worker tick failed');
      }
    } finally {
      draining = false;
    }
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ intervalMs }, 'QuickBooks sync worker started');
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startWorker,
  stopWorker,
  drainOnce,
  drainAll,
  enqueueDueJobs,
  runDailyIfDue,
  MAX_ATTEMPTS,
  isDisabled: () => disabledReason,
  _resetForTests: () => { disabledReason = null; lastDailyDate = null; },
};
