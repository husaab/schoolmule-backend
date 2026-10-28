const signals = require('../../../../../services/observe/alerts/signals');
const engine = require('../../../../../services/observe/alerts/engine');
const { RULE_BY_ID, effective, validatePatch, p95Of } = require('../../../../../services/observe/alerts/rules');

const MIN = 60 * 1000;
// Wed Oct 21 2026, 10:02 pm in Toronto (EDT, UTC-4).
const OCT21_2202 = Date.parse('2026-10-22T02:02:00Z');
// Tue Oct 27 2026, 11:30 am in Toronto.
const OCT27_1130 = Date.parse('2026-10-27T15:30:00Z');

let seq = 0;
const newId = () => `inc-${++seq}`;

beforeEach(() => {
  signals.reset();
  seq = 0;
});

// Spreads `n` requests over the minute ending at `at`.
function requests(at, n, { failed = 0, userId = 'u1', durationMs = 120 } = {}) {
  for (let i = 0; i < n; i += 1) {
    signals.noteRequest({ status: i < failed ? 500 : 200, durationMs, userId }, at - i * 1000);
  }
}
function loggedErrors(at, n, message = 'password authentication failed for user "postgres"') {
  for (let i = 0; i < n; i += 1) signals.noteLoggedError({ fingerprint: `fp${i % 3}`, message }, at - i * 1000);
}
const healthy = (now) => {
  signals.noteProbe(true, null, now);
  signals.noteLoopback(true, null, now);
};

function tick(state, now, overrides = {}) {
  const snapshot = signals.snapshot(now);
  const { results, pending } = engine.evaluateRules({ snapshot, overrides, pending: state.pending, now });
  const adv = engine.advanceIncident({ open: state.open, lastResolved: state.lastResolved, results, snapshot, now, newId });
  const next = {
    pending,
    open: adv.open,
    lastResolved: adv.resolved || state.lastResolved,
    owed: adv.resolved ? [...state.owed, adv.resolved] : state.owed,
    results,
    event: adv.event,
  };
  next.due = engine.dueNotifications({ open: next.open, owed: next.owed, now, quiet: engine.isQuietHours(now) });
  return next;
}
const fresh = () => ({ pending: {}, open: null, lastResolved: null, owed: [] });

// What the worker does after a send succeeds.
function sent(state, kind, now) {
  const inc = state.open;
  if (kind === 'opened') return { ...state, open: { ...inc, notifiedAt: now, notifiedTier: inc.tier, subject: 's' } };
  if (kind === 'reminder') return { ...state, open: { ...inc, lastReminderAt: now } };
  if (kind === 'reopened') return { ...state, open: { ...inc, reopenPending: false, lastReminderAt: now } };
  if (kind === 'recovered') return { ...state, owed: state.owed.map((i) => ({ ...i, recoveredNotifiedAt: now })) };
  return state;
}

describe('quiet hours (America/Toronto)', () => {
  it.each([
    ['2026-10-28T01:59:00Z', false], // 9:59 pm
    ['2026-10-28T02:00:00Z', true], // 10:00 pm
    ['2026-10-28T10:59:00Z', true], // 6:59 am
    ['2026-10-28T11:00:00Z', false], // 7:00 am
    ['2026-11-02T11:59:00Z', true], // 6:59 am EST, after the DST change on Nov 1
    ['2026-11-02T12:00:00Z', false], // 7:00 am EST
  ])('%s quiet=%s', (iso, quiet) => {
    expect(engine.isQuietHours(Date.parse(iso))).toBe(quiet);
  });
});

