// services/reportGeneration/worker.js
//
// Prints queued report cards and progress reports (report_generation_items)
// one at a time, with the existing generators, so a report prints exactly as
// it does from the old bulk routes (REPORT_ENGINE, JK/SK, the Al Haadi T2
// variant). Polls every 5 seconds; starting a run or Try again kicks it at
// once.
//
// Runs only where REPORT_GENERATION_WORKER=true, which is set on Railway
// alone: a local backend talks to the production database and must never
// print real reports.
//
// Each claim is a 2-minute lease. A server that dies mid-print lets it run
// out and the student is printed again (upload and row are upserts); after
// 3 claims the student fails. A print that takes over 90 seconds closes the
// browsers and goes back in the queue, so a hung Chromium can't stop it.
// One PDF browser and one report engine session serve many reports: launched
// on the first print, replaced after 50, closed when the queue is empty.
//
// IMPORTANT: startWorker() must only be called from a real server process
// (see the require.main guard in server.js).

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/reportGeneration.queries');
const pdfGenerator = require('../../utils/pdfGenerator');
const reportEngine = require('../reportEngine/generate');
const { finishIfDone } = require('./runs');

const POLL_MS = 5000;
const ITEM_TIMEOUT_MS = 90 * 1000;
const RECYCLE_AFTER = 50;
const MAX_ATTEMPTS = 3;
const GAVE_UP = "Couldn't finish this report. Try again.";
const UNDEFINED_TABLE = '42P01';

let timer = null;
let workerOpts = {};
let draining = null;
let again = false;
let disabledReason = null;

const enabled = () => process.env.REPORT_GENERATION_WORKER === 'true';

/**
 * The browsers a run of prints shares, launched on the first print. After
 * `recycleAfter` prints they're closed and the next print launches fresh.
 */
function createSession({ recycleAfter = RECYCLE_AFTER } = {}) {
  let tools = null;
  let printed = 0;
  const session = {
    /** @returns {Promise<{ browser: object|null, engine: object }>} */
    tools() {
      if (!tools) {
        tools = (async () => {
          let browser = null;
          try {
            browser = await pdfGenerator.launchPDFBrowser();
          } catch (err) {
            // As the bulk routes: each report launches its own instead.
            logger.error({ err }, 'Report generation: the shared PDF browser failed to launch');
          }
          return { browser, engine: reportEngine.reportEngineSession() };
        })();
      }
      return tools;
    },
    async printedOne() {
      printed += 1;
      if (printed >= recycleAfter) await session.close();
    },
    async close() {
      printed = 0;
      if (!tools) return;
      const launching = tools;
      tools = null;
      const { browser, engine } = await launching;
      if (browser) {
        try {
          await browser.close();
        } catch (err) {
          logger.warn({ err }, 'Report generation: failed to close the PDF browser');
        }
      }
      await engine.close();
    },
  };
  return session;
}

/** Prints one student's report with the existing generators. */
async function printReport({ reportType, studentId, term, reportDate }, session) {
  const { browser, engine } = await session.tools();
  if (reportType === 'progress_report') {
    const { generateSingleProgressReport } = require('../../controllers/progressReports.controller');
    return generateSingleProgressReport(studentId, term, { browser, reportDate, engine });
  }
  const { generateSingleReportCard } = require('../../controllers/reportCard.controller');
  return generateSingleReportCard(studentId, term, { browser, engine });
}

class TimedOut extends Error {}

function standDown() {
  disabledReason = 'report_generation_runs_migration.sql has not been applied';
  stopWorker();
  logger.error(
    { migration: 'report_generation_runs_migration.sql' },
    'Report generation worker disabled: its tables are missing. Apply the migration and restart.',
  );
}

async function settle(job, status, error = null) {
  if (status === 'generated') await db.query(q.markItemGenerated, [job.run_id, job.student_id]);
  else await db.query(q.markItemFailed, [job.run_id, job.student_id, error]);
  return finishIfDone(job.run_id);
}

