// services/reportGeneration/runs.js
//
// Report cards and progress reports generated in the background. Pressing
// Generate queues a run (one item per student) and answers at once; the
// worker (./worker.js) prints the items one at a time with the existing
// generators. The page follows the run through listRuns, from any device,
// and the results wait there until someone dismisses them. Stop drops what
// hasn't started; Try again puts what failed back in the queue.

const db = require('../../config/database');
const q = require('../../queries/reportGeneration.queries');
const { parseReportDate } = require('../kindergartenProgressReport');

const REPORT_TYPES = ['report_card', 'progress_report'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TERM_LENGTH = 100;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// Required lazily: the worker requires this file for finishIfDone.
const kickWorker = () => require('./worker').kick();

const lockKey = (school, reportType, term) => `report_generation:${school}:${reportType}:${term}`;

function checkScope(reportType, term) {
  if (!REPORT_TYPES.includes(reportType)) {
    throw httpError(400, 'Invalid report type. Must be "report_card" or "progress_report"');
  }
  if (typeof term !== 'string' || !term.trim() || term.length > MAX_TERM_LENGTH) {
    throw httpError(400, 'A term is required');
  }
}

const emptyCounts = () => ({ pending: 0, generated: 0, failed: 0, cancelled: 0 });
const COUNTED_AS = { queued: 'pending', printing: 'pending', generated: 'generated', failed: 'failed', cancelled: 'cancelled' };

/** Runs (rows of RUN_COLUMNS) with their items, as the API answers them. */
async function withItems(runRows) {
  if (runRows.length === 0) return [];
  const { rows: itemRows } = await db.query(q.selectItems, [runRows.map((r) => r.run_id)]);
  const byRun = new Map(runRows.map((r) => [r.run_id, []]));
  for (const item of itemRows) byRun.get(item.run_id)?.push(item);
  return runRows.map((r) => {
    const items = byRun.get(r.run_id);
    const counts = emptyCounts();
    for (const item of items) counts[COUNTED_AS[item.status]] += 1;
    return {
      runId: r.run_id,
      reportType: r.report_type,
      term: r.term,
      studentCount: r.student_count,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      createdBy: r.created_by,
      createdByName: r.created_by_name,
      stalled: r.stalled,
      counts,
      items: items.map((i) => ({ studentId: i.student_id, status: i.status, error: i.error, finishedAt: i.finished_at })),
    };
  });
}

async function runsById(runIds, school) {
  const { rows } = await db.query(q.selectRunsById, [runIds, school]);
  return withItems(rows);
}

/**
 * Queues one press of Generate. Students already waiting for this report and
 * term are left where they are; the rest get a new run, in the order given.
 * @returns {Promise<{ run: object|null, alreadyQueued: number }>} run is null
 *   when everyone was waiting already.
 */
async function queueRun({ school, schoolYearId = null, userId = null, reportType, term, studentIds, reportDate }) {
  checkScope(reportType, term);
  if (!Array.isArray(studentIds) || studentIds.length === 0) throw httpError(400, 'Choose at least one student');
  if (!studentIds.every((id) => typeof id === 'string' && UUID.test(id))) throw httpError(400, 'Invalid student id');
  const dated = parseReportDate({ reportDate });
  if (dated.error) throw httpError(400, dated.error);

  const ids = [...new Set(studentIds.map((id) => id.toLowerCase()))];
  const { rows: found } = await db.query(q.selectStudentsInScope, [ids, school, schoolYearId]);
  if (found.length < ids.length) throw httpError(404, 'Student not found');

  const client = await db.connect();
  let runId = null;
  let alreadyQueued = 0;
  try {
    await client.query('BEGIN');
    // A second press for the same report and term waits here until this one
    // commits, then reads its students as waiting (a double click, two tabs).
    await client.query(q.lockRuns, [lockKey(school, reportType, term)]);
    const { rows: waitingRows } = await client.query(q.selectWaitingStudents, [school, reportType, term, ids]);
    const waiting = new Set(waitingRows.map((w) => w.student_id));
    const fresh = ids.filter((id) => !waiting.has(id));
    alreadyQueued = ids.length - fresh.length;
    if (fresh.length > 0) {
      const date = reportType === 'progress_report' ? dated.reportDate : null;
      const { rows: [run] } = await client.query(q.insertRun, [school, schoolYearId, reportType, term, date, fresh.length, userId]);
      runId = run.run_id;
      await client.query(q.insertItems, [runId, fresh]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!runId) return { run: null, alreadyQueued };
  kickWorker();
  const [run] = await runsById([runId], school);
  return { run, alreadyQueued };
}

/** What a page shows for one report type and term, oldest run first. */
async function listRuns({ school, schoolYearId = null, reportType, term }) {
  checkScope(reportType, term);
  const { rows } = await db.query(q.selectListedRuns, [school, schoolYearId, reportType, term]);
  return withItems(rows);
}

/**
 * Sets finished_at once nothing waits. Exactly one caller gets the row,
 * however many finish at once, so the finish email is queued once.
 * @returns {Promise<object|null>}
 */
async function finishIfDone(runId, client = db) {
  const { rows } = await client.query(q.finishRunIfDone, [runId]);
  return rows[0] || null;
}

async function readRun(runId, school) {
  if (!UUID.test(String(runId || ''))) return null;
  const [run] = await runsById([runId], school);
  return run || null;
}

/** Stop: items not printing now are dropped. A report printing now finishes. */
async function cancelRun({ runId, school }) {
  if (!(await readRun(runId, school))) return null;
  await db.query(q.cancelPendingItems, [runId]);
  await finishIfDone(runId);
  return readRun(runId, school);
}

/**
 * Try again: what failed waits again (only `studentIds`, when given: the
 * page sends the students whose latest result is this run's failure). No
 * second finish email (same dedupe key).
 */
async function retryRun({ runId, school, studentIds = null }) {
  if (!UUID.test(String(runId || ''))) return null;
  if (studentIds !== null && (!Array.isArray(studentIds) || !studentIds.every((id) => typeof id === 'string' && UUID.test(id)))) {
    throw httpError(400, 'Invalid student id');
  }
  const only = studentIds === null ? null : studentIds.map((id) => id.toLowerCase());
  const client = await db.connect();
  let requeued = 0;
  try {
    await client.query('BEGIN');
    const { rows: [run] } = await client.query(q.selectRunForUpdate, [runId, school]);
    if (!run) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(q.lockRuns, [lockKey(run.school, run.report_type, run.term)]);
    ({ rowCount: requeued } = await client.query(q.requeueFailedItems, [runId, run.school, run.report_type, run.term, only]));
    if (requeued > 0) await client.query(q.reopenRun, [runId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (requeued > 0) kickWorker();
  return readRun(runId, school);
}

/** Dismiss a finished run's results. A run still going answers 409. */
async function dismissRun({ runId, school }) {
  const run = await readRun(runId, school);
  if (!run) return null;
  if (!run.finishedAt) throw httpError(409, 'This run is still going');
  await db.query(q.dismissRun, [runId]);
  return readRun(runId, school);
}

module.exports = {
  REPORT_TYPES,
  queueRun,
  listRuns,
  finishIfDone,
  cancelRun,
  retryRun,
  dismissRun,
};
