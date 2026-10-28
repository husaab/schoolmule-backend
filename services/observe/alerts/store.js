// services/observe/alerts/store.js
//
// Where the alert worker keeps incidents, the notification log and the
// owner's rule settings. Postgres is the truth whenever it answers: each tick
// loads the open incident from it, so a redeploy (or a second replica) picks
// up the same incident. When it doesn't answer, the worker carries on from
// the copy kept here and writes it back once the database returns. Alerting
// about a database outage must not depend on that database.
//
// The worker tells the store whether this tick may touch the database
// (setDbAvailable); a call that can't reach it flips it to memory too. A
// call the database refuses (a constraint, bad data) is not an outage: that
// row is dropped or merged and everything else carries on.
const db = require('../../../config/database');
const logger = require('../../../logger');
const q = require('../../../queries/observeAlerts.queries');
const { owesRecovery, owesSummary, mergeIncidents } = require('./engine');
const { withTimeout } = require('./withTimeout');

const UNDEFINED_TABLE = '42P01';
const UNIQUE_VIOLATION = '23505';
const DB_TIMEOUT_MS = 10 * 1000;
const MAX_QUEUED_LOGS = 200;
const HOUR_MS = 60 * 60 * 1000;

let dbAvailable = false;
let missing = false;            // migration not applied: the worker stands down
let open = null;                // the open incident
let recent = [];                // resolved in the last day, newest first
const dirty = new Set();        // incident ids changed while the database was away
let queuedLogs = [];            // notification rows not yet written
let sentEmails = [];            // send times, this process (the hourly cap)
let overrides = {};             // last known rule overrides
let strayOpen = null;           // an open incident from memory the database already had one for

const ms = (v) => (v ? new Date(v).getTime() : null);
const at = (v) => (v === null || v === undefined ? null : new Date(v));

function fromRow(r) {
  return {
    id: r.incident_id,
    status: r.status,
    tier: r.tier,
    title: r.title,
    subject: r.subject,
    openedAt: ms(r.opened_at),
    lastTripAt: ms(r.last_trip_at),
    resolvedAt: ms(r.resolved_at),
    reopenCount: r.reopen_count,
    notifiedAt: ms(r.notified_at),
    notifiedTier: r.notified_tier,
    lastReminderAt: ms(r.last_reminder_at),
    reopenPending: r.reopen_pending,
    recoveredNotifiedAt: ms(r.recovered_notified_at),
    summarizedAt: ms(r.summarized_at),
    rules: r.rules || {},
    stats: r.stats || {},
  };
}

const rowParams = (i) => [
  i.id, i.status, i.tier, i.title, i.subject, at(i.openedAt), at(i.lastTripAt), at(i.resolvedAt), i.reopenCount,
  at(i.notifiedAt), i.notifiedTier, at(i.lastReminderAt), i.reopenPending, at(i.recoveredNotifiedAt), at(i.summarizedAt),
  JSON.stringify(i.rules), JSON.stringify(i.stats),
];

// Integrity (23) and data (22) errors: the database is up and said no.
const refused = (err) => Boolean(err && typeof err.code === 'string' && /^2[23]/.test(err.code));

/**
 * Runs `fn` against the database (10 s at most) if it's usable this tick.
 * @returns {Promise<{ ok: true, value: any } | { ok: false, refused?: Error }>}
 * `force` tries anyway: a console request has just used the database.
 */
async function runDb(what, fn, { force = false } = {}) {
  if ((!dbAvailable && !force) || missing) return { ok: false };
  try {
    return { ok: true, value: await withTimeout(fn(), DB_TIMEOUT_MS, what) };
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) {
      missing = true;
      return { ok: false };
    }
    if (refused(err)) {
      logger.warn({ observe: true, err: err.message, code: err.code }, `Alerts: ${what} refused`);
      return { ok: false, refused: err };
    }
    dbAvailable = false;
    logger.warn({ observe: true, err: err && err.message }, `Alerts: ${what} failed; carrying on from memory`);
    return { ok: false };
  }
}

/** runDb for callers that only need the value (null when it didn't run). */
async function viaDb(what, fn, opts) {
  const r = await runDb(what, fn, opts);
  return r.ok ? r.value : null;
}

function setDbAvailable(ok) {
  dbAvailable = Boolean(ok);
}

const isMissing = () => missing;

/** The resolved incidents (last 24 hours) that still owe an email. */
const owedOf = (list, now) => list.filter((i) => now - i.resolvedAt < 24 * HOUR_MS && (owesRecovery(i) || owesSummary(i)));

