// services/observe/alerts/rules.js
//
// The built-in alert rules. Each one is a pure function of the signals
// snapshot (signals.js) and its numeric params; the owner can change the
// numbers, mute, switch watch-only/live or disable a rule from Observe, and
// those choices are stored as overrides (alert_rule_overrides).
//
// evaluate() returns { tripped, value, summary }:
//   tripped  true / false, or null when the data isn't there (Railway down,
//            database readings skipped). null never trips and never counts
//            as healthy.
//   value    one number for "peak" (the larger of the counts, a percentage…)
//   summary  one plain sentence for the email and the console.
//
// No rule requires several people to be affected: at 10 pm on Oct 21, and
// again on Oct 27, one person was online and the outage was real.
const { minuteOf, DUR_EDGES } = require('./signals');

const TIERS = ['info', 'warning', 'critical'];
const tierRank = (tier) => TIERS.indexOf(tier);

// Railway data older than this is treated as missing.
const STALE_MS = 5 * 60 * 1000;
// Database-backed readings run every few minutes; older than this is missing.
const SLOW_STALE_MS = 10 * 60 * 1000;

/** Buckets in the last `minutes` minutes, the current partial minute included. */
const windowOf = (s, minutes) => {
  const from = minuteOf(s.now) - minutes + 1;
  return s.buckets.filter((b) => b.minute >= from);
};
const total = (buckets, field) => buckets.reduce((n, b) => n + b[field], 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** p95 in ms from the summed histograms (the upper edge of its bucket). */
function p95Of(buckets) {
  const counts = new Array(DUR_EDGES.length).fill(0);
  for (const b of buckets) b.dur.forEach((n, i) => { counts[i] += n; });
  const n = counts.reduce((a, c) => a + c, 0);
  if (!n) return null;
  const rank = Math.ceil(n * 0.95);
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) {
    seen += counts[i];
    if (seen >= rank) return Number.isFinite(DUR_EDGES[i]) ? DUR_EDGES[i] : DUR_EDGES[i - 1];
  }
  return null;
}

