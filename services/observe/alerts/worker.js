// services/observe/alerts/worker.js
//
// Every 30 seconds: run the checks, evaluate the rules (engine.js), move the
// incident on, and send whatever is due (notifier.js). Runs only where
// ALERTS_ENABLED=true, which is set on Railway alone: a local backend talks
// to the production database and would otherwise alert for real.
//
// IMPORTANT: startWorker() must only be called from a real server process
// (see the require.main guard in server.js).
const crypto = require('crypto');
const logger = require('../../../logger');
const eventBuffer = require('../eventBuffer');
const railway = require('../railwayMetrics');
const signals = require('./signals');
const engine = require('./engine');
const store = require('./store');
const probes = require('./probes');
const notifier = require('./notifier');
const ownerPush = require('./ownerPush');
const { RULE_BY_ID, effective } = require('./rules');

const DEFAULT_TICK_MS = 30 * 1000;
const RAILWAY_EVERY = 2;   // ticks: about once a minute
const SLOW_EVERY = 5;      // ticks: about every 2.5 minutes
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
// Every await in a tick has its own timeout; this is the backstop if one
// still hangs, so alerting can't stop for good.
const STUCK_TICK_MS = 2 * 60 * 1000;

let timer = null;
let running = false;
let runningSince = 0;
let tickSeq = 0; // a stuck tick that finishes late must not clear a newer one's flag
let tickCount = 0;
let startedAt = null;
let pending = {};
let lastTripRecorded = {};
let lastDropped = null;
let lastPruneAt = 0;
let last = null; // the latest tick, for the console

const enabled = () => process.env.ALERTS_ENABLED === 'true';

/** One tick. `now` is injectable for tests. */
async function runOnce(now = Date.now()) {
  tickCount += 1;

  const dbCheck = await probes.probeDb();
  signals.noteProbe(dbCheck.ok, dbCheck.error, now);
  const selfCheck = await probes.probeLoopback();
  signals.noteLoopback(selfCheck.ok, selfCheck.error, now);
  signals.sampleVitals(now);
  const { dropped } = eventBuffer.stats();
  if (lastDropped !== null && dropped > lastDropped) signals.noteDropped(dropped - lastDropped, now);
  lastDropped = dropped;
  if (tickCount % RAILWAY_EVERY === 1) signals.setRailway(await railway.getLatest(now), now); // 10 s fetch timeout

  store.setDbAvailable(dbCheck.ok);
  if (dbCheck.ok) {
    await store.sync();
    await ownerPush.refresh(now);
  }
  const overrides = await store.loadOverrides();
  if (dbCheck.ok && tickCount % SLOW_EVERY === 1) {
    const occurrences = effective(RULE_BY_ID.get('new_error_type'), overrides.new_error_type).params.occurrences;
    signals.setSlow(await probes.slowReadings({ newErrorOccurrences: occurrences }), now);
  }
  if (dbCheck.ok && now - lastPruneAt > PRUNE_EVERY_MS) {
    lastPruneAt = now;
    await store.prune();
  }
  if (store.isMissing()) return { missing: true };

  const snapshot = signals.snapshot(now);
  const evaluated = engine.evaluateRules({ snapshot, overrides, pending, now });
  pending = evaluated.pending;
  const { results } = evaluated;

  const trips = engine.tripsToRecord(results, lastTripRecorded, now);
  for (const t of trips) lastTripRecorded[t.ruleId] = now;
  await store.recordTrips(trips, now);

  const before = store.current(now);
  const adv = engine.advanceIncident({ ...before, results, snapshot, now, newId: crypto.randomUUID });
  if (adv.open || adv.resolved || before.open) await store.save(adv);
  if (adv.event && adv.event !== 'tripping') {
    const inc = adv.open || adv.resolved;
    logger.warn({ observe: true, incidentId: inc.id, tier: inc.tier, rules: Object.keys(inc.rules) }, `Alerts: incident ${adv.event}: ${inc.title}`);
  }

  const after = store.current(now);
  const due = engine.dueNotifications({ open: after.open, owed: after.owed, now, quiet: engine.isQuietHours(now) });
  const sent = [];
  for (const item of due) sent.push({ kind: item.kind, outcome: await notifier.deliver(item, now) });

  last = {
    at: now,
    db: { ok: dbCheck.ok, error: dbCheck.error, consecutiveFails: snapshot.probe.consecutiveFails },
    selfCheck: { ok: selfCheck.ok, error: selfCheck.error },
    results,
    sent,
  };
  return last;
}

function startWorker(intervalMs = Number(process.env.ALERT_TICK_MS) || DEFAULT_TICK_MS) {
  if (timer || !enabled()) return;
  startedAt = Date.now();
  signals.startVitals();
  const tick = async () => {
    if (running) {
      if (Date.now() - runningSince < STUCK_TICK_MS) return;
      logger.error({ observe: true, stuckForMs: Date.now() - runningSince }, 'Alerts worker tick stuck; starting a new one');
    }
    running = true;
    runningSince = Date.now();
    const seq = ++tickSeq;
    try {
      const result = await runOnce();
      if (result && result.missing) {
        stopWorker();
        logger.error({ observe: true }, 'Alerts worker disabled: apply observe_alerts_migration.sql and restart.');
      }
    } catch (err) {
      // observe: true keeps the alert engine's own trouble out of the error
      // counts it alerts on.
      logger.error({ observe: true, err }, 'Alerts worker tick failed');
    } finally {
      if (seq === tickSeq) running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  store.setDbAvailable(true);
  store.recordBoot().finally(() => setImmediate(tick));
  logger.info({ intervalMs, recipients: notifier.recipients().length }, 'Alerts worker started');
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** For the console: is it running, and what did the last tick see. */
function status() {
  return {
    enabled: enabled(),
    running: Boolean(timer),
    startedAt,
    tickMs: Number(process.env.ALERT_TICK_MS) || DEFAULT_TICK_MS,
    last,
  };
}

function reset() {
  stopWorker();
  tickCount = 0;
  startedAt = null;
  pending = {};
  lastTripRecorded = {};
  lastDropped = null;
  lastPruneAt = 0;
  last = null;
}

module.exports = { startWorker, stopWorker, runOnce, status, reset };