/** What the engine needs this tick: { open, lastResolved, owed }. */
function current(now) {
  return { open, lastResolved: recent[0] || null, owed: owedOf(recent, now) };
}

/**
 * Writes back anything changed while the database was away, then reloads.
 * A no-op (memory stays as it is) when the database isn't usable.
 */
async function sync() {
  // Resolved ones first: the open one may have replaced one of them, and the
  // database allows a single open incident.
  for (const inc of [...recent, open].filter((i) => i && dirty.has(i.id))) {
    const r = await runDb('writing back an incident', () => db.query(q.upsertIncident, rowParams(inc)));
    if (!r.ok && !r.refused) return;
    dirty.delete(inc.id);
    // Opened here while the database was away, but it already has one open
    // (ours from before a restart, or another replica's): fold into that.
    if (r.refused && r.refused.code === UNIQUE_VIOLATION && inc.status === 'open') strayOpen = inc;
  }
  if (queuedLogs.length) {
    const pending = queuedLogs;
    queuedLogs = [];
    for (let i = 0; i < pending.length; i += 1) {
      const r = await runDb('writing the notification log', () => db.query(q.insertNotification, pending[i]));
      // A refused row (its incident was deleted meanwhile) is dropped.
      if (!r.ok && !r.refused) {
        queuedLogs = [...pending.slice(i), ...queuedLogs].slice(-MAX_QUEUED_LOGS);
        return;
      }
    }
  }
  const res = await viaDb('loading incidents', () => db.query(q.loadRecent));
  if (!res) return;
  const rows = res.rows.map(fromRow);
  open = rows.find((i) => i.status === 'open') || null;
  recent = rows.filter((i) => i.status === 'resolved').sort((a, b) => b.resolvedAt - a.resolvedAt);
  if (strayOpen) {
    const stray = strayOpen;
    strayOpen = null;
    // The other one may have resolved meanwhile; then ours is written next tick.
    open = open ? mergeIncidents(open, stray) : stray;
    dirty.add(open.id);
    logger.warn({ observe: true, kept: open.id, merged: stray.id }, 'Alerts: merged an incident opened while the database was away');
  }
}

/** Saves the engine's new view of the open incident and/or a just-resolved one. */
async function save({ open: nextOpen, resolved }) {
  if (resolved) recent = [resolved, ...recent.filter((i) => i.id !== resolved.id)];
  if (nextOpen) recent = recent.filter((i) => i.id !== nextOpen.id);
  open = nextOpen;
  for (const inc of [resolved, nextOpen].filter(Boolean)) {
    const ok = await viaDb('saving an incident', () => db.query(q.upsertIncident, rowParams(inc)));
    if (ok === null) dirty.add(inc.id);
  }
}

const findIncident = (id) => (open && open.id === id ? open : recent.find((i) => i.id === id)) || null;

function patchIncident(id, fields) {
  if (open && open.id === id) open = { ...open, ...fields };
  recent = recent.map((i) => (i.id === id ? { ...i, ...fields } : i));
}

// kind -> how to claim it, what it sets, and how to hand it back.
const CLAIMS = {
  opened: {
    sql: q.claimOpened,
    params: (inc, now, subject) => [inc.id, at(now), inc.tier, subject],
    fields: (inc, now, subject) => ({ notifiedAt: now, notifiedTier: inc.tier, subject: inc.subject || subject }),
    release: (inc) => [q.releaseOpened, [inc.id], { notifiedAt: null, notifiedTier: null }],
  },
  escalated: {
    sql: q.claimEscalated,
    params: (inc) => [inc.id],
    fields: () => ({ notifiedTier: 'critical' }),
    release: (inc) => [q.releaseEscalated, [inc.id, inc.notifiedTier], { notifiedTier: inc.notifiedTier }],
  },
  reminder: {
    sql: q.claimReminder,
    params: (inc, now) => [inc.id, at(now)],
    fields: (inc, now) => ({ lastReminderAt: now }),
    release: (inc) => [q.releaseReminder, [inc.id, at(inc.lastReminderAt)], { lastReminderAt: inc.lastReminderAt }],
  },
  reopened: {
    sql: q.claimReopened,
    params: (inc, now) => [inc.id, at(now)],
    fields: (inc, now) => ({ reopenPending: false, lastReminderAt: now }),
    release: (inc) => [q.releaseReopened, [inc.id, at(inc.lastReminderAt)], { reopenPending: true, lastReminderAt: inc.lastReminderAt }],
  },
  recovered: {
    sql: q.claimRecovered,
    params: (inc, now) => [inc.id, at(now)],
    fields: (inc, now) => ({ recoveredNotifiedAt: now }),
    release: (inc) => [q.releaseRecovered, [inc.id], { recoveredNotifiedAt: null }],
  },
};