describe('replay: Oct 21, 10:02 pm (database password rejected)', () => {
  it('opens a critical incident and emails at once, at night, with one person online', () => {
    let s = fresh();
    // 10 requests, 8 failing, from one person; 9 logged errors; probe failing.
    requests(OCT21_2202, 10, { failed: 8 });
    loggedErrors(OCT21_2202, 9);
    signals.noteProbe(false, 'password authentication failed for user "postgres"', OCT21_2202 - 30000);
    signals.noteProbe(false, 'password authentication failed for user "postgres"', OCT21_2202);
    s = tick(s, OCT21_2202);
    expect(s.event).toBe('opened');
    expect(s.open.tier).toBe('critical');
    expect(Object.keys(s.open.rules).sort()).toEqual(['db_unreachable', 'errors_burst']);
    expect(engine.isQuietHours(OCT21_2202)).toBe(true);
    expect(s.due.map((d) => d.kind)).toEqual(['opened']);
  });

  it('stays one incident through overnight gaps while the database check keeps failing', () => {
    let s = fresh();
    requests(OCT21_2202, 10, { failed: 8 });
    signals.noteProbe(false, 'x', OCT21_2202);
    signals.noteProbe(false, 'x', OCT21_2202);
    s = tick(s, OCT21_2202);
    s = sent(s, 'opened', OCT21_2202);
    const id = s.open.id;
    const kinds = [];
    // Five hours with no traffic at all: the probe keeps failing.
    for (let t = OCT21_2202 + MIN; t <= OCT21_2202 + 5 * 60 * MIN + MIN; t += 5 * MIN) {
      signals.noteProbe(false, 'x', t);
      signals.noteLoopback(false, 'db down', t);
      s = tick(s, t);
      kinds.push(...s.due.map((d) => d.kind));
      for (const d of s.due) s = sent(s, d.kind, t);
    }
    expect(s.open).not.toBeNull();
    expect(s.open.id).toBe(id);
    expect(s.owed).toHaveLength(0);
    // Hourly reminders only: 5 hours → 5 reminders, nothing else.
    expect(kinds).toEqual(['reminder', 'reminder', 'reminder', 'reminder', 'reminder']);
  });

  it('recovers only after 15 quiet minutes with both checks passing', () => {
    let s = fresh();
    requests(OCT21_2202, 10, { failed: 8 });
    signals.noteProbe(false, 'x', OCT21_2202);
    signals.noteProbe(false, 'x', OCT21_2202);
    s = tick(s, OCT21_2202);
    s = sent(s, 'opened', OCT21_2202);
    const fixedAt = OCT21_2202 + 30 * MIN;
    for (let t = OCT21_2202 + MIN; t < fixedAt; t += MIN) {
      signals.noteProbe(false, 'x', t);
      s = tick(s, t);
    }
    // Password fixed: checks pass from here on, no errors.
    for (let t = fixedAt; t < fixedAt + 15 * MIN; t += MIN) {
      healthy(t);
      s = tick(s, t);
      expect(s.open).not.toBeNull();
    }
    healthy(fixedAt + 15 * MIN);
    s = tick(s, fixedAt + 15 * MIN);
    expect(s.event).toBe('resolved');
    expect(s.due.map((d) => d.kind)).toEqual(['recovered']);
    expect(s.owed[0].stats.failedRequests).toBe(8);
    expect(s.owed[0].stats.people).toEqual(['u1']);
  });

  it('a new burst within 30 minutes of recovery reopens the same thread', () => {
    let s = fresh();
    requests(OCT21_2202, 10, { failed: 8 });
    signals.noteProbe(true, null, OCT21_2202 - 20 * MIN);
    signals.noteLoopback(true, null, OCT21_2202 - 20 * MIN);
    s = tick(s, OCT21_2202);
    s = sent(s, 'opened', OCT21_2202);
    const id = s.open.id;
    const quiet = OCT21_2202 + 16 * MIN;
    healthy(quiet);
    s = tick(s, quiet);
    expect(s.event).toBe('resolved');
    s = sent(s, 'recovered', quiet);
    requests(quiet + 10 * MIN, 6, { failed: 6 });
    s = tick(s, quiet + 10 * MIN);
    expect(s.event).toBe('reopened');
    expect(s.open.id).toBe(id);
    expect(s.open.reopenCount).toBe(1);
    expect(s.due.map((d) => d.kind)).toEqual(['reopened']);
  });
});

describe('replay: Oct 27, 11:30 am (pool exhausted, one person hit)', () => {
  it('fires on 8 failed responses from a single user', () => {
    requests(OCT27_1130, 8, { failed: 8, userId: 'only-one' });
    healthy(OCT27_1130);
    const s = tick(fresh(), OCT27_1130);
    expect(s.event).toBe('opened');
    expect(s.open.rules.errors_burst.peak).toBe(8);
    expect(s.due.map((d) => d.kind)).toEqual(['opened']);
  });
});

