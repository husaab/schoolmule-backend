// services/observe/alerts/engine.js
//
// The alert engine's decisions, as pure functions of plain data so every
// case can be tested with a fixed clock: which rules trip, what that does to
// the open incident, and which emails are due. The worker (worker.js) does
// the I/O around them.
//
// One incident at a time: whatever trips while one is open joins it, and its
// tier is the highest of its rules. It recovers after 15 quiet minutes AND
// positive proof of health (the database check and the server's own health
// check both passing for 15 minutes); silence alone never counts, because at
// 3 am there is no traffic. A new trip within 30 minutes of recovery reopens
// the same incident, so a flapping problem stays one email thread.
const { RULES, effective, tierRank, windowOf, total } = require('./rules');
const { minuteOf } = require('./signals');

const RECOVER_AFTER_MS = 15 * 60 * 1000;
const REOPEN_WITHIN_MS = 30 * 60 * 1000;
const REMIND_EVERY_MS = 60 * 60 * 1000;
const TRIP_LOG_EVERY_MS = 15 * 60 * 1000;
const MAX_PEOPLE = 500;
const MAX_TOP_ERRORS = 10;
const TIME_ZONE = 'America/Toronto';
const QUIET_FROM_HOUR = 22;
const QUIET_UNTIL_HOUR = 7;

const hourFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' });

/** Warnings and notices wait between 10 pm and 7 am Toronto time. */
function isQuietHours(now) {
  const hour = Number(hourFmt.format(new Date(now)));
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/**
 * Runs every rule. `pending` holds when each sustained rule's condition first
 * held; a sustained rule trips only once it has held for its full span.
 * @returns {{ results: object[], pending: object }}
 */
function evaluateRules({ snapshot, overrides = {}, pending = {}, now }) {
  const results = [];
  const nextPending = {};
  for (const rule of RULES) {
    if (rule.external) continue;
    const eff = effective(rule, overrides[rule.id]);
    const base = { id: rule.id, tier: rule.tier, name: rule.name, mode: eff.mode };
    if (!eff.enabled) {
      results.push({ ...base, enabled: false, tripped: null, value: null, summary: 'Switched off.', live: false, muted: false });
      continue;
    }
    let r;
    try {
      r = rule.evaluate(snapshot, eff.params);
    } catch {
      r = { tripped: null, value: null, summary: 'This rule could not be evaluated.' };
    }
    let tripped = r.tripped;
    if (rule.sustainMin && tripped === true) {
      const since = pending[rule.id] ?? now;
      nextPending[rule.id] = since;
      tripped = now - since >= rule.sustainMin * 60 * 1000;
    }
    const muted = Boolean(eff.mutedUntil && eff.mutedUntil > now);
    results.push({
      ...base,
      enabled: true,
      tripped,
      value: r.value,
      summary: r.summary,
      muted,
      live: eff.mode === 'live' && !muted,
    });
  }
  return { results, pending: nextPending };
}

/** Both checks passing without a break for the recovery span. */
function isHealthy(snapshot, now) {
  const held = (check) => check && check.okSince !== null && now - check.okSince >= RECOVER_AFTER_MS;
  return Boolean(held(snapshot.probe) && held(snapshot.loopback));
}

const highestTier = (rules) => Object.values(rules).reduce((t, r) => (tierRank(r.tier) > tierRank(t) ? r.tier : t), 'info');

// The headline: the most severe rule, the earliest to trip among equals.
function titleOf(rules) {
  const list = Object.values(rules).sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || a.firstAt - b.firstAt);
  return list.length ? list[0].name : 'Alert';
}

function mergeTrips(incident, firing, now) {
  const rules = { ...incident.rules };
  let added = false;
  for (const r of firing) {
    const prev = rules[r.id];
    if (!prev) added = true;
    rules[r.id] = {
      name: r.name,
      tier: r.tier,
      firstAt: prev ? prev.firstAt : now,
      lastAt: now,
      peak: Math.max(prev?.peak ?? 0, Number(r.value) || 0),
      summary: r.summary,
    };
  }
  return { incident: { ...incident, rules, tier: highestTier(rules), title: titleOf(rules), lastTripAt: now }, added };
}

/** Adds the minutes completed since the last tick to the incident's totals. */
function accumulate(incident, snapshot, now) {
  const current = minuteOf(now);
  const s = { ...incident.stats };
  const people = new Set(s.people || []);
  const errors = new Map((s.topErrors || []).map((e) => [e.fingerprint, { ...e }]));
  for (const b of snapshot.buckets) {
    if (b.minute <= s.countedThrough || b.minute >= current) continue;
    s.failedRequests += b.s5xx;
    s.loggedErrors += b.logged;
    for (const id of b.users5xx) if (people.size < MAX_PEOPLE) people.add(id);
    for (const [fingerprint, e] of b.errors) {
      const hit = errors.get(fingerprint);
      if (hit) hit.count += e.count;
      else errors.set(fingerprint, { fingerprint, message: e.message, count: e.count });
    }
  }
  const w = windowOf(snapshot, 5);
  s.peakErrors5m = Math.max(s.peakErrors5m, total(w, 's5xx'), total(w, 'logged'));
  s.countedThrough = current - 1;
  s.people = [...people];
  s.topErrors = [...errors.values()].sort((a, b) => b.count - a.count).slice(0, MAX_TOP_ERRORS);
  return { ...incident, stats: s };
}

