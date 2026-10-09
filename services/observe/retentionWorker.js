// Deletes observe rows older than OBSERVE_RETENTION_DAYS (default 90) once
// a day, in bounded batches so a long-neglected table never locks for long.
const db = require('../../config/database');
const logger = require('../../logger');

const TABLES = ['request_events', 'error_events', 'client_events', 'login_events'];
const RETENTION_DAYS_DEFAULT = 90;
const BATCH = 10000;
const CHECK_MS = 60 * 60 * 1000;

let timer = null;
let lastSweepDate = null;
let sweeping = false;

const torontoDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

function retentionDays() {
  const n = parseInt(process.env.OBSERVE_RETENTION_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : RETENTION_DAYS_DEFAULT;
}

async function sweepOnce(days = retentionDays()) {
  const deleted = {};
  const errors = [];
  for (const table of TABLES) {
    deleted[table] = 0;
    try {
      for (;;) {
        const { rowCount } = await db.query(
          `DELETE FROM ${table} WHERE event_id IN (SELECT event_id FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval ORDER BY ts LIMIT ${BATCH})`,
          [days]
        );
        deleted[table] += rowCount || 0;
        if (!rowCount || rowCount < BATCH) break;
      }
    } catch (err) {
      errors.push({ table, message: err.message });
      logger.warn({ observe: true, err, table }, 'observe: retention sweep failed');
    }
  }
  return { deleted, errors };
}

function startWorker(intervalMs = CHECK_MS) {
  if (timer) return;
  timer = setInterval(async () => {
    if (sweeping) return;
    const today = torontoDate();
    if (lastSweepDate === today) return;
    sweeping = true;
    try {
      const result = await sweepOnce();
      lastSweepDate = today;
      logger.info({ observe: true, ...result.deleted }, 'observe: retention sweep complete');
    } catch (err) {
      logger.warn({ observe: true, err }, 'observe: retention tick failed');
    } finally {
      sweeping = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startWorker, stopWorker, sweepOnce, RETENTION_DAYS_DEFAULT, TABLES };
