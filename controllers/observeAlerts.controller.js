// Observe → Alerts: incidents, the built-in rules with the owner's settings,
// and a test send. Owner-only (mounted behind requirePlatformOwner).
const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/observeAlerts.queries');
const { parseWindow } = require('../services/observe/window');
const { RULES, RULE_BY_ID, effective, validatePatch } = require('../services/observe/alerts/rules');
const store = require('../services/observe/alerts/store');
const worker = require('../services/observe/alerts/worker');
const notifier = require('../services/observe/alerts/notifier');
const ownerPush = require('../services/observe/alerts/ownerPush');
const engine = require('../services/observe/alerts/engine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNDEFINED_TABLE = '42P01';
const iso = (v) => (v ? new Date(v).toISOString() : null);

const fail = (res, err, what) => {
  if (err && err.code === UNDEFINED_TABLE) {
    return res.status(503).json({ status: 'failed', message: 'Alerts are not set up yet: apply observe_alerts_migration.sql' });
  }
  logger.error({ err }, `Observe alerts: ${what} failed`);
  return res.status(500).json({ status: 'failed', message: `Could not ${what}` });
};

function incidentOut(inc, extra = {}) {
  const stats = inc.stats || {};
  return {
    id: inc.id,
    status: inc.status,
    tier: inc.tier,
    title: inc.title,
    openedAt: iso(inc.openedAt),
    lastTripAt: iso(inc.lastTripAt),
    resolvedAt: iso(inc.resolvedAt),
    durationMs: (inc.resolvedAt || Date.now()) - inc.openedAt,
    reopenCount: inc.reopenCount,
    notifiedAt: iso(inc.notifiedAt),
    held: !inc.notifiedAt && inc.tier !== 'critical',
    rules: Object.entries(inc.rules || {})
      .map(([id, r]) => ({ id, name: r.name, tier: r.tier, firstAt: iso(r.firstAt), lastAt: iso(r.lastAt), peak: r.peak, summary: r.summary }))
      .sort((a, b) => a.firstAt.localeCompare(b.firstAt)),
    stats: {
      failedRequests: stats.failedRequests || 0,
      loggedErrors: stats.loggedErrors || 0,
      peopleAffected: (stats.people || []).length,
      peakErrors5m: stats.peakErrors5m || 0,
      topErrors: (stats.topErrors || []).map((e) => ({ fingerprint: e.fingerprint, message: e.message, count: e.count })),
    },
    ...extra,
  };
}

const notificationOut = (n) => ({
  ts: iso(n.ts),
  channel: n.channel,
  kind: n.kind,
  ok: n.ok,
  recipients: n.recipients,
  subject: n.subject,
  error: n.error,
});

async function loadOverrides() {
  const { rows } = await db.query(q.overrides);
  return Object.fromEntries(rows.map((r) => [r.rule_id, r]));
}

function ruleOut(rule, override, { current, lastTrip, trips }) {
  const eff = effective(rule, override);
  return {
    id: rule.id,
    name: rule.name,
    tier: rule.tier,
    description: rule.description,
    source: rule.source,
    window: rule.window,
    locked: Boolean(rule.locked),
    external: Boolean(rule.external),
    defaultMode: rule.defaultMode || 'live',
    params: Object.entries(rule.params).map(([key, d]) => ({
      key, label: d.label, unit: d.unit, default: d.default, min: d.min, max: d.max, value: eff.params[key],
    })),
    enabled: eff.enabled,
    mode: eff.mode,
    mutedUntil: eff.mutedUntil && eff.mutedUntil > Date.now() ? iso(eff.mutedUntil) : null,
    customized: Boolean(override),
    current: current ? { tripped: current.tripped, value: current.value, summary: current.summary } : null,
    lastTrip: lastTrip ? { at: iso(lastTrip.ts), mode: lastTrip.mode, value: lastTrip.value, summary: lastTrip.summary } : null,
    trips7d: trips || { live: 0, watch: 0, muted: 0 },
  };
}

async function rulesPayload(onlyId = null) {
  const [overrides, last, counts] = await Promise.all([loadOverrides(), db.query(q.lastTrips), db.query(q.tripCounts)]);
  const lastBy = Object.fromEntries(last.rows.map((r) => [r.rule_id, r]));
  const countsBy = {};
  for (const r of counts.rows) {
    countsBy[r.rule_id] = countsBy[r.rule_id] || { live: 0, watch: 0, muted: 0 };
    countsBy[r.rule_id][r.mode] = r.n;
  }
  const currentBy = Object.fromEntries(((worker.status().last || {}).results || []).map((r) => [r.id, r]));
  return RULES.filter((r) => !onlyId || r.id === onlyId).map((rule) =>
    ruleOut(rule, overrides[rule.id], { current: currentBy[rule.id], lastTrip: lastBy[rule.id], trips: countsBy[rule.id] }));
}

const getStatus = async (req, res) => {
  try {
    const now = Date.now();
    const [openRes, overrides, emails] = await Promise.all([
      db.query(q.openIncident),
      loadOverrides(),
      db.query(q.emailsSince, [new Date(now - 3600 * 1000)]),
    ]);
    const open = openRes.rows[0] ? store.fromRow(openRes.rows[0]) : null;
    const w = worker.status();
    const last = w.last;
    const muted = RULES.filter((r) => {
      const eff = effective(r, overrides[r.id]);
      return eff.mutedUntil && eff.mutedUntil > now;
    }).length;
    const watching = RULES.filter((r) => !r.external && effective(r, overrides[r.id]).mode === 'watch').length;
    return res.json({
      status: 'success',
      data: {
        enabled: w.enabled,
        running: w.running,
        lastTickAt: last ? iso(last.at) : null,
        tickMs: w.tickMs,
        quietHours: engine.isQuietHours(now),
        db: last ? last.db : null,
        selfCheck: last ? last.selfCheck : null,
        emailsLastHour: emails.rows[0].n,
        emailCap: Number(process.env.ALERT_MAX_EMAILS_PER_HOUR) || 6,
        recipients: notifier.recipients().length,
        pushDevices: ownerPush.tokenCount(),
        firing: open ? incidentOut(open) : null,
        rulesMuted: muted,
        rulesWatching: watching,
      },
    });
  } catch (err) {
    return fail(res, err, 'load the alert status');
  }
};

const listIncidents = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const { rows } = await db.query(q.listIncidents, [w.from]);
    const incidents = rows.map((r) => incidentOut(store.fromRow(r), { emails: r.emails, pushes: r.pushes }));
    const summaries = await db.query(q.recentSummaries, [w.from]);
    return res.json({
      status: 'success',
      data: { window: { key: w.key, from: iso(w.from), to: iso(w.to) }, incidents, otherSends: summaries.rows.map(notificationOut) },
    });
  } catch (err) {
    return fail(res, err, 'load incidents');
  }
};

