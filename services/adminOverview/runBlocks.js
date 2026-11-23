// services/adminOverview/runBlocks.js
//
// Runs the admin overview's blocks on a few pooled clients ("lanes"), so one
// page load never takes more than OVERVIEW_CONCURRENCY of the pool's clients
// (12 per Railway server), however many blocks it asks for.
//
// Each lane checks out one client, caps every statement at
// STATEMENT_TIMEOUT_MS, then takes blocks off a shared queue in order and runs
// each block's queries one after another on that client. A block that throws
// (a bad query, a timeout) becomes { error: true } and the lane moves on to
// the next block, so one broken area never blanks the page. On the way out the
// lane resets the timeout and returns the client, or destroys it when the
// reset failed, so a capped session never goes back into the pool.
//
// A lane that can't get a client leaves its blocks to the others. Blocks still
// queued when every lane is done are { error: true }; when no lane got a
// client at all the overview is unavailable (OverviewUnavailableError, a 503).
//
// tasks: [{ key, run: async (q, ctx) => facts }], where q(text, params) runs
// on the lane's client. pool: anything with connect() (pg.Pool), so tests
// pass a fake.

const DEFAULT_CONCURRENCY = 3;
const STATEMENT_TIMEOUT_MS = 4000;

class OverviewUnavailableError extends Error {
  constructor(cause) {
    super('No database client for the admin overview');
    this.name = 'OverviewUnavailableError';
    this.status = 503;
    this.cause = cause;
  }
}

/** OVERVIEW_CONCURRENCY from the environment (a positive whole number), else 3. */
const overviewConcurrency = () => {
  const n = Number.parseInt(process.env.OVERVIEW_CONCURRENCY, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CONCURRENCY;
};

const FAILED = Object.freeze({ error: true });

async function runLane(pool, queue, results, ctx, { timeoutMs, logger }) {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    logger?.warn({ err }, 'Admin overview: could not get a database client');
    return { connected: false, error: err };
  }

  let broken = false;
  try {
    try {
      await client.query(`SET statement_timeout = ${Math.trunc(timeoutMs)}`);
    } catch (err) {
      // A client that can't take a SET is no good for anything: leave the
      // blocks to the other lanes and throw this one away.
      broken = true;
      logger?.warn({ err }, 'Admin overview: could not cap a database client');
      return { connected: false, error: err };
    }

    const q = (text, params) => client.query(text, params);
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        results[task.key] = await task.run(q, ctx);
      } catch (err) {
        results[task.key] = FAILED;
        logger?.warn({ err, block: task.key }, 'Admin overview block failed');
      }
    }
    return { connected: true };
  } finally {
    if (!broken) {
      try {
        await client.query('RESET statement_timeout');
      } catch (err) {
        broken = true;
        logger?.warn({ err }, 'Admin overview: could not reset a database client');
      }
    }
    client.release(broken);
  }
}

/**
 * Runs `tasks` and resolves to { [key]: facts | { error: true } }, one entry
 * per task. Rejects with OverviewUnavailableError when no lane got a client.
 */
async function runBlocks(pool, tasks, ctx, {
  concurrency = overviewConcurrency(),
  timeoutMs = STATEMENT_TIMEOUT_MS,
  logger = null,
} = {}) {
  const results = {};
  if (tasks.length === 0) return results;

  const queue = [...tasks];
  const laneCount = Math.max(1, Math.min(concurrency, tasks.length));
  const lanes = await Promise.all(
    Array.from({ length: laneCount }, () => runLane(pool, queue, results, ctx, { timeoutMs, logger })),
  );

  if (!lanes.some((l) => l.connected)) throw new OverviewUnavailableError(lanes[0]?.error);
  for (const task of tasks) {
    if (!(task.key in results)) results[task.key] = FAILED;
  }
  return results;
}

module.exports = {
  runBlocks,
  overviewConcurrency,
  OverviewUnavailableError,
  DEFAULT_CONCURRENCY,
  STATEMENT_TIMEOUT_MS,
};