describe('a normal day', () => {
  it('sends nothing for steady traffic with zero server errors', () => {
    let s = fresh();
    const start = Date.parse('2026-10-26T12:00:00Z');
    for (let t = start; t < start + 8 * 60 * MIN; t += MIN) {
      requests(t, 40, { durationMs: 300 });
      if (t % (30 * MIN) === 0) signals.noteLoginFailure('someone@example.com', t);
      healthy(t);
      s = tick(s, t);
      expect(s.due).toEqual([]);
    }
    expect(s.open).toBeNull();
  });
});

describe('tiers and quiet hours', () => {
  const night = Date.parse('2026-10-28T04:00:00Z'); // midnight in Toronto
  const morning = Date.parse('2026-10-28T11:00:00Z'); // 7:00 am

  it('holds a warning overnight and sends it at 7 am if it is still open', () => {
    let s = fresh();
    for (let i = 0; i < 25; i += 1) signals.noteClientError(night - i * 1000);
    s = tick(s, night);
    expect(s.open.tier).toBe('warning');
    expect(s.due).toEqual([]);
    for (let i = 0; i < 25; i += 1) signals.noteClientError(morning - i * 1000);
    s = tick(s, morning);
    expect(s.due.map((d) => d.kind)).toEqual(['opened']);
  });

  it('puts a warning that resolved overnight in the morning summary', () => {
    let s = fresh();
    for (let i = 0; i < 25; i += 1) signals.noteClientError(night - i * 1000);
    healthy(night - 20 * MIN);
    s = tick(s, night);
    healthy(night + 16 * MIN);
    s = tick(s, night + 16 * MIN);
    expect(s.event).toBe('resolved');
    expect(s.due).toEqual([]);
    s = tick(s, morning);
    expect(s.due).toEqual([{ kind: 'summary', incidents: [expect.objectContaining({ tier: 'warning' })] }]);
  });

  it('escalates a notified warning when a critical rule joins it', () => {
    let s = fresh();
    const noon = Date.parse('2026-10-28T16:00:00Z');
    for (let i = 0; i < 25; i += 1) signals.noteClientError(noon - i * 1000);
    s = tick(s, noon);
    s = sent(s, 'opened', noon);
    signals.noteProbe(false, 'timeout', noon + MIN);
    signals.noteProbe(false, 'timeout', noon + MIN);
    s = tick(s, noon + MIN);
    expect(s.event).toBe('joined');
    expect(s.open.tier).toBe('critical');
    expect(s.open.title).toBe('Database unreachable');
    expect(s.due.map((d) => d.kind)).toEqual(['escalated']);
  });

  it('info incidents get one email and no reminders', () => {
    let s = fresh();
    const noon = Date.parse('2026-10-28T16:00:00Z');
    signals.setSlow({ newErrors: [{ fingerprint: 'a', message: 'Failed to update user', count: 2 }], outboxFailed: 0, boots10m: 1 }, noon);
    s = tick(s, noon);
    expect(s.open.tier).toBe('info');
    expect(s.due.map((d) => d.kind)).toEqual(['opened']);
    s = sent(s, 'opened', noon);
    signals.setSlow({ newErrors: [{ fingerprint: 'a', message: 'Failed to update user', count: 2 }], outboxFailed: 0, boots10m: 1 }, noon + 61 * MIN);
    s = tick(s, noon + 61 * MIN);
    expect(s.due).toEqual([]);
  });
});

