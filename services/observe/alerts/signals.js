// services/observe/alerts/signals.js
//
// What the alert engine watches, kept in memory so it still works when
// Postgres is the thing that's broken (Observe's own event tables lose their
// rows then). Per-minute buckets for the last hour, fed by the same hooks that
// write those tables, plus the latest database probe, self-check, process
// vitals, Railway sample and the slower database-backed readings.
//
// Every note* call is O(1) and bounded, and never throws: it sits on the
// request path and inside the log mirror.
const { monitorEventLoopDelay } = require('perf_hooks');

const MINUTES = 60;
// Response-time buckets (upper bounds, ms); p95 is read off these.
const DUR_EDGES = [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000, Infinity];
const MAX_USERS = 200;
const MAX_ERRORS = 40;
const MAX_EMAILS = 200;

const minuteOf = (ms) => Math.floor(ms / 60000);

let ring = new Map(); // minute -> bucket
const probe = { consecutiveFails: 0, lastError: null, okSince: null, lastAt: null };
const loopback = { consecutiveFails: 0, lastError: null, okSince: null, lastAt: null };
let vitals = null;    // { lagP99Ms, rssMb, at }
let railway = null;   // { available, cpu, memoryGb, deploy, asOf, at }
let slow = null;      // { newErrors, outboxFailed, boots10m, at }
let lagMonitor = null;

function bucket(ms) {
  const m = minuteOf(ms);
  let b = ring.get(m);
  if (!b) {
    b = {
      minute: m,
      req: 0,
      s5xx: 0,
      logged: 0,
      client: 0,
      loginFail: 0,
      dropped: 0,
      dur: new Array(DUR_EDGES.length).fill(0),
      users5xx: new Set(),
      errors: new Map(),          // fingerprint -> { message, count }
      loginFailByEmail: new Map(),
    };
    ring.set(m, b);
    for (const k of ring.keys()) if (k <= m - MINUTES) ring.delete(k);
  }
  return b;
}

const capAdd = (set, value, cap) => {
  if (value && (set.size < cap || set.has(value))) set.add(value);
};

const safe = (fn) => (...args) => {
  try {
    fn(...args);
  } catch {
    /* counting must never break the caller */
  }
};

const noteRequest = safe(({ status, durationMs, userId }, now = Date.now()) => {
  const b = bucket(now);
  b.req += 1;
  if (status >= 500) {
    b.s5xx += 1;
    capAdd(b.users5xx, userId, MAX_USERS);
  }
  const ms = Number(durationMs) || 0;
  b.dur[DUR_EDGES.findIndex((edge) => ms <= edge)] += 1;
});

const noteLoggedError = safe(({ fingerprint, message }, now = Date.now()) => {
  const b = bucket(now);
  b.logged += 1;
  const key = fingerprint || 'unknown';
  const hit = b.errors.get(key);
  if (hit) hit.count += 1;
  else if (b.errors.size < MAX_ERRORS) b.errors.set(key, { message: String(message || '').slice(0, 300), count: 1 });
});

const noteClientError = safe((now = Date.now()) => {
  bucket(now).client += 1;
});

const noteLoginFailure = safe((email, now = Date.now()) => {
  const b = bucket(now);
  b.loginFail += 1;
  const key = String(email || '').trim().toLowerCase();
  if (!key) return;
  if (b.loginFailByEmail.has(key)) b.loginFailByEmail.set(key, b.loginFailByEmail.get(key) + 1);
  else if (b.loginFailByEmail.size < MAX_EMAILS) b.loginFailByEmail.set(key, 1);
});

const noteDropped = safe((rows, now = Date.now()) => {
  if (rows > 0) bucket(now).dropped += rows;
});

function noteCheck(target, ok, error, now) {
  target.lastAt = now;
  if (ok) {
    target.consecutiveFails = 0;
    target.lastError = null;
    if (target.okSince === null) target.okSince = now;
  } else {
    target.consecutiveFails += 1;
    target.lastError = error ? String(error).slice(0, 300) : null;
    target.okSince = null;
  }
}
const noteProbe = (ok, error, now = Date.now()) => noteCheck(probe, ok, error, now);
const noteLoopback = (ok, error, now = Date.now()) => noteCheck(loopback, ok, error, now);

function startVitals() {
  if (lagMonitor) return;
  lagMonitor = monitorEventLoopDelay({ resolution: 20 });
  lagMonitor.enable();
}

/** Reads (and resets) the event-loop delay histogram since the last call. */
function sampleVitals(now = Date.now()) {
  const lagP99Ms = lagMonitor ? Math.round(lagMonitor.percentile(99) / 1e6) : null;
  if (lagMonitor) lagMonitor.reset();
  vitals = { lagP99Ms, rssMb: Math.round(process.memoryUsage().rss / 1048576), at: now };
  return vitals;
}

const setRailway = (sample, now = Date.now()) => {
  railway = sample ? { ...sample, at: now } : null;
};
const setSlow = (reading, now = Date.now()) => {
  slow = reading ? { ...reading, at: now } : null;
};

/** A plain-data copy for the engine: buckets oldest first, last hour only. */
function snapshot(now = Date.now()) {
  const from = minuteOf(now) - MINUTES + 1;
  const buckets = [...ring.values()].filter((b) => b.minute >= from).sort((a, b) => a.minute - b.minute);
  return {
    now,
    buckets,
    probe: { ...probe },
    loopback: { ...loopback },
    vitals,
    railway,
    slow,
  };
}

function reset() {
  ring = new Map();
  Object.assign(probe, { consecutiveFails: 0, lastError: null, okSince: null, lastAt: null });
  Object.assign(loopback, { consecutiveFails: 0, lastError: null, okSince: null, lastAt: null });
  vitals = null;
  railway = null;
  slow = null;
}

module.exports = {
  noteRequest,
  noteLoggedError,
  noteClientError,
  noteLoginFailure,
  noteDropped,
  noteProbe,
  noteLoopback,
  startVitals,
  sampleVitals,
  setRailway,
  setSlow,
  snapshot,
  reset,
  minuteOf,
  DUR_EDGES,
  MINUTES,
};