/**
 * Claims the right to send `kind` for an incident. Only one replica gets it
 * while the database answers; without it, this process decides alone.
 * @returns {Promise<{ subject: string, release: () => Promise<void> } | null>}
 *   the thread's subject and a way to hand the claim back; null when someone else has it
 */
async function claim(kind, inc, now, subject) {
  const spec = CLAIMS[kind];
  const before = findIncident(inc.id) || inc;
  const res = await viaDb(`claiming the ${kind} email`, () => db.query(spec.sql, spec.params(inc, now, subject)));
  if (res && res.rowCount === 0) return null;
  const fields = spec.fields(before, now, subject);
  if (res && res.rows[0] && res.rows[0].subject) fields.subject = res.rows[0].subject;
  patchIncident(inc.id, fields);
  if (!res) dirty.add(inc.id);
  return {
    subject: fields.subject || before.subject || subject,
    release: async () => {
      const [sql, params, revert] = spec.release(before);
      patchIncident(inc.id, revert);
      const ok = await viaDb(`releasing the ${kind} claim`, () => db.query(sql, params));
      if (ok === null) dirty.add(inc.id);
    },
  };
}

/** Claims the morning summary for these incidents; returns the ones this process sends. */
async function claimSummary(incidents, now) {
  const ids = incidents.map((i) => i.id);
  const res = await viaDb('claiming the summary', () => db.query(q.claimSummary, [ids, at(now)]));
  const mine = res ? new Set(res.rows.map((r) => r.incident_id)) : new Set(ids);
  for (const id of mine) {
    patchIncident(id, { summarizedAt: now });
    if (!res) dirty.add(id);
  }
  const claimed = incidents.filter((i) => mine.has(i.id));
  return {
    incidents: claimed,
    release: async () => {
      for (const i of claimed) patchIncident(i.id, { summarizedAt: null });
      const ok = await viaDb('releasing the summary claim', () => db.query(q.releaseSummary, [claimed.map((i) => i.id)]));
      if (ok === null) claimed.forEach((i) => dirty.add(i.id));
    },
  };
}

/**
 * Records an email or push attempt (queued while the database is away).
 * `force` writes it even outside a worker tick (the console's test send).
 */
async function logNotification({ incidentId = null, channel, kind, ok, recipients = 0, subject = null, error = null, now = Date.now() }, { force = false } = {}) {
  if (channel === 'email' && ok) sentEmails.push(now);
  const row = [incidentId, at(now), channel, kind, ok, recipients, subject, error ? String(error).slice(0, 500) : null];
  const res = await viaDb('writing the notification log', () => db.query(q.insertNotification, row), { force });
  if (res === null) queuedLogs = [...queuedLogs, row].slice(-MAX_QUEUED_LOGS);
}

/** Alert emails sent in the last hour, by every replica when the database answers. */
async function emailsLastHour(now) {
  sentEmails = sentEmails.filter((t) => now - t < HOUR_MS);
  const res = await viaDb('counting sent emails', () => db.query(q.emailsSince, [at(now - HOUR_MS)]));
  return Math.max(sentEmails.length, res ? res.rows[0].n : 0);
}

/** alert_rule_overrides rows keyed by rule id (also used by the console). */
const overridesFromRows = (rows) => Object.fromEntries(rows.map((r) => [r.rule_id, r]));

/** Rule overrides keyed by rule id; the last known set when the database is away. */
async function loadOverrides() {
  const res = await viaDb('loading rule settings', () => db.query(q.overrides));
  if (res) overrides = overridesFromRows(res.rows);
  return overrides;
}

async function recordTrips(trips, now) {
  for (const t of trips) {
    await viaDb('recording a rule trip', () => db.query(q.insertTrip, [t.ruleId, at(now), t.mode, t.value, t.summary]));
  }
}

async function recordBoot() {
  await viaDb('recording the boot', () => db.query(q.insertBoot));
}

async function prune() {
  await viaDb('pruning old alert rows', () => db.query(q.prune));
}

function reset() {
  dbAvailable = false;
  missing = false;
  open = null;
  recent = [];
  dirty.clear();
  queuedLogs = [];
  sentEmails = [];
  overrides = {};
  strayOpen = null;
}

module.exports = {
  setDbAvailable,
  isMissing,
  current,
  sync,
  save,
  claim,
  claimSummary,
  logNotification,
  emailsLastHour,
  loadOverrides,
  recordTrips,
  recordBoot,
  prune,
  fromRow,
  overridesFromRows,
  reset,
};