describe('overrides', () => {
  const now = OCT27_1130;
  it('a muted rule records but never opens an incident', () => {
    requests(now, 8, { failed: 8 });
    const s = tick(fresh(), now, { errors_burst: { muted_until: new Date(now + 60 * MIN).toISOString() } });
    expect(s.open).toBeNull();
    const r = s.results.find((x) => x.id === 'errors_burst');
    expect(r).toMatchObject({ tripped: true, muted: true, live: false });
    expect(engine.tripsToRecord(s.results, {}, now)).toEqual([expect.objectContaining({ ruleId: 'errors_burst', mode: 'muted' })]);
  });

  it('a raised threshold stops a trip', () => {
    requests(now, 8, { failed: 8 });
    const s = tick(fresh(), now, { errors_burst: { params: { serverErrors: 20 } } });
    expect(s.open).toBeNull();
  });

  it('watch-only rules start that way and never alert', () => {
    expect(effective(RULE_BY_ID.get('high_cpu')).mode).toBe('watch');
    process.env.ALERT_CPU_LIMIT_VCPU = '2';
    try {
      let s = fresh();
      for (let t = now; t <= now + 6 * MIN; t += MIN) {
        signals.setRailway({ available: true, cpu: 1.9, memoryGb: 0.3, deploy: null }, t);
        s = tick(s, t);
      }
      const r = s.results.find((x) => x.id === 'high_cpu');
      expect(r).toMatchObject({ tripped: true, mode: 'watch', live: false });
      expect(s.open).toBeNull();
    } finally {
      delete process.env.ALERT_CPU_LIMIT_VCPU;
    }
  });

  it('sustained rules need the full span', () => {
    process.env.ALERT_CPU_LIMIT_VCPU = '2';
    try {
      let s = fresh();
      const overrides = { high_cpu: { mode: 'live' } };
      for (let t = now; t < now + 5 * MIN; t += MIN) {
        signals.setRailway({ available: true, cpu: 1.9 }, t);
        s = tick(s, t, overrides);
        expect(s.open).toBeNull();
      }
      signals.setRailway({ available: true, cpu: 1.9 }, now + 5 * MIN);
      s = tick(s, now + 5 * MIN, overrides);
      expect(s.open.rules.high_cpu).toBeDefined();
    } finally {
      delete process.env.ALERT_CPU_LIMIT_VCPU;
    }
  });

  it('missing data never trips', () => {
    const s = tick(fresh(), now);
    for (const id of ['high_cpu', 'high_memory', 'emails_failing', 'new_error_type', 'crash_loop', 'deploy_failed']) {
      expect(s.results.find((x) => x.id === id).tripped).toBeNull();
    }
  });
});

describe('validatePatch', () => {
  const now = OCT27_1130;
  const burst = RULE_BY_ID.get('errors_burst');
  const cpu = RULE_BY_ID.get('high_cpu');

  it('accepts a threshold in range', () => {
    expect(validatePatch(burst, { params: { serverErrors: 8 } }, now)).toEqual({ ok: true, value: { params: { serverErrors: 8 } } });
  });
  it.each([
    [{ params: { serverErrors: 0 } }, 'between 1 and 1000'],
    [{ params: { nope: 1 } }, 'no setting called nope'],
    [{ params: { serverErrors: 'x' } }, 'must be a number'],
    [{ enabled: false }, "can't be switched off"],
    [{ mode: 'watch' }, 'always sends alerts'],
    [{ mutedUntil: new Date(now + 25 * 3600 * 1000).toISOString() }, 'at most 24 hours'],
    [{ mutedUntil: new Date(now - 1000).toISOString() }, 'in the future'],
    [{ colour: 'red' }, 'Unknown field'],
    [{}, 'Nothing to change'],
  ])('rejects %j on a locked rule', (body, message) => {
    const r = validatePatch(burst, body, now);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });
  it('lets an unlocked rule be switched off, go live and be muted for days', () => {
    const until = new Date(now + 3 * 24 * 3600 * 1000).toISOString();
    expect(validatePatch(cpu, { enabled: false, mode: 'live', mutedUntil: until }, now)).toEqual({
      ok: true,
      value: { enabled: false, mode: 'live', mutedUntil: until },
    });
  });
  it('locked rules ignore a stored "off"', () => {
    expect(effective(burst, { enabled: false, mode: 'watch' })).toMatchObject({ enabled: true, mode: 'live' });
  });
});

describe('p95Of', () => {
  it('reads the bucket edge that holds the 95th percentile', () => {
    const now = OCT27_1130;
    requests(now, 95, { durationMs: 200 });
    requests(now, 5, { durationMs: 4000 });
    expect(p95Of(signals.snapshot(now).buckets)).toBe(250);
    requests(now, 10, { durationMs: 4000 });
    expect(p95Of(signals.snapshot(now).buckets)).toBe(5000);
  });
});