const fresh = (reading, maxAge, now) => reading && reading.at !== undefined && now - reading.at <= maxAge;
const envNumber = (name) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const RULES = [
  // ─── Critical: email right away, 24/7 ─────────────────────────────────
  {
    id: 'errors_burst',
    tier: 'critical',
    locked: true,
    name: 'Server errors burst',
    description: 'Failed responses (5xx) or logged server errors pile up within 5 minutes.',
    source: 'In-memory counters',
    window: '5 min',
    params: {
      serverErrors: { label: 'Failed responses', unit: '5xx', default: 5, min: 1, max: 1000 },
      loggedErrors: { label: 'Logged errors', unit: 'errors', default: 10, min: 1, max: 1000 },
    },
    evaluate(s, p) {
      const w = windowOf(s, 5);
      const s5xx = total(w, 's5xx');
      const logged = total(w, 'logged');
      return {
        tripped: s5xx >= p.serverErrors || logged >= p.loggedErrors,
        value: Math.max(s5xx, logged),
        summary: `${plural(s5xx, 'failed response')} and ${plural(logged, 'logged error')} in the last 5 minutes.`,
      };
    },
  },
  {
    id: 'db_unreachable',
    tier: 'critical',
    locked: true,
    name: 'Database unreachable',
    description: 'The 30-second database check fails several times in a row.',
    source: 'Database check',
    window: 'every 30 s',
    params: {
      failures: { label: 'Failed checks in a row', unit: 'checks', default: 2, min: 1, max: 20 },
    },
    evaluate(s, p) {
      if (!s.probe.lastAt) return { tripped: null, value: null, summary: 'The database check has not run yet.' };
      const n = s.probe.consecutiveFails;
      return {
        tripped: n >= p.failures,
        value: n,
        summary: n
          ? `The database check failed ${plural(n, 'time')} in a row${s.probe.lastError ? `: ${s.probe.lastError}` : '.'}`
          : 'The database check is passing.',
      };
    },
  },
  {
    id: 'failure_rate',
    tier: 'critical',
    locked: true,
    name: 'High failure rate',
    description: 'A large share of requests fail over 10 minutes, on a busy enough day to judge.',
    source: 'In-memory counters',
    window: '10 min',
    params: {
      percent: { label: 'Requests failing', unit: '%', default: 10, min: 1, max: 100 },
      minRequests: { label: 'At least this many requests', unit: 'requests', default: 30, min: 1, max: 10000 },
    },
    evaluate(s, p) {
      const w = windowOf(s, 10);
      const req = total(w, 'req');
      const pct = req ? Math.round((total(w, 's5xx') / req) * 1000) / 10 : 0;
      return {
        tripped: req >= p.minRequests && pct >= p.percent,
        value: pct,
        summary: `${pct}% of ${plural(req, 'request')} failed in the last 10 minutes.`,
      };
    },
  },
  {
    id: 'crash_loop',
    tier: 'critical',
    locked: true,
    name: 'Crash loop',
    description: 'The server keeps restarting, or Railway reports the running deploy crashed.',
    source: 'Boot log + Railway',
    window: '10 min',
    params: {
      // Each deploy is a start too; 5 in 10 minutes is past a burst of pushes.
      boots: { label: 'Restarts', unit: 'starts', default: 5, min: 2, max: 50 },
    },
    evaluate(s, p) {
      const boots = fresh(s.slow, SLOW_STALE_MS, s.now) && Number.isInteger(s.slow.boots10m) ? s.slow.boots10m : null;
      const deploy = fresh(s.railway, STALE_MS, s.now) && s.railway.available ? s.railway.deploy : null;
      const crashed = Boolean(deploy && deploy.status === 'CRASHED');
      if (boots === null && !deploy) return { tripped: null, value: null, summary: 'No restart or deploy data right now.' };
      const loop = boots !== null && boots >= p.boots;
      return {
        tripped: loop || crashed,
        value: boots ?? 0,
        summary: crashed
          ? 'Railway reports the running deploy crashed.'
          : `The server started ${plural(boots ?? 0, 'time')} in the last 10 minutes.`,
      };
    },
  },
  {
    id: 'server_down',
    tier: 'critical',
    external: true,
    name: 'Server is down',
    description: "Watched from outside by Railway's own monitors (crashed deploys, CPU, RAM), set up in the Railway dashboard. A server can't report its own death.",
    source: 'Railway monitors',
    window: '—',
    params: {},
    evaluate: () => ({ tripped: null, value: null, summary: 'Handled by Railway.' }),
  },

  // ─── Warning: email 7 am–10 pm Toronto, overnight ones in the morning ─
  {
    id: 'deploy_failed',
    tier: 'warning',
    name: 'Deploy failed',
    description: "Railway's latest deploy failed to build or start, so the last good version is still running.",
    source: 'Railway',
    window: '2 h',
    params: {},
    evaluate(s) {
      if (!fresh(s.railway, STALE_MS, s.now) || !s.railway.available) {
        return { tripped: null, value: null, summary: 'Railway data unavailable.' };
      }
      const d = s.railway.deploy;
      const failed = Boolean(d && d.status === 'FAILED' && s.now - new Date(d.createdAt).getTime() <= 2 * 3600 * 1000);
      return {
        tripped: failed,
        value: failed ? 1 : 0,
        summary: failed
          ? `Railway's latest deploy failed${d.commitMessage ? ` ("${String(d.commitMessage).split('\n')[0].slice(0, 80)}")` : ''}.`
          : 'The latest deploy is fine.',
      };
    },
  },
  {
    id: 'high_cpu',
    tier: 'warning',
    defaultMode: 'watch',
    sustainMin: 5,
    name: 'High CPU',
    description: "The service's CPU stays high for 5 minutes. Needs ALERT_CPU_LIMIT_VCPU on the server.",
    source: 'Railway',
    window: '5 min sustained',
    params: {
      percent: { label: 'Of the CPU limit', unit: '%', default: 85, min: 10, max: 100 },
    },
    evaluate(s, p) {
      const limit = envNumber('ALERT_CPU_LIMIT_VCPU');
      if (!limit || !fresh(s.railway, STALE_MS, s.now) || !s.railway.available || s.railway.cpu === null || s.railway.cpu === undefined) {
        return { tripped: null, value: null, summary: 'CPU data unavailable.' };
      }
      const pct = Math.round((s.railway.cpu / limit) * 100);
      return { tripped: pct >= p.percent, value: pct, summary: `CPU at ${pct}% of the ${limit} vCPU limit.` };
    },
  },
  {
    id: 'event_loop_lag',
    tier: 'warning',
    defaultMode: 'watch',
    sustainMin: 3,
    name: 'Server busy',
    description: "Node's event loop is held up (p99 delay) for 3 minutes, so every request waits.",
    source: 'Process',
    window: '3 min sustained',
    params: {
      p99Ms: { label: 'Event-loop delay (p99)', unit: 'ms', default: 500, min: 50, max: 10000 },
    },
    evaluate(s, p) {
      if (!s.vitals || s.vitals.lagP99Ms === null) return { tripped: null, value: null, summary: 'No event-loop data yet.' };
      return {
        tripped: s.vitals.lagP99Ms > p.p99Ms,
        value: s.vitals.lagP99Ms,
        summary: `Event-loop delay p99 is ${s.vitals.lagP99Ms} ms.`,
      };
    },
  },
  {
    id: 'high_memory',
    tier: 'warning',
    defaultMode: 'watch',
    sustainMin: 5,
    name: 'High memory',
    description: 'Memory stays near the limit for 5 minutes. Needs ALERT_MEM_LIMIT_GB on the server.',
    source: 'Railway, else the process',
    window: '5 min sustained',
    params: {
      percent: { label: 'Of the memory limit', unit: '%', default: 85, min: 10, max: 100 },
    },
    evaluate(s, p) {
      const limitGb = envNumber('ALERT_MEM_LIMIT_GB');
      if (!limitGb) return { tripped: null, value: null, summary: 'Memory limit not configured.' };
      let usedGb = null;
      if (fresh(s.railway, STALE_MS, s.now) && s.railway.available && Number.isFinite(s.railway.memoryGb)) usedGb = s.railway.memoryGb;
      else if (s.vitals && Number.isFinite(s.vitals.rssMb)) usedGb = s.vitals.rssMb / 1024;
      if (usedGb === null) return { tripped: null, value: null, summary: 'Memory data unavailable.' };
      const pct = Math.round((usedGb / limitGb) * 100);
      return { tripped: pct >= p.percent, value: pct, summary: `Memory at ${pct}% of the ${limitGb} GB limit.` };
    },
  },
  {
    id: 'slow_responses',
    tier: 'warning',
    name: 'Slow responses',
    description: 'The slowest 5% of requests take too long over 10 minutes. A normal day is 250–620 ms.',
    source: 'In-memory counters',
    window: '10 min',
    params: {
      p95Ms: { label: 'p95 response time', unit: 'ms', default: 2000, min: 100, max: 60000 },
      minRequests: { label: 'At least this many requests', unit: 'requests', default: 30, min: 1, max: 10000 },
    },
    evaluate(s, p) {
      const w = windowOf(s, 10);
      const req = total(w, 'req');
      const p95 = p95Of(w);
      return {
        tripped: req >= p.minRequests && p95 !== null && p95 > p.p95Ms,
        value: p95,
        summary: p95 === null ? 'No requests in the last 10 minutes.' : `p95 up to ${p95} ms over ${plural(req, 'request')}.`,
      };
    },
  },
  {
    id: 'browser_errors',
    tier: 'warning',
    name: 'Browser errors surge',
    description: 'Pages report JavaScript errors or failed API calls (notification-tap traces not counted).',
    source: 'Browser reports',
    window: '10 min',
    params: {
      count: { label: 'Browser errors', unit: 'errors', default: 20, min: 1, max: 10000 },
    },
    evaluate(s, p) {
      const n = total(windowOf(s, 10), 'client');
      return { tripped: n >= p.count, value: n, summary: `${plural(n, 'browser error')} in the last 10 minutes.` };
    },
  },
  {
    id: 'signin_failures',
    tier: 'warning',
    name: 'Failed sign-in spike',
    description: 'Many failed sign-ins overall, or many for one account (possible password guessing).',
    source: 'Sign-in counters',
    window: '10 min',
    params: {
      total: { label: 'Failed sign-ins', unit: 'attempts', default: 15, min: 1, max: 10000 },
      perAccount: { label: 'For one account', unit: 'attempts', default: 8, min: 1, max: 10000 },
    },
    evaluate(s, p) {
      const w = windowOf(s, 10);
      const n = total(w, 'loginFail');
      const perEmail = new Map();
      for (const b of w) for (const [email, c] of b.loginFailByEmail) perEmail.set(email, (perEmail.get(email) || 0) + c);
      const worst = Math.max(0, ...perEmail.values());
      return {
        tripped: n >= p.total || worst >= p.perAccount,
        value: Math.max(n, worst),
        summary: `${plural(n, 'failed sign-in')} in the last 10 minutes; at most ${worst} for one account.`,
      };
    },
  },
  {
    id: 'emails_failing',
    tier: 'warning',
    name: 'Emails failing to send',
    description: 'Queued emails (grade emails, reminders) gave up after their retries in the last hour.',
    source: 'Email outbox',
    window: '1 h',
    params: {
      count: { label: 'Failed emails', unit: 'emails', default: 1, min: 1, max: 1000 },
    },
    evaluate(s, p) {
      if (!fresh(s.slow, SLOW_STALE_MS, s.now) || !Number.isInteger(s.slow.outboxFailed)) {
        return { tripped: null, value: null, summary: 'Outbox reading unavailable.' };
      }
      const n = s.slow.outboxFailed;
      return { tripped: n >= p.count, value: n, summary: `${plural(n, 'queued email')} failed in the last hour.` };
    },
  },

  // ─── Info: one email, no reminders, overnight ones in the morning ─────
  {
    id: 'new_error_type',
    tier: 'info',
    name: 'New error type',
    description: 'A server error not seen in the last 30 days shows up more than once.',
    source: 'Error events',
    window: '10 min',
    params: {
      occurrences: { label: 'Times seen', unit: 'times', default: 2, min: 1, max: 1000 },
    },
    evaluate(s) {
      if (!fresh(s.slow, SLOW_STALE_MS, s.now) || !Array.isArray(s.slow.newErrors)) {
        return { tripped: null, value: null, summary: 'Error-type reading unavailable.' };
      }
      const list = s.slow.newErrors;
      return {
        tripped: list.length > 0,
        value: list.length,
        summary: list.length
          ? `New: ${list.slice(0, 2).map((e) => `"${String(e.message).slice(0, 90)}"`).join(', ')}${list.length > 2 ? ` and ${list.length - 2} more` : ''}.`
          : 'No new error types.',
      };
    },
  },
  {
    id: 'observe_dropping',
    tier: 'info',
    name: 'Observe losing data',
    description: "Observe's event buffer dropped rows it couldn't write.",
    source: 'Event buffer',
    window: '5 min',
    params: {
      rows: { label: 'Dropped rows', unit: 'rows', default: 1, min: 1, max: 100000 },
    },
    evaluate(s, p) {
      const n = total(windowOf(s, 5), 'dropped');
      return { tripped: n >= p.rows, value: n, summary: `${plural(n, 'event row')} dropped in the last 5 minutes.` };
    },
  },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));