function newIncident(id, now) {
  return {
    id,
    status: 'open',
    tier: 'info',
    title: 'Alert',
    subject: null,
    openedAt: now,
    lastTripAt: now,
    resolvedAt: null,
    reopenCount: 0,
    notifiedAt: null,
    notifiedTier: null,
    lastReminderAt: null,
    reopenPending: false,
    recoveredNotifiedAt: null,
    summarizedAt: null,
    rules: {},
    // The burst that opened it started up to 5 minutes ago: count those too.
    stats: { failedRequests: 0, loggedErrors: 0, people: [], peakErrors5m: 0, topErrors: [], countedThrough: minuteOf(now) - 5 },
  };
}

/**
 * Moves the incident on by one tick.
 * @param {object}   p
 * @param {object|null} p.open          the open incident
 * @param {object|null} p.lastResolved  the most recently resolved one (for reopening)
 * @param {object[]} p.results          evaluateRules().results
 * @param {object}   p.snapshot
 * @param {number}   p.now
 * @param {() => string} p.newId
 * @returns {{ open: object|null, resolved: object|null, event: string|null }}
 *   event: 'opened' | 'reopened' | 'joined' | 'tripping' | 'resolved' | null
 */
function advanceIncident({ open, lastResolved, results, snapshot, now, newId }) {
  const firing = results.filter((r) => r.live && r.tripped === true);

  if (open) {
    if (firing.length) {
      const { incident, added } = mergeTrips(open, firing, now);
      return { open: accumulate(incident, snapshot, now), resolved: null, event: added ? 'joined' : 'tripping' };
    }
    const counted = accumulate(open, snapshot, now);
    if (now - open.lastTripAt >= RECOVER_AFTER_MS && isHealthy(snapshot, now)) {
      return { open: null, resolved: { ...counted, status: 'resolved', resolvedAt: now }, event: 'resolved' };
    }
    return { open: counted, resolved: null, event: null };
  }

  if (!firing.length) return { open: null, resolved: null, event: null };

  if (lastResolved && lastResolved.resolvedAt && now - lastResolved.resolvedAt < REOPEN_WITHIN_MS) {
    const reopened = {
      ...lastResolved,
      status: 'open',
      resolvedAt: null,
      reopenCount: lastResolved.reopenCount + 1,
      // A thread that already told you it recovered now says it's back.
      reopenPending: Boolean(lastResolved.notifiedAt),
      recoveredNotifiedAt: null,
    };
    const { incident } = mergeTrips(reopened, firing, now);
    return { open: accumulate(incident, snapshot, now), resolved: null, event: 'reopened' };
  }

  const { incident } = mergeTrips(newIncident(newId(), now), firing, now);
  return { open: accumulate(incident, snapshot, now), resolved: null, event: 'opened' };
}

/**
 * Emails due now. `owed` is resolved incidents that still owe one (a
 * recovery email, or a place in the morning summary).
 * @returns {Array<{ kind: string, incident?: object, incidents?: object[] }>}
 */
function dueNotifications({ open, owed = [], now, quiet }) {
  const due = [];
  if (open) {
    const critical = open.tier === 'critical';
    if (!open.notifiedAt) {
      if (critical || !quiet) due.push({ kind: 'opened', incident: open });
    } else if (open.reopenPending && open.tier !== 'info') {
      due.push({ kind: 'reopened', incident: open });
    } else if (critical && open.notifiedTier !== 'critical') {
      due.push({ kind: 'escalated', incident: open });
    } else if (open.tier !== 'info' && (critical || !quiet) && now - (open.lastReminderAt ?? open.notifiedAt) >= REMIND_EVERY_MS) {
      due.push({ kind: 'reminder', incident: open });
    }
  }
  for (const inc of owed) {
    if (inc.notifiedAt && !inc.recoveredNotifiedAt && inc.tier !== 'info') due.push({ kind: 'recovered', incident: inc });
  }
  const unsent = owed.filter((inc) => !inc.notifiedAt && !inc.summarizedAt);
  if (unsent.length && (!quiet || unsent.some((inc) => inc.tier === 'critical'))) {
    due.push({ kind: 'summary', incidents: unsent });
  }
  return due;
}

/** Tripped rules (live, watch-only or muted) due a row in alert_rule_trips. */
function tripsToRecord(results, lastRecorded, now) {
  return results
    .filter((r) => r.tripped === true && now - (lastRecorded[r.id] ?? -Infinity) >= TRIP_LOG_EVERY_MS)
    .map((r) => ({ ruleId: r.id, mode: r.muted ? 'muted' : r.mode, value: Number.isFinite(r.value) ? r.value : null, summary: r.summary }));
}

module.exports = {
  isQuietHours,
  evaluateRules,
  isHealthy,
  advanceIncident,
  dueNotifications,
  tripsToRecord,
  newIncident,
  RECOVER_AFTER_MS,
  REOPEN_WITHIN_MS,
  REMIND_EVERY_MS,
  TIME_ZONE,
};
