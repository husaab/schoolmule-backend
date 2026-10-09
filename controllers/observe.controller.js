const logger = require('../logger');
const q = require('../queries/observe.queries');
const { withTimedClient } = require('../services/observe/timedQuery');
const { parseWindow } = require('../services/observe/window');
const railway = require('../services/observe/railwayMetrics');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_LIMIT = 50;
const TOP_FEATURE_SERIES = 8;

const windowOut = (w) => ({ key: w.key, from: w.from.toISOString(), to: w.to.toISOString(), bucket: w.bucket });
const winArgs = (w) => [w.from, w.to];
const prevArgs = (w) => [w.prevFrom, w.from];
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const rate = (part, whole) => (whole > 0 ? part / whole : 0);

const userOf = (row) =>
  row.user_id
    ? {
        id: row.user_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.user_email || 'Unknown',
        email: row.user_email || null,
        school: row.user_school || null,
        role: row.user_role || null,
      }
    : null;

const seriesPoint = (r) => ({
  ts: iso(r.ts),
  requests: num(r.requests),
  errors: num(r.errors),
  clientErrors: num(r.client_errors),
  activeUsers: num(r.active_users),
  p95Ms: num(r.p95_ms),
});

const requestRow = (r) => ({
  ts: iso(r.ts),
  requestId: r.request_id,
  method: r.method,
  route: r.route,
  path: r.path,
  status: num(r.status),
  durationMs: num(r.duration_ms),
  errorMessage: r.error_message || null,
  impersonated: Boolean(r.impersonator_id),
});

const errorRow = (r) => ({
  ts: iso(r.ts),
  source: r.source,
  fingerprint: r.fingerprint,
  location: r.location,
  message: r.message,
  status: r.status === null || r.status === undefined ? null : num(r.status),
  requestId: r.request_id || null,
  user: userOf(r),
});

const groupRow = (g) => ({
  fingerprint: g.fingerprint,
  source: g.source,
  location: g.location,
  message: g.message,
  count: num(g.count),
  users: num(g.users),
  firstSeen: iso(g.first_seen),
  lastSeen: iso(g.last_seen),
  sampleStack: g.sample_stack || null,
  sampleRequestId: g.sample_request_id || null,
});

const tilesOf = (t, l) => {
  const requests = num(t.requests);
  const errors = num(t.errors);
  return {
    activeUsers: num(t.active_users),
    requests,
    errors,
    clientErrors: num(t.client_errors),
    errorRate: rate(errors, requests),
    p95Ms: num(t.p95_ms),
    logins: num(l.logins),
    failedLogins: num(l.failed_logins),
  };
};

// Zero-filled bucket list for client-side sparklines of grouped rows.
function bucketIndex(w) {
  const n = Math.round(w.spanMs / w.bucketMs);
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(w.from.getTime() + i * w.bucketMs, i);
  return { n, index };
}
const bucketTs = (w, i) => new Date(w.from.getTime() + i * w.bucketMs).toISOString();

const fail = (res, err, what) => {
  logger.error({ err }, `Observe: ${what} failed`);
  return res.status(500).json({ status: 'failed', message: `Could not load ${what}` });
};

const getOverview = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const tiles = await run(q.tiles, winArgs(w));
      const prev = await run(q.tiles, prevArgs(w));
      const logins = await run(q.loginTiles, winArgs(w));
      const prevLogins = await run(q.loginTiles, prevArgs(w));
      const online = await run(q.onlineNow, []);
      const series = await run(q.requestSeries, [...winArgs(w), w.bucket, null]);
      const topFeatures = await run(q.topFeatures, [...winArgs(w), 5]);
      const topErrors = await run(q.errorGroups, [...winArgs(w), 5]);
      const feed = await run(q.feed, [FEED_LIMIT]);
      return {
        window: windowOut(w),
        tiles: { ...tilesOf(tiles.rows[0], logins.rows[0]), onlineNow: num(online.rows[0].online_now) },
        prev: tilesOf(prev.rows[0], prevLogins.rows[0]),
        series: series.rows.map(seriesPoint),
        topFeatures: topFeatures.rows.map((r) => ({ feature: r.feature, requests: num(r.requests), users: num(r.users), errors: num(r.errors), p95Ms: num(r.p95_ms) })),
        topErrors: topErrors.rows.map((g) => ({ fingerprint: g.fingerprint, source: g.source, location: g.location, message: g.message, count: num(g.count), users: num(g.users), lastSeen: iso(g.last_seen) })),
        feed: feed.rows.map((r) => ({ ...requestRow(r), user: userOf(r) })),
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'overview');
  }
};

