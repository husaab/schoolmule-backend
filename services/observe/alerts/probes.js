// services/observe/alerts/probes.js
//
// The checks the alert worker runs itself each tick: can we reach the
// database, does this server answer its own /api/health, and the slower
// readings that need the database (new error types, failed queued emails,
// recent restarts). Each returns a result; none throws.
const db = require('../../../config/database');
const { withTimedClient } = require('../timedQuery');
const q = require('../../../queries/observeAlerts.queries');

const PROBE_TIMEOUT_MS = 3000;
const SLOW_TIMEOUT_MS = 5000;

const timeout = (ms, label) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000} s`)), ms).unref());

/** SELECT 1 within 3 s. A pool too busy to hand out a connection counts as down. */
async function probeDb() {
  try {
    await Promise.race([db.query('SELECT 1'), timeout(PROBE_TIMEOUT_MS, 'Database check')]);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message || 'Database check failed' };
  }
}

/** This server's own /api/health over loopback: proof it answers requests. */
async function probeLoopback() {
  const port = process.env.PORT || 4000;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { 'x-alert-self-check': '1' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok ? { ok: true, error: null } : { ok: false, error: `Health check answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message || 'Health check failed' };
  }
}

async function reading(sql, params, pick) {
  try {
    return await withTimedClient(async (run) => pick((await run(sql, params)).rows), SLOW_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** New error types, failed queued emails in the last hour, starts in the last 10 minutes. */
async function slowReadings({ newErrorOccurrences = 2 } = {}) {
  const newErrors = await reading(q.newErrorTypes, [newErrorOccurrences], (rows) =>
    rows.map((r) => ({ fingerprint: r.fingerprint, message: r.message, count: r.count })));
  const outboxFailed = await reading(q.outboxFailed, [], (rows) => rows[0].n);
  const boots10m = await reading(q.bootsSince, [10], (rows) => rows[0].n);
  return { newErrors, outboxFailed, boots10m };
}

module.exports = { probeDb, probeLoopback, slowReadings };