const getIncident = async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ status: 'failed', message: 'Invalid incident id' });
  try {
    const [inc, sends] = await Promise.all([db.query(q.getIncident, [id]), db.query(q.incidentNotifications, [id])]);
    if (!inc.rows[0]) return res.status(404).json({ status: 'failed', message: 'This incident no longer exists' });
    const notifications = sends.rows.map(notificationOut);
    const data = incidentOut(store.fromRow(inc.rows[0]), {
      emails: notifications.filter((n) => n.channel === 'email' && n.ok).length,
      pushes: notifications.filter((n) => n.channel === 'push' && n.ok).length,
      notifications,
    });
    return res.json({ status: 'success', data: { incident: data } });
  } catch (err) {
    return fail(res, err, 'load the incident');
  }
};

const deleteIncident = async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ status: 'failed', message: 'Invalid incident id' });
  try {
    const { rows } = await db.query(q.deleteResolvedIncident, [id]);
    if (!rows[0]) {
      const exists = await db.query(q.getIncident, [id]);
      return exists.rows[0]
        ? res.status(409).json({ status: 'failed', message: 'An open incident can’t be deleted. It goes once it has recovered.' })
        : res.status(404).json({ status: 'failed', message: 'This incident no longer exists' });
    }
    return res.json({ status: 'success', data: { id } });
  } catch (err) {
    return fail(res, err, 'delete the incident');
  }
};

const listRules = async (req, res) => {
  try {
    return res.json({ status: 'success', data: { rules: await rulesPayload() } });
  } catch (err) {
    return fail(res, err, 'load the rules');
  }
};

const updateRule = async (req, res) => {
  const rule = RULE_BY_ID.get(req.params.id);
  if (!rule) return res.status(404).json({ status: 'failed', message: 'No such rule' });
  const check = validatePatch(rule, req.body);
  if (!check.ok) return res.status(400).json({ status: 'failed', message: check.error });
  try {
    const existing = (await loadOverrides())[rule.id] || {};
    const change = check.value;
    const params = { ...(existing.params || {}), ...(change.params || {}) };
    // Keep only the numbers that differ from the default.
    for (const [k, d] of Object.entries(rule.params)) if (params[k] === d.default) delete params[k];
    const enabled = change.enabled !== undefined ? change.enabled : existing.enabled ?? null;
    const mode = change.mode !== undefined ? change.mode : existing.mode ?? null;
    const mutedUntil = change.mutedUntil !== undefined ? change.mutedUntil : existing.muted_until ?? null;
    await db.query(q.upsertOverride, [
      rule.id,
      enabled === true ? null : enabled,
      mode === (rule.defaultMode || 'live') ? null : mode,
      Object.keys(params).length ? JSON.stringify(params) : null,
      mutedUntil,
      req.user.email,
    ]);
    logger.info({ ruleId: rule.id, change, by: req.user.email }, 'Alert rule changed');
    const [out] = await rulesPayload(rule.id);
    return res.json({ status: 'success', data: { rule: out } });
  } catch (err) {
    return fail(res, err, 'save the rule');
  }
};

const resetRule = async (req, res) => {
  const rule = RULE_BY_ID.get(req.params.id);
  if (!rule) return res.status(404).json({ status: 'failed', message: 'No such rule' });
  try {
    await db.query(q.deleteOverride, [rule.id]);
    logger.info({ ruleId: rule.id, by: req.user.email }, 'Alert rule reset to defaults');
    const [out] = await rulesPayload(rule.id);
    return res.json({ status: 'success', data: { rule: out } });
  } catch (err) {
    return fail(res, err, 'reset the rule');
  }
};

const sendTest = async (req, res) => {
  const channel = (req.body && req.body.channel) || 'both';
  if (!['email', 'push', 'both'].includes(channel)) {
    return res.status(400).json({ status: 'failed', message: 'channel must be email, push or both' });
  }
  try {
    const result = await notifier.sendTest(channel);
    const failed = (result.email && !result.email.ok) || (channel === 'push' && result.push && !result.push.ok);
    return res.status(failed ? 502 : 200).json({
      status: failed ? 'failed' : 'success',
      message: failed ? (result.email && result.email.error) || (result.push && result.push.error) : undefined,
      data: result,
    });
  } catch (err) {
    return fail(res, err, 'send the test alert');
  }
};

module.exports = { getStatus, listIncidents, getIncident, deleteIncident, listRules, updateRule, resetRule, sendTest };
