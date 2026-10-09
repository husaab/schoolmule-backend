// In-memory batch writer for the observe tables. Capture code calls push()
// and forgets; rows reach Postgres on a timer or when a batch fills.
// Nothing here may throw into a request, and a dead database only costs
// observability, never availability.
const db = require('../../config/database');
const logger = require('../../logger');

const TABLES = {
  request_events: ['ts', 'request_id', 'user_id', 'school', 'role', 'impersonator_id', 'method', 'route', 'path', 'status', 'duration_ms', 'ip', 'user_agent', 'error_message'],
  error_events: ['ts', 'source', 'request_id', 'user_id', 'school', 'route', 'message', 'stack', 'fingerprint', 'context'],
  client_events: ['ts', 'user_id', 'school', 'role', 'kind', 'message', 'stack', 'page', 'user_agent', 'request_id', 'status', 'fingerprint'],
  login_events: ['ts', 'email', 'user_id', 'school', 'outcome', 'ip', 'user_agent'],
};
const JSON_COLUMNS = new Set(['context']);

const FLUSH_MS = 2000;
const BATCH = 200;
const CAP = 2000;

const buffers = Object.fromEntries(Object.keys(TABLES).map((t) => [t, []]));
let timer = null;
let flushing = false;
let immediate = null;
const counters = { dropped: 0, flushes: 0, failures: 0 };

const isDisabled = () => process.env.OBSERVE_DISABLED === 'true';

function pending() {
  return Object.values(buffers).reduce((n, b) => n + b.length, 0);
}

function scheduleImmediate() {
  if (immediate) return;
  immediate = setImmediate(() => {
    immediate = null;
    flushNow().catch(() => {});
  });
}

function push(table, row) {
  if (isDisabled() || !TABLES[table]) return false;
  const buf = buffers[table];
  if (buf.length >= CAP) {
    buf.shift();
    counters.dropped += 1;
  }
  buf.push({ ts: new Date(), ...row });
  if (buf.length >= BATCH) scheduleImmediate();
  return true;
}

function buildInsert(table, rows) {
  const cols = TABLES[table];
  const values = [];
  const tuples = rows.map((row, i) => {
    const placeholders = cols.map((col, j) => {
      let v = row[col];
      if (v === undefined) v = null;
      if (JSON_COLUMNS.has(col) && v !== null) v = JSON.stringify(v);
      // Postgres text rejects NUL, and one rejected row fails the whole batch.
      if (typeof v === 'string') v = v.replace(/\u0000/g, '');
      values.push(v);
      return `$${i * cols.length + j + 1}`;
    });
    return `(${placeholders.join(',')})`;
  });
  return { text: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, values };
}

async function flushNow() {
  if (flushing) return;
  flushing = true;
  try {
    for (const table of Object.keys(TABLES)) {
      while (buffers[table].length > 0) {
        const rows = buffers[table].splice(0, BATCH);
        const { text, values } = buildInsert(table, rows);
        try {
          await db.query(text, values);
          counters.flushes += 1;
        } catch (err) {
          counters.failures += 1;
          // A bad value (SQLSTATE class 22, e.g. a number out of range) in
          // one row must not cost everyone else's rows: retry them one by
          // one. Any other failure means the database itself is down, so
          // don't hammer it.
          if (typeof err?.code === 'string' && err.code.startsWith('22') && rows.length > 1) {
            let kept = 0;
            for (const row of rows) {
              const single = buildInsert(table, [row]);
              try {
                await db.query(single.text, single.values);
                kept += 1;
              } catch {
                // this row is the bad one
              }
            }
            logger.warn({ observe: true, err, table, rows: rows.length, kept }, 'observe: batch had a bad row; retried one by one');
            continue;
          }
          // warn, not error: the log mirror only listens to error lines, so
          // a failing database can never feed itself more rows.
          logger.warn({ observe: true, err, table, rows: rows.length }, 'observe: flush failed; rows dropped');
        }
      }
    }
  } finally {
    flushing = false;
  }
}

function start(intervalMs = FLUSH_MS) {
  if (timer) return;
  timer = setInterval(() => {
    flushNow().catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (immediate) {
    clearImmediate(immediate);
    immediate = null;
  }
}

function stats() {
  return { pending: pending(), ...counters };
}

module.exports = { push, flushNow, start, stop, pending, stats, buildInsert, TABLES, FLUSH_MS, BATCH, CAP };
