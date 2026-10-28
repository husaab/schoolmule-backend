// services/observe/alerts/probes.js
//
// The checks the alert worker runs itself each tick: can we reach the
// database, does this server answer its own /api/health, and the slower
// readings that need the database (new error types, failed queued emails,
// recent restarts). Each returns a result; none throws.
const db = require('../../../config/database');
const logger = require('../../../logger');
const { withTimedClient } = require('../timedQuery');
const { withTimeout } = require('./withTimeout');
const q = require('../../../queries/observeAlerts.queries');

const PROBE_TIMEOUT_MS = 3000;
const SLOW_TIMEOUT_MS = 5000;

/** SELECT 1 within 3 s. A pool too busy to hand out a connection counts as down. */
async function probeDb() {
  try {
    await withTimeout(db.query('SELECT 1'), PROBE_TIMEOUT_MS, 'Database check');
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

// A reading that fails is "unknown" (its rule neither trips nor recovers),
// but say so: a silently broken query would switch a rule off for good.
async function reading(what, sql, params, pick) {
  try {
    return await withTimeout(withTimedClient(async (run) => pick((await run(sql, params)).rows), SLOW_TIMEOUT_MS), SLOW_TIMEOUT_MS + 2000, what);
  } catch (err) {
    logger.warn({ observe: true, err: err.message }, `Alerts: reading ${what} failed`);
    return null;
  }
}

/** New error types, failed queued emails in the last hour, starts in the last 10 minutes. */
async function slowReadings({ newErrorOccurrences = 2 } = {}) {
  const newErrors = await reading('new error types', q.newErrorTypes, [newErrorOccurrences], (rows) =>
    rows.map((r) => ({ fingerprint: r.fingerprint, message: r.message, count: r.count })));
  const outboxFailed = await reading('failed outbox emails', q.outboxFailed, [], (rows) => rows[0].n);
  const boots10m = await reading('recent starts', q.bootsSince, [10], (rows) => rows[0].n);
  return { newErrors, outboxFailed, boots10m };
}

module.exports = { probeDb, probeLoopback, slowReadings };