// Locked rules can be tuned and muted for a while, never switched off.
const LOCKED_MAX_MUTE_MS = 24 * 3600 * 1000;
const MAX_MUTE_MS = 30 * 24 * 3600 * 1000;

const defaultParams = (rule) => Object.fromEntries(Object.entries(rule.params).map(([k, d]) => [k, d.default]));

/** The rule as the engine runs it, with the owner's override applied. */
function effective(rule, override = null) {
  const params = defaultParams(rule);
  const saved = (override && override.params) || {};
  for (const [k, d] of Object.entries(rule.params)) {
    const v = Number(saved[k]);
    if (Number.isFinite(v) && v >= d.min && v <= d.max) params[k] = v;
  }
  const enabled = rule.locked ? true : override?.enabled ?? true;
  const mode = rule.locked ? 'live' : override?.mode || rule.defaultMode || 'live';
  const mutedUntil = override?.muted_until ? new Date(override.muted_until).getTime() : null;
  return { enabled, mode, mutedUntil, params };
}

/**
 * Validates an owner's change. body: { params?, enabled?, mode?, mutedUntil? }.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validatePatch(rule, body, now = Date.now()) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send a JSON body' };
  if (rule.external) return { ok: false, error: `${rule.name} is handled by Railway and has no settings here` };
  const allowed = new Set(['params', 'enabled', 'mode', 'mutedUntil']);
  const unknown = Object.keys(body).filter((k) => !allowed.has(k));
  if (unknown.length) return { ok: false, error: `Unknown field: ${unknown[0]}` };
  const value = {};

  if (body.params !== undefined) {
    if (!body.params || typeof body.params !== 'object') return { ok: false, error: 'params must be an object' };
    value.params = {};
    for (const [k, raw] of Object.entries(body.params)) {
      const d = rule.params[k];
      if (!d) return { ok: false, error: `${rule.name} has no setting called ${k}` };
      const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: `${d.label} must be a number` };
      if (n < d.min || n > d.max) return { ok: false, error: `${d.label} must be between ${d.min} and ${d.max}` };
      value.params[k] = n;
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    if (rule.locked && body.enabled === false) return { ok: false, error: `${rule.name} can't be switched off. Mute it for up to 24 hours instead.` };
    value.enabled = body.enabled;
  }
  if (body.mode !== undefined) {
    if (!['live', 'watch'].includes(body.mode)) return { ok: false, error: 'mode must be live or watch' };
    if (rule.locked && body.mode === 'watch') return { ok: false, error: `${rule.name} always sends alerts. Mute it for up to 24 hours instead.` };
    value.mode = body.mode;
  }
  if (body.mutedUntil !== undefined) {
    if (body.mutedUntil === null) {
      value.mutedUntil = null;
    } else {
      const t = new Date(String(body.mutedUntil)).getTime();
      if (Number.isNaN(t) || t <= now) return { ok: false, error: 'mutedUntil must be a time in the future' };
      const max = rule.locked ? LOCKED_MAX_MUTE_MS : MAX_MUTE_MS;
      if (t - now > max) return { ok: false, error: rule.locked ? `${rule.name} can be muted for at most 24 hours` : 'A rule can be muted for at most 30 days' };
      value.mutedUntil = new Date(t).toISOString();
    }
  }
  if (value.params && !Object.keys(value.params).length) delete value.params;
  if (!Object.keys(value).length) return { ok: false, error: 'Nothing to change' };
  return { ok: true, value };
}

module.exports = { RULES, RULE_BY_ID, tierRank, effective, validatePatch, windowOf, total, p95Of };