/**
 * Prints the next queued student, if any.
 * @param session  createSession(): the browsers to print with
 * @param opts     { timeoutMs, print } (tests)
 * @returns {Promise<0|1>} 0 when nothing was waiting (the session is closed)
 */
async function drainOnce(session, { timeoutMs = ITEM_TIMEOUT_MS, print = printReport } = {}) {
  if (disabledReason) return 0;

  let job;
  try {
    ({ rows: [job] } = await db.query(q.claimNextItem));
  } catch (error) {
    if (error?.code === UNDEFINED_TABLE) {
      standDown();
      return 0;
    }
    throw error;
  }
  if (!job) {
    await session.close();
    return 0;
  }
  await db.query(q.markRunServed, [job.run_id]);

  const target = { runId: job.run_id, studentId: job.student_id, reportType: job.report_type, term: job.term };
  if (job.attempts > MAX_ATTEMPTS) {
    logger.error({ ...target, attempts: job.attempts }, 'Report generation: gave up on a report after repeated lost leases');
    await settle(job, 'failed', GAVE_UP);
    return 1;
  }

  let clock = null;
  try {
    const printing = Promise.resolve().then(() => print({
      reportType: job.report_type, studentId: job.student_id, term: job.term, reportDate: job.report_date,
    }, session));
    // A hung print that rejects once its browser closes must not surface later.
    printing.catch(() => {});
    const timeout = new Promise((resolve, reject) => { clock = setTimeout(() => reject(new TimedOut()), timeoutMs); });
    await Promise.race([printing, timeout]);
    await settle(job, 'generated');
  } catch (error) {
    if (error instanceof TimedOut) {
      logger.error({ ...target, timeoutMs }, 'Report generation: a report took too long; closing the browsers and trying it again');
      await session.close();
      await db.query(q.releaseItem, [job.run_id, job.student_id]);
      return 1;
    }
    logger.warn({ ...target, err: error }, "Report generation: couldn't make a report");
    await settle(job, 'failed', error?.message || 'Unknown error');
  } finally {
    clearTimeout(clock);
  }
  await session.printedOne();
  return 1;
}

/** Prints until nothing is waiting, sharing one session; closes it after. */
async function drainAll({ recycleAfter, ...opts } = {}) {
  const session = createSession({ recycleAfter });
  let handled = 0;
  try {
    for (;;) {
      const n = await drainOnce(session, opts);
      if (n === 0) break;
      handled += n;
    }
  } finally {
    await session.close();
  }
  return handled;
}

/** One tick. A kick during a drain makes that drain look once more. */
function tick() {
  if (draining) {
    again = true;
    return draining;
  }
  draining = (async () => {
    try {
      do {
        again = false;
        await drainAll(workerOpts);
      } while (again && !disabledReason);
    } catch (error) {
      // Never let a worker error take the process down.
      logger.error({ err: error }, 'Report generation worker tick failed');
    } finally {
      draining = null;
    }
  })();
  return draining;
}

/** @param opts  { print, timeoutMs, recycleAfter } (tests) */
function startWorker(intervalMs = POLL_MS, opts = {}) {
  if (timer) return;
  if (!enabled()) {
    logger.info('Report generation worker not started: REPORT_GENERATION_WORKER is not true');
    return;
  }
  disabledReason = null;
  workerOpts = opts;
  timer = setInterval(tick, intervalMs);
  // Don't hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ intervalMs }, 'Report generation worker started');
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Prints now rather than at the next tick (a run was just queued). Never
 * throws; a no-op without a running worker.
 * @returns {Promise<void>|undefined} the drain, for tests
 */
function kick() {
  if (!timer) return undefined;
  return tick();
}

const isRunning = () => timer !== null;

/** Clears the stand-down and test options (tests). */
function resetWorkerState() {
  disabledReason = null;
  workerOpts = {};
  again = false;
}

module.exports = {
  MAX_ATTEMPTS,
  GAVE_UP,
  startWorker,
  stopWorker,
  kick,
  isRunning,
  createSession,
  drainOnce,
  drainAll,
  resetWorkerState,
};
