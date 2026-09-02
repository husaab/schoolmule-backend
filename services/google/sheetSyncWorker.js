// services/google/sheetSyncWorker.js
//
// Drains the sheet sync outbox.
//
// Changes enqueue a job row inside the caller's own transaction, so a write
// survives a crash or a restart. This module is what turns those rows into
// actual Sheets writes.
//
// IMPORTANT: startWorker() must only be called from a real server process (see
// the require.main guard in server.js). Every test suite requires server.js, so
// starting a poller at module load would leave timers running across the suite.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/googleSheets.queries');
const { syncForm } = require('./sheetSyncEngine');
const { NeedsReconnectError } = require('./googleAuth');

const DEFAULT_INTERVAL_MS = 5000;
// With backoff of 4^attempts seconds, six attempts spans roughly an hour —
// long enough to ride out a Google incident, short enough to stop eventually.
const MAX_ATTEMPTS = 6;

let timer = null;
let draining = false;
// Set when the outbox tables are missing. A worker that cannot possibly
// succeed should say so once and stand down, not log an error every tick.
let disabledReason = null;

// Postgres: relation does not exist.
const UNDEFINED_TABLE = '42P01';

/**
 * Process one job, if any is due.
 * @returns the number of jobs handled (0 or 1)
 */
async function drainOnce() {
  if (disabledReason) return 0;

  let rows;
  try {
    ({ rows } = await db.query(queries.claimNextJob, []));
  } catch (error) {
    if (error?.code === UNDEFINED_TABLE) {
      // The sheets migration has not been applied to this database. Stop
      // rather than repeating this every 5 seconds; a restart after the
      // migration brings the worker back.
      disabledReason = 'google_sheets_sync_migration.sql has not been applied';
      stopWorker();
      logger.error(
        { migration: 'google_sheets_sync_migration.sql' },
        'Sheet sync worker disabled: outbox tables are missing. Apply the migration and restart.',
      );
      return 0;
    }
    throw error;
  }

  const job = rows[0];
  if (!job) return 0;

  try {
    await syncForm(job.form_id);
    await db.query(queries.completeJob, [job.job_id]);
    return 1;
  } catch (error) {
    // A revoked grant will never succeed on retry — only a human reconnecting
    // fixes it, so fail now instead of burning an hour of backoff.
    if (error instanceof NeedsReconnectError || error?.needsReconnect) {
      await db.query(queries.failJobPermanently, [job.job_id, 'Google access needs to be reconnected']);
      logger.warn({ formId: job.form_id }, 'Sheet sync halted: reconnect required');
      return 1;
    }

    await db.query(queries.failJob, [job.job_id, String(error.message || error), MAX_ATTEMPTS]);
    logger.warn(
      { formId: job.form_id, attempts: job.attempts, err: error.message },
      'Sheet sync failed; will retry',
    );
    return 1;
  }
}

/** Drains until the queue is empty, so a backlog clears in one tick. */
async function drainAll(limit = 25) {
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

  // Nothing to sync if the integration was never configured, so don't poll at
  // all. Saves a query every 5s on deployments that don't use the feature.
  if (!process.env.GOOGLE_CLIENT_ID) {
    logger.info('Sheet sync worker not started: Google OAuth is not configured');
    return;
  }

  disabledReason = null;

  timer = setInterval(async () => {
    // Skip a tick rather than overlapping runs; the next one picks up anyway.
    if (draining) return;
    draining = true;
    try {
      await drainAll();
    } catch (error) {
      // Never let a worker error take the process down.
      logger.error({ err: error }, 'Sheet sync worker tick failed');
    } finally {
      draining = false;
    }
  }, intervalMs);

  // Don't hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ intervalMs }, 'Sheet sync worker started');
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
  MAX_ATTEMPTS,
  isDisabled: () => disabledReason,
};
