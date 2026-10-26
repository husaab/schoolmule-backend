// services/schedulePlanner/goLiveWorker.js
//
// Publishes drafts on their go-live date ("Copy with new times" → winter bell
// times from Mon Nov 2). Every few minutes it claims drafts whose go_live_on
// has arrived in America/Toronto (SKIP LOCKED, so several server instances
// stay idempotent) and runs the same publish transaction as the Publish
// button. A failure is retried on later ticks for about three hours, enough to
// ride out a database blip at midnight; after that, or when the draft can't be
// published at all (empty), it is marked 'failed' and the planner card shows
// the reason with a Retry.
//
// IMPORTANT: startWorker() must only be called from a real server process
// (see the require.main guard in server.js).

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/schedulePlanner.queries');
const { publishScheduleTx, PublishError } = require('./publishTx');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const CLAIM_LIMIT = 5;
const MAX_ATTEMPTS = 36; // 3 hours of 5-minute ticks
const UNDEFINED_COLUMN = '42703';

let timer = null;
let running = false;

async function goLive(row) {
  const target = { scheduleId: row.schedule_id, school: row.school };
  const client = await db.connect();
  try {
    await publishScheduleTx(client, target);
    logger.info({ ...target, goLiveOn: row.go_live_on, name: row.name }, 'Scheduled schedule went live');
    return true;
  } catch (error) {
    const final = error instanceof PublishError || row.go_live_attempts >= MAX_ATTEMPTS;
    try {
      await db.query(q.recordGoLiveFailure, [row.schedule_id, final ? 'failed' : 'pending', error.message]);
    } catch (recordError) {
      // Left 'running'; the stale reset hands it back in 15 minutes.
      logger.error({ err: recordError, ...target }, 'Could not record the go-live failure');
    }
    logger.error(
      { err: error, ...target, attempts: row.go_live_attempts },
      final ? 'Scheduled go-live failed; gave up' : 'Scheduled go-live failed; will retry'
    );
    return false;
  } finally {
    client.release();
  }
}

/** One tick: hand back stale claims, then publish whatever is due. */
async function runOnce() {
  await db.query(q.resetStaleGoLive);
  const { rows } = await db.query(q.claimDueGoLive, [CLAIM_LIMIT]);
  let published = 0;
  for (const row of rows) if (await goLive(row)) published++;
  return { claimed: rows.length, published };
}

function startWorker(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      if (error?.code === UNDEFINED_COLUMN) {
        stopWorker();
        logger.error('Schedule go-live worker disabled: apply schedule_planner_v8_bell_times_migration.sql and restart.');
      } else {
        logger.error({ err: error }, 'Schedule go-live worker tick failed');
      }
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  // A restart just after midnight shouldn't wait a full interval.
  setImmediate(tick);
  logger.info({ intervalMs }, 'Schedule go-live worker started');
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startWorker, stopWorker, runOnce };
