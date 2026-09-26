// services/google/sheetSyncWorker.js
//
// Drains the sheet sync outbox.
//
// Changes enqueue a job row inside the caller's own transaction, so a write
// survives a crash or a restart. This module is what turns those rows into
// actual Sheets writes — a form's tab (kind = 'form') or a school's staff-hours
// spreadsheet (kind = 'staff_hours').
//
// It also owns the nightly refresh of every linked staff-hours sheet: the
// in-progress pay period's assumed-present hours grow each day with no
// database write, so nothing else would ever queue a sync for them.
//
// IMPORTANT: startWorker() must only be called from a real server process (see
// the require.main guard in server.js). Every test suite requires server.js, so
// starting a poller at module load would leave timers running across the suite.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/googleSheets.queries');
const { syncForm } = require('./sheetSyncEngine');
const { syncStaffHours } = require('./staffHoursSyncEngine');
const { NeedsReconnectError } = require('./googleAuth');

const DEFAULT_INTERVAL_MS = 5000;
// With backoff of 4^attempts seconds, six attempts spans roughly an hour —
// long enough to ride out a Google incident, short enough to stop eventually.
const MAX_ATTEMPTS = 6;

let timer = null;
let draining = false;
// Toronto date of the last nightly enqueue. Every tenant is an Ontario
// school, so one clock serves them all.
let lastNightlyDate = null;
// Set when the outbox tables are missing. A worker that cannot possibly
// succeed should say so once and stand down, not log an error every tick.
let disabledReason = null;

// Postgres: relation does not exist.
const UNDEFINED_TABLE = '42P01';

const torontoDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

/** Runs the sync a job asks for. Jobs from before the migration have no kind and are forms. */
const runJob = (job) => (job.kind === 'staff_hours' ? syncStaffHours(job.school) : syncForm(job.form_id));

/**
 * Queue a refresh of every linked staff-hours sheet once per Toronto day.
 * Several server instances may each fire; the outbox's partial unique index
 * collapses them into one job per school.
 *
 * @returns the number of jobs queued
 */
async function enqueueNightlyIfDue(today = torontoDate()) {
  if (today === lastNightlyDate) return 0;
  // Mark first so a database hiccup does not make every tick retry it.
  lastNightlyDate = today;
  const { rows } = await db.query(queries.enqueueNightlyStaffHoursJobs, []);
  if (rows.length > 0) logger.info({ schools: rows.length }, 'Nightly staff hours sheet refresh queued');
  return rows.length;
}

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
      disabledReason = 'google_sheets_sync_migration.sql / staff_hours_sheet_migration.sql has not been applied';
      stopWorker();
      logger.error(
        { migrations: ['google_sheets_sync_migration.sql', 'staff_hours_sheet_migration.sql'] },
        'Sheet sync worker disabled: outbox tables are missing. Apply the migrations and restart.',
      );
      return 0;
    }
    throw error;
  }

  const job = rows[0];
  if (!job) return 0;

  const target = { jobId: job.job_id, kind: job.kind || 'form', formId: job.form_id, school: job.school };
  try {
    await runJob(job);
    await db.query(queries.completeJob, [job.job_id]);
    return 1;
  } catch (error) {
    // A revoked grant will never succeed on retry — only a human reconnecting
    // fixes it, so fail now instead of burning an hour of backoff.
    if (error instanceof NeedsReconnectError || error?.needsReconnect) {
      await db.query(queries.failJobPermanently, [job.job_id, 'Google access needs to be reconnected']);
      logger.warn(target, 'Sheet sync halted: reconnect required');
      return 1;
    }

    await db.query(queries.failJob, [job.job_id, String(error.message || error), MAX_ATTEMPTS]);
    logger.warn({ ...target, attempts: job.attempts, err: error.message }, 'Sheet sync failed; will retry');
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
  // A restart part-way through the day must not re-run the nightly refresh.
  lastNightlyDate = torontoDate();

  timer = setInterval(async () => {
    // Skip a tick rather than overlapping runs; the next one picks up anyway.
    if (draining) return;
    draining = true;
    try {
      if (!disabledReason) await enqueueNightlyIfDue();
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
  enqueueNightlyIfDue,
  MAX_ATTEMPTS,
  isDisabled: () => disabledReason,
  // Test hook: forget the last nightly date.
  _resetNightly: () => { lastNightlyDate = null; },
};
