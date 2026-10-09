// Window params are always $1 = from, $2 = to (exclusive), and when a
// series is involved $3 = bucket interval text ('15 minutes'). Buckets are
// generated in SQL and LEFT JOINed so gaps come back as zeros.
const { featureCaseSql } = require('../services/observe/featureMap');

const FEATURE = featureCaseSql('route');
// The console's own polling never counts as product usage.
const SCOPE = `route NOT LIKE '/api/observe%'`;
const BUCKETS = `buckets AS (SELECT generate_series($1::timestamptz, $2::timestamptz - $3::interval, $3::interval) AS b)`;
const P95 = `COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms), 0)::int`;
const USER_COLS = `u.first_name, u.last_name, u.email AS user_email, u.school AS user_school, u.role AS user_role`;

const ALL_ERRORS = `
  SELECT 'server' AS source, fingerprint, route AS location, message, user_id, ts, stack, request_id,
         (context->>'statusCode')::int AS status
  FROM error_events WHERE ts >= $1 AND ts < $2
  UNION ALL
  SELECT 'client', fingerprint, page, message, user_id, ts, stack, request_id, status
  FROM client_events WHERE ts >= $1 AND ts < $2`;

const observeQueries = {
  tiles: `
    SELECT COUNT(DISTINCT user_id)::int AS active_users,
           COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE status >= 500)::int AS errors,
           COUNT(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS client_errors,
           ${P95} AS p95_ms
    FROM request_events WHERE ts >= $1 AND ts < $2 AND ${SCOPE}`,

  loginTiles: `
    SELECT COUNT(*) FILTER (WHERE outcome = 'success')::int AS logins,
           COUNT(*) FILTER (WHERE outcome <> 'success')::int AS failed_logins,
           COUNT(DISTINCT user_id) FILTER (WHERE outcome = 'success')::int AS unique_users
    FROM login_events WHERE ts >= $1 AND ts < $2`,

  onlineNow: `
    SELECT COUNT(*)::int AS online_now FROM users
    WHERE last_seen_at > NOW() - INTERVAL '10 minutes' AND NOT is_archived`,

  // $4 optional user_id filter (pass null for all)
  requestSeries: `
    WITH ${BUCKETS},
    agg AS (
      SELECT date_bin($3::interval, ts, $1::timestamptz) AS b,
             COUNT(*)::int AS requests,
             COUNT(*) FILTER (WHERE status >= 500)::int AS errors,
             COUNT(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS client_errors,
             COUNT(DISTINCT user_id)::int AS active_users,
             ${P95} AS p95_ms
      FROM request_events
      WHERE ts >= $1 AND ts < $2 AND ${SCOPE} AND ($4::uuid IS NULL OR user_id = $4::uuid)
      GROUP BY 1)
    SELECT buckets.b AS ts, COALESCE(requests, 0) AS requests, COALESCE(errors, 0) AS errors,
           COALESCE(client_errors, 0) AS client_errors, COALESCE(active_users, 0) AS active_users, COALESCE(p95_ms, 0) AS p95_ms
    FROM buckets LEFT JOIN agg ON agg.b = buckets.b ORDER BY buckets.b`,

  loginSeries: `
    WITH ${BUCKETS},
    agg AS (
      SELECT date_bin($3::interval, ts, $1::timestamptz) AS b,
             COUNT(*) FILTER (WHERE outcome = 'success')::int AS success,
             COUNT(*) FILTER (WHERE outcome <> 'success')::int AS failed
      FROM login_events WHERE ts >= $1 AND ts < $2 GROUP BY 1)
    SELECT buckets.b AS ts, COALESCE(success, 0) AS success, COALESCE(failed, 0) AS failed
    FROM buckets LEFT JOIN agg ON agg.b = buckets.b ORDER BY buckets.b`,

  // $3 limit
  topFeatures: `
    SELECT ${FEATURE} AS feature, COUNT(*)::int AS requests, COUNT(DISTINCT user_id)::int AS users,
           COUNT(*) FILTER (WHERE status >= 500)::int AS errors, ${P95} AS p95_ms
    FROM request_events WHERE ts >= $1 AND ts < $2 AND ${SCOPE}
    GROUP BY 1 ORDER BY requests DESC LIMIT $3`,

  featureRoutes: `
    SELECT ${FEATURE} AS feature, method, route, COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE status >= 500)::int AS errors, ${P95} AS p95_ms
    FROM request_events WHERE ts >= $1 AND ts < $2 AND ${SCOPE}
    GROUP BY 1, 2, 3 ORDER BY requests DESC LIMIT 300`,

  // $4 how many top features to chart
  featureSeries: `
    WITH top AS (
      SELECT ${FEATURE} AS feature FROM request_events
      WHERE ts >= $1 AND ts < $2 AND ${SCOPE} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT $4)
    SELECT date_bin($3::interval, ts, $1::timestamptz) AS ts, ${FEATURE} AS feature, COUNT(*)::int AS requests
    FROM request_events
    WHERE ts >= $1 AND ts < $2 AND ${SCOPE} AND ${FEATURE} IN (SELECT feature FROM top)
    GROUP BY 1, 2 ORDER BY 1`,

  // $3 limit
  errorGroups: `
    WITH all_errors AS (${ALL_ERRORS})
    SELECT fingerprint, MIN(source) AS source, MIN(location) AS location,
           (array_agg(message ORDER BY ts DESC))[1] AS message,
           COUNT(*)::int AS count, COUNT(DISTINCT user_id)::int AS users,
           MIN(ts) AS first_seen, MAX(ts) AS last_seen,
           (array_agg(stack ORDER BY ts DESC))[1] AS sample_stack,
           (array_agg(request_id ORDER BY ts DESC))[1] AS sample_request_id
    FROM all_errors GROUP BY fingerprint ORDER BY count DESC, last_seen DESC LIMIT $3`,

  // $3 bucket, $4 text[] fingerprints
  errorGroupSeries: `
    WITH all_errors AS (${ALL_ERRORS})
    SELECT fingerprint, date_bin($3::interval, ts, $1::timestamptz) AS ts, COUNT(*)::int AS count
    FROM all_errors WHERE fingerprint = ANY($4::text[]) GROUP BY 1, 2`,

  // $3 limit, $4 optional user_id
  recentErrors: `
    WITH all_errors AS (${ALL_ERRORS})
    SELECT e.ts, e.source, e.fingerprint, e.location, e.message, e.status, e.request_id, e.user_id, ${USER_COLS}
    FROM all_errors e LEFT JOIN users u ON u.user_id = e.user_id
    WHERE ($4::uuid IS NULL OR e.user_id = $4::uuid)
    ORDER BY e.ts DESC LIMIT $3`,

  // $3 fingerprint
  errorGroupDetail: `
    WITH all_errors AS (${ALL_ERRORS})
    SELECT fingerprint, MIN(source) AS source, MIN(location) AS location,
           (array_agg(message ORDER BY ts DESC))[1] AS message,
           COUNT(*)::int AS count, COUNT(DISTINCT user_id)::int AS users,
           MIN(ts) AS first_seen, MAX(ts) AS last_seen,
           (array_agg(stack ORDER BY ts DESC))[1] AS sample_stack,
           (array_agg(request_id ORDER BY ts DESC))[1] AS sample_request_id
    FROM all_errors WHERE fingerprint = $3 GROUP BY fingerprint`,

  errorOccurrences: `
    WITH all_errors AS (${ALL_ERRORS})
    SELECT e.ts, e.source, e.location, e.message, e.stack, e.request_id, e.status, e.user_id, ${USER_COLS}
    FROM all_errors e LEFT JOIN users u ON u.user_id = e.user_id
    WHERE e.fingerprint = $3 ORDER BY e.ts DESC LIMIT 100`,

  errorAffectedUsers: `
    WITH all_errors AS (${ALL_ERRORS})
    SELECT e.user_id, COUNT(*)::int AS count, MAX(e.ts) AS last_seen, ${USER_COLS}
    FROM all_errors e LEFT JOIN users u ON u.user_id = e.user_id
    WHERE e.fingerprint = $3 AND e.user_id IS NOT NULL
    GROUP BY e.user_id, u.first_name, u.last_name, u.email, u.school, u.role ORDER BY count DESC LIMIT 50`,

  // $1 limit (no window: the feed is always "latest")
  feed: `
    SELECT r.ts, r.request_id, r.method, r.route, r.path, r.status, r.duration_ms, r.error_message,
           r.user_id, r.impersonator_id, ${USER_COLS}
    FROM request_events r LEFT JOIN users u ON u.user_id = r.user_id
    WHERE ${SCOPE} ORDER BY r.ts DESC LIMIT $1`,

  usersList: `
    WITH ev AS (
      SELECT user_id, status, ${FEATURE} AS feature FROM request_events
      WHERE ts >= $1 AND ts < $2 AND user_id IS NOT NULL AND ${SCOPE}),
    agg AS (SELECT user_id, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE status >= 500)::int AS errors FROM ev GROUP BY user_id),
    feat AS (
      SELECT DISTINCT ON (user_id) user_id, feature
      FROM (SELECT user_id, feature, COUNT(*) AS c FROM ev GROUP BY 1, 2) f
      ORDER BY user_id, c DESC, feature)
    SELECT u.user_id, u.first_name, u.last_name, u.email, u.school, u.role, u.last_seen_at, u.last_login_at,
           (u.last_seen_at > NOW() - INTERVAL '10 minutes') AS online_now,
           COALESCE(agg.requests, 0) AS requests, COALESCE(agg.errors, 0) AS errors, feat.feature AS top_feature
    FROM users u LEFT JOIN agg ON agg.user_id = u.user_id LEFT JOIN feat ON feat.user_id = u.user_id
    WHERE NOT u.is_archived
    ORDER BY u.last_seen_at DESC NULLS LAST, u.last_name, u.first_name`,

  userProfile: `
    SELECT user_id, first_name, last_name, email, school, role, last_seen_at, last_login_at, created_at, is_archived
    FROM users WHERE user_id = $1`,

  // $1 user_id, $2 from, $3 to
  userFeatures: `
    SELECT ${FEATURE} AS feature, COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE status >= 500)::int AS errors
    FROM request_events WHERE user_id = $1 AND ts >= $2 AND ts < $3 AND ${SCOPE}
    GROUP BY 1 ORDER BY requests DESC`,

  userRecentRequests: `
    SELECT ts, request_id, method, route, path, status, duration_ms, error_message, impersonator_id
    FROM request_events WHERE user_id = $1 AND ${SCOPE} ORDER BY ts DESC LIMIT 100`,

  // $1 user_id, $2 email
  userLogins: `
    SELECT ts, outcome, ip, user_agent FROM login_events
    WHERE user_id = $1 OR email = LOWER($2) ORDER BY ts DESC LIMIT 20`,

  bySchool: `
    SELECT school, COUNT(DISTINCT user_id)::int AS users, COUNT(*)::int AS requests
    FROM request_events WHERE ts >= $1 AND ts < $2 AND ${SCOPE} AND school IS NOT NULL
    GROUP BY 1 ORDER BY users DESC, requests DESC`,

  byRole: `
    SELECT role, COUNT(DISTINCT user_id)::int AS users, COUNT(*)::int AS requests
    FROM request_events WHERE ts >= $1 AND ts < $2 AND ${SCOPE} AND role IS NOT NULL
    GROUP BY 1 ORDER BY users DESC, requests DESC`,

  heatmap: `
    SELECT EXTRACT(DOW FROM ts AT TIME ZONE 'America/Toronto')::int AS dow,
           EXTRACT(HOUR FROM ts AT TIME ZONE 'America/Toronto')::int AS hour,
           COUNT(*)::int AS requests, COUNT(DISTINCT user_id)::int AS users
    FROM request_events WHERE ts >= $1 AND ts < $2 AND ${SCOPE} GROUP BY 1, 2`,

  // $3 limit
  recentLogins: `
    SELECT l.ts, l.email, l.outcome, l.ip, l.user_agent, l.school, l.user_id, ${USER_COLS}
    FROM login_events l LEFT JOIN users u ON u.user_id = l.user_id
    WHERE l.ts >= $1 AND l.ts < $2 ORDER BY l.ts DESC LIMIT $3`,

  failedByEmail: `
    SELECT email, COUNT(*)::int AS attempts, MAX(ts) AS last_at, array_agg(DISTINCT outcome) AS outcomes
    FROM login_events WHERE ts >= $1 AND ts < $2 AND outcome <> 'success'
    GROUP BY email ORDER BY attempts DESC, last_at DESC LIMIT 20`,
};

module.exports = observeQueries;