const getActivity = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const series = await run(q.requestSeries, [...winArgs(w), w.bucket, null]);
      const bySchool = await run(q.bySchool, winArgs(w));
      const byRole = await run(q.byRole, winArgs(w));
      const heatmap = await run(q.heatmap, winArgs(w));
      return {
        window: windowOut(w),
        series: series.rows.map((r) => ({ ts: iso(r.ts), requests: num(r.requests), activeUsers: num(r.active_users) })),
        bySchool: bySchool.rows.map((r) => ({ school: r.school, users: num(r.users), requests: num(r.requests) })),
        byRole: byRole.rows.map((r) => ({ role: r.role, users: num(r.users), requests: num(r.requests) })),
        heatmap: heatmap.rows.map((r) => ({ dow: num(r.dow), hour: num(r.hour), requests: num(r.requests), users: num(r.users) })),
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'activity');
  }
};

const getUsers = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const { rows } = await run(q.usersList, winArgs(w));
      return {
        window: windowOut(w),
        users: rows.map((r) => ({
          id: r.user_id,
          name: `${r.first_name} ${r.last_name}`,
          email: r.email,
          school: r.school,
          role: r.role,
          lastSeenAt: iso(r.last_seen_at),
          lastLoginAt: iso(r.last_login_at),
          onlineNow: Boolean(r.online_now),
          requests: num(r.requests),
          errors: num(r.errors),
          topFeature: r.top_feature || null,
        })),
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'users');
  }
};

const getUser = async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ status: 'failed', message: 'Invalid user id' });
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const profile = await run(q.userProfile, [id]);
      if (profile.rows.length === 0) return null;
      const u = profile.rows[0];
      const series = await run(q.requestSeries, [...winArgs(w), w.bucket, id]);
      const features = await run(q.userFeatures, [id, ...winArgs(w)]);
      const recent = await run(q.userRecentRequests, [id]);
      const errors = await run(q.recentErrors, [...winArgs(w), 50, id]);
      const logins = await run(q.userLogins, [id, u.email]);
      return {
        window: windowOut(w),
        user: {
          id: u.user_id,
          name: `${u.first_name} ${u.last_name}`,
          email: u.email,
          school: u.school,
          role: u.role,
          lastSeenAt: iso(u.last_seen_at),
          lastLoginAt: iso(u.last_login_at),
          createdAt: iso(u.created_at),
          isArchived: Boolean(u.is_archived),
        },
        series: series.rows.map((r) => ({ ts: iso(r.ts), requests: num(r.requests), errors: num(r.errors) })),
        features: features.rows.map((r) => ({ feature: r.feature, requests: num(r.requests), errors: num(r.errors) })),
        recentRequests: recent.rows.map(requestRow),
        recentErrors: errors.rows.map((r) => ({ ts: iso(r.ts), source: r.source, fingerprint: r.fingerprint, location: r.location, message: r.message, requestId: r.request_id || null })),
        logins: logins.rows.map((r) => ({ ts: iso(r.ts), outcome: r.outcome, ip: r.ip, userAgent: r.user_agent })),
      };
    });
    if (!data) return res.status(404).json({ status: 'failed', message: 'User not found' });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'user');
  }
};

const getFeatures = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const features = await run(q.topFeatures, [...winArgs(w), 100]);
      const routes = await run(q.featureRoutes, winArgs(w));
      const series = await run(q.featureSeries, [...winArgs(w), w.bucket, TOP_FEATURE_SERIES]);
      const routesByFeature = new Map();
      for (const r of routes.rows) {
        if (!routesByFeature.has(r.feature)) routesByFeature.set(r.feature, []);
        routesByFeature.get(r.feature).push({ method: r.method, route: r.route, requests: num(r.requests), errors: num(r.errors), p95Ms: num(r.p95_ms) });
      }
      const { n, index } = bucketIndex(w);
      const keys = [...new Set(series.rows.map((r) => r.feature))];
      const points = Array.from({ length: n }, (_, i) => ({ ts: bucketTs(w, i) }));
      for (const p of points) for (const k of keys) p[k] = 0;
      for (const r of series.rows) {
        const i = index.get(new Date(r.ts).getTime());
        if (i !== undefined) points[i][r.feature] = num(r.requests);
      }
      return {
        window: windowOut(w),
        features: features.rows.map((r) => {
          const requests = num(r.requests);
          const errors = num(r.errors);
          return { feature: r.feature, requests, users: num(r.users), errors, errorRate: rate(errors, requests), p95Ms: num(r.p95_ms), routes: routesByFeature.get(r.feature) || [] };
        }),
        series: points,
        seriesKeys: keys,
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'features');
  }
};

const getErrors = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const groups = await run(q.errorGroups, [...winArgs(w), 50]);
      const recent = await run(q.recentErrors, [...winArgs(w), 100, null]);
      const bySource = await run(q.errorSeriesBySource, [...winArgs(w), w.bucket]);
      const fps = groups.rows.map((g) => g.fingerprint);
      const sparks = fps.length ? await run(q.errorGroupSeries, [...winArgs(w), w.bucket, fps]) : { rows: [] };
      const { n, index } = bucketIndex(w);
      const sparkByFp = new Map(fps.map((fp) => [fp, new Array(n).fill(0)]));
      for (const r of sparks.rows) {
        const i = index.get(new Date(r.ts).getTime());
        if (i !== undefined) sparkByFp.get(r.fingerprint)[i] = num(r.count);
      }
      return {
        window: windowOut(w),
        groups: groups.rows.map((g) => ({ ...groupRow(g), spark: sparkByFp.get(g.fingerprint) })),
        recent: recent.rows.map(errorRow),
        series: bySource.rows.map((r) => ({ ts: iso(r.ts), server: num(r.server), client: num(r.client) })),
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'errors');
  }
};

// One slice of the error chart: every error between from and to (max 12 h),
// with stacks, plus per-group counts so a spike reads as "what broke".
const RANGE_MAX_MS = 12 * 60 * 60 * 1000;
const getErrorsRange = async (req, res) => {
  const from = new Date(String(req.query.from || ''));
  const to = new Date(String(req.query.to || ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return res.status(400).json({ status: 'failed', message: 'from and to must be ISO timestamps with from < to' });
  }
  if (to.getTime() - from.getTime() > RANGE_MAX_MS) {
    return res.status(400).json({ status: 'failed', message: 'Range too wide (max 12 hours)' });
  }
  try {
    const data = await withTimedClient(async (run) => {
      const { rows } = await run(q.errorsInRange, [from, to, 200]);
      const byFp = new Map();
      for (const r of rows) {
        const g = byFp.get(r.fingerprint) || { fingerprint: r.fingerprint, source: r.source, location: r.location, message: r.message, count: 0 };
        g.count += 1;
        byFp.set(r.fingerprint, g);
      }
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        errors: rows.map((r) => ({ ...errorRow(r), stack: r.stack || null })),
        groups: [...byFp.values()].sort((a, b) => b.count - a.count),
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'error range');
  }
};

const getErrorGroup = async (req, res) => {
  const { fingerprint } = req.params;
  if (!/^[0-9a-z]{1,64}$/i.test(fingerprint)) return res.status(400).json({ status: 'failed', message: 'Invalid fingerprint' });
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const group = await run(q.errorGroupDetail, [...winArgs(w), fingerprint]);
      if (group.rows.length === 0) return null;
      const occ = await run(q.errorOccurrences, [...winArgs(w), fingerprint]);
      const affected = await run(q.errorAffectedUsers, [...winArgs(w), fingerprint]);
      const series = await run(q.errorGroupSeries, [...winArgs(w), w.bucket, [fingerprint]]);
      const { n, index } = bucketIndex(w);
      const counts = new Array(n).fill(0);
      for (const r of series.rows) {
        const i = index.get(new Date(r.ts).getTime());
        if (i !== undefined) counts[i] = num(r.count);
      }
      return {
        window: windowOut(w),
        group: groupRow(group.rows[0]),
        series: counts.map((count, i) => ({ ts: bucketTs(w, i), count })),
        occurrences: occ.rows.map((r) => ({ ts: iso(r.ts), source: r.source, location: r.location, message: r.message, stack: r.stack || null, requestId: r.request_id || null, status: r.status === null || r.status === undefined ? null : num(r.status), user: userOf(r) })),
        affectedUsers: affected.rows.map((r) => ({ user: userOf(r), count: num(r.count), lastSeen: iso(r.last_seen) })),
      };
    });
    if (!data) return res.status(404).json({ status: 'failed', message: 'Error group not found' });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'error group');
  }
};

const getLogins = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await withTimedClient(async (run) => {
      const tiles = await run(q.loginTiles, winArgs(w));
      const series = await run(q.loginSeries, [...winArgs(w), w.bucket]);
      const recent = await run(q.recentLogins, [...winArgs(w), 100]);
      const failed = await run(q.failedByEmail, winArgs(w));
      const t = tiles.rows[0];
      return {
        window: windowOut(w),
        tiles: { logins: num(t.logins), failedLogins: num(t.failed_logins), uniqueUsers: num(t.unique_users) },
        series: series.rows.map((r) => ({ ts: iso(r.ts), success: num(r.success), failed: num(r.failed) })),
        recent: recent.rows.map((r) => ({ ts: iso(r.ts), email: r.email, outcome: r.outcome, ip: r.ip, userAgent: r.user_agent, user: userOf(r) })),
        failedByEmail: failed.rows.map((r) => ({ email: r.email, attempts: num(r.attempts), lastAt: iso(r.last_at), outcomes: r.outcomes })),
      };
    });
    return res.json({ status: 'success', data });
  } catch (err) {
    return fail(res, err, 'logins');
  }
};

const getInfra = async (req, res) => {
  const w = parseWindow(req.query.window);
  try {
    const data = await railway.getInfra(w);
    return res.json({ status: 'success', data: { window: windowOut(w), ...data } });
  } catch (err) {
    return fail(res, err, 'infra');
  }
};

module.exports = { getOverview, getActivity, getUsers, getUser, getFeatures, getErrors, getErrorsRange, getErrorGroup, getLogins, getInfra };
