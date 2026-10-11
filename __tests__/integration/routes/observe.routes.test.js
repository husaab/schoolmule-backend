const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const OWNER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440002';

// Synthetic identities only.
const insertUser = (pool, { id, email, first, last, role, school = 'ALHAADIACADEMY', lastSeen = null }) =>
  pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, last_seen_at)
     VALUES ($1,$2,$3,'hashed',$4,$5,$6,$7,true,true,$8)`,
    [id, email, `${first} ${last}`, first, last, school, role, lastSeen]
  );

const ago = (minutes) => new Date(Date.now() - minutes * 60000);

const insertRequest = (pool, { ts, userId, role = 'TEACHER', route, status = 200, duration = 50, message = null, school = 'ALHAADIACADEMY' }) =>
  pool.query(
    `INSERT INTO request_events (ts, request_id, user_id, school, role, method, route, path, status, duration_ms, error_message)
     VALUES ($1, gen_random_uuid()::text, $2, $3, $4, 'GET', $5, $5, $6, $7, $8)`,
    [ts, userId, school, role, route, status, duration, message]
  );

// authenticatedRequest signs a payload; these are the claims, not tokens.
const ownerToken = () => ({ userId: OWNER_ID, email: 'owner@test.com', role: 'ADMIN' });
const adminToken = () => ({ userId: TEACHER_ID, email: 'admin@test.com', role: 'ADMIN' });
const get = (url, token = ownerToken()) => authenticatedRequest('get', url, token);

describe('Integration: /api/observe', () => {
  let pool;
  beforeAll(() => { getApp(); pool = getTestPool(); process.env.PLATFORM_OWNER_EMAILS = 'owner@test.com'; process.env.OBSERVE_DISABLED = 'true'; });
  afterAll(() => { delete process.env.PLATFORM_OWNER_EMAILS; });

  beforeEach(async () => {
    await insertUser(pool, { id: OWNER_ID, email: 'owner@test.com', first: 'Own', last: 'Er', role: 'ADMIN', lastSeen: ago(1) });
    await insertUser(pool, { id: TEACHER_ID, email: 'admin@test.com', first: 'Tee', last: 'Cher', role: 'TEACHER', lastSeen: ago(60) });
    await insertUser(pool, { id: PARENT_ID, email: 'parent@test.com', first: 'Pa', last: 'Rent', role: 'PARENT' });
    await insertRequest(pool, { ts: ago(5), userId: TEACHER_ID, route: '/api/classes' });
    await insertRequest(pool, { ts: ago(6), userId: TEACHER_ID, route: '/api/classes/:id', status: 500, message: 'Error fetching class' });
    await insertRequest(pool, { ts: ago(7), userId: PARENT_ID, role: 'PARENT', route: '/api/parent-portal/children', status: 404, message: 'Not found' });
    await insertRequest(pool, { ts: ago(8), userId: OWNER_ID, role: 'ADMIN', route: '/api/observe/overview' }); // excluded from stats
    await insertRequest(pool, { ts: ago(26 * 60), userId: TEACHER_ID, route: '/api/classes' });                // previous window
    await pool.query(
      `INSERT INTO error_events (ts, source, request_id, user_id, school, route, message, stack, fingerprint)
       VALUES ($1,'server','r1',$2,'ALHAADIACADEMY','/api/classes/:id','Error fetching class: relation missing','Error: x\n at y','fp1'),
              ($3,'server','r2',$2,'ALHAADIACADEMY','/api/classes/:id','Error fetching class: relation missing','Error: x\n at y','fp1')`,
      [ago(6), TEACHER_ID, ago(3)]
    );
    await pool.query(
      `INSERT INTO client_events (ts, user_id, school, role, kind, message, page, fingerprint)
       VALUES ($1,$2,'ALHAADIACADEMY','PARENT','js_error','Cannot read x','/parent/dashboard','fpc')`,
      [ago(2), PARENT_ID]
    );
    await pool.query(
      `INSERT INTO login_events (ts, email, user_id, school, outcome, ip) VALUES
       ($1,'admin@test.com',$2,'ALHAADIACADEMY','success','1.1.1.1'),
       ($3,'ghost@test.com',NULL,NULL,'unknown_email','2.2.2.2'),
       ($3,'ghost@test.com',NULL,NULL,'unknown_email','2.2.2.2')`,
      [ago(10), TEACHER_ID, ago(4)]
    );
  });

  describe('gate', () => {
    it('403s a school admin', async () => {
      const res = await get('/api/observe/overview', adminToken());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ status: 'failed', message: 'Forbidden' });
    });
    it('403s an impersonating owner', async () => {
      const res = await get('/api/observe/overview', { userId: OWNER_ID, email: 'owner@test.com', impersonator: { userId: 'x' } });
      expect(res.status).toBe(403);
    });
    it('401s with no token', async () => {
      const res = await require('supertest')(getApp()).get('/api/observe/overview');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /overview', () => {
    it('aggregates the window and excludes observe traffic', async () => {
      const res = await get('/api/observe/overview?window=24h');
      expect(res.status).toBe(200);
      const { tiles, prev, series, topFeatures, topErrors, feed, window } = res.body.data;
      expect(window.key).toBe('24h');
      expect(tiles).toEqual(expect.objectContaining({ activeUsers: 2, requests: 3, errors: 1, clientErrors: 1, logins: 1, failedLogins: 2, onlineNow: 1 }));
      expect(tiles.errorRate).toBeCloseTo(1 / 3, 5);
      expect(prev.requests).toBe(1);
      expect(series).toHaveLength(96);
      expect(series.reduce((n, p) => n + p.requests, 0)).toBe(3);
      expect(topFeatures[0]).toEqual(expect.objectContaining({ feature: 'Classes', requests: 2, errors: 1 }));
      expect(topErrors[0]).toEqual(expect.objectContaining({ fingerprint: 'fp1', count: 2, users: 1 }));
      expect(feed[0].user).toEqual(expect.objectContaining({ name: 'Tee Cher' }));
      expect(feed.find((f) => f.status === 500).errorMessage).toBe('Error fetching class');
    });
    it('returns zeros, not nulls, for an empty window', async () => {
      await pool.query('TRUNCATE request_events, login_events, error_events, client_events');
      const res = await get('/api/observe/overview?window=1h');
      expect(res.body.data.tiles).toEqual(expect.objectContaining({ requests: 0, errors: 0, errorRate: 0, p95Ms: 0, activeUsers: 0 }));
      expect(res.body.data.series).toHaveLength(60);
      expect(res.body.data.series[0]).toEqual(expect.objectContaining({ requests: 0, errors: 0, activeUsers: 0 }));
    });
    it('falls back to 24h on a bad window', async () => {
      const res = await get('/api/observe/overview?window=1y');
      expect(res.body.data.window.key).toBe('24h');
    });
  });

  it('GET /activity breaks down by school, role and hour', async () => {
    const res = await get('/api/observe/activity?window=7d');
    expect(res.status).toBe(200);
    const { bySchool, byRole, heatmap, series } = res.body.data;
    expect(bySchool).toEqual([{ school: 'ALHAADIACADEMY', users: 2, requests: 4 }]);
    expect(byRole.map((r) => r.role).sort()).toEqual(['PARENT', 'TEACHER']);
    expect(heatmap.reduce((n, h) => n + h.requests, 0)).toBe(4);
    expect(series).toHaveLength(168);
  });

  it('GET /users lists everyone with window stats and online flag', async () => {
    const res = await get('/api/observe/users?window=24h');
    const users = res.body.data.users;
    const teacher = users.find((u) => u.id === TEACHER_ID);
    expect(teacher).toEqual(expect.objectContaining({ name: 'Tee Cher', requests: 2, errors: 1, topFeature: 'Classes', onlineNow: false }));
    expect(users.find((u) => u.id === OWNER_ID).onlineNow).toBe(true);
    expect(users.find((u) => u.id === PARENT_ID).requests).toBe(1);
  });

  it('GET /users/:id returns the profile and history', async () => {
    const res = await get(`/api/observe/users/${TEACHER_ID}?window=24h`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.user).toEqual(expect.objectContaining({ email: 'admin@test.com', role: 'TEACHER' }));
    expect(d.recentRequests).toHaveLength(3);
    expect(d.features).toEqual([{ feature: 'Classes', requests: 2, errors: 1 }]);
    expect(d.recentErrors).toHaveLength(2);
    expect(d.logins[0]).toEqual(expect.objectContaining({ outcome: 'success', ip: '1.1.1.1' }));
    expect(d.series).toHaveLength(96);
  });

  it('GET /users/:id 404s an unknown id and 400s a bad id', async () => {
    expect((await get('/api/observe/users/550e8400-e29b-41d4-a716-446655440099')).status).toBe(404);
    expect((await get('/api/observe/users/nope')).status).toBe(400);
  });

  it('GET /features groups routes and pivots a series', async () => {
    const res = await get('/api/observe/features?window=24h');
    const { features, series, seriesKeys } = res.body.data;
    expect(features[0]).toEqual(expect.objectContaining({ feature: 'Classes', requests: 2, users: 1, errors: 1 }));
    expect(features[0].routes).toEqual(expect.arrayContaining([expect.objectContaining({ route: '/api/classes/:id', errors: 1 })]));
    expect(seriesKeys).toEqual(expect.arrayContaining(['Classes', 'Parent portal']));
    expect(series.reduce((n, p) => n + (p.Classes || 0), 0)).toBe(2);
  });

  it('GET /errors merges server and client groups with sparklines', async () => {
    const res = await get('/api/observe/errors?window=24h');
    const { groups, recent } = res.body.data;
    expect(groups.map((g) => g.fingerprint)).toEqual(['fp1', 'fpc']);
    expect(groups[0]).toEqual(expect.objectContaining({ source: 'server', count: 2, users: 1, location: '/api/classes/:id' }));
    expect(groups[0].spark).toHaveLength(96);
    expect(groups[0].spark.reduce((a, b) => a + b, 0)).toBe(2);
    expect(recent[0]).toEqual(expect.objectContaining({ source: 'client', message: 'Cannot read x' }));
    expect(recent[0].user).toEqual(expect.objectContaining({ name: 'Pa Rent', role: 'PARENT' }));
  });

  it('GET /errors carries a per-bucket series split by source', async () => {
    const res = await get('/api/observe/errors?window=24h');
    const { series } = res.body.data;
    expect(series).toHaveLength(96);
    expect(series.reduce((n, p) => n + p.server, 0)).toBe(2);
    expect(series.reduce((n, p) => n + p.client, 0)).toBe(1);
    expect(series[0]).toEqual(expect.objectContaining({ ts: expect.any(String), server: 0, client: 0 }));
  });

  it('GET /errors/range drills into one time slice with stacks and group counts', async () => {
    const from = ago(7).toISOString();
    const to = ago(2.5).toISOString();
    const res = await get(`/api/observe/errors/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.from).toBe(new Date(from).toISOString());
    expect(d.errors).toHaveLength(2);
    expect(d.errors[0]).toEqual(expect.objectContaining({ fingerprint: 'fp1', stack: expect.stringContaining('Error: x'), user: expect.objectContaining({ name: 'Tee Cher' }) }));
    expect(d.groups).toEqual([expect.objectContaining({ fingerprint: 'fp1', count: 2, source: 'server' })]);
    expect((await get('/api/observe/errors/range?from=nope&to=2026-01-01')).status).toBe(400);
    expect((await get(`/api/observe/errors/range?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`)).status).toBe(400);
  });

  it('GET /errors/:fingerprint returns occurrences and affected users', async () => {
    const res = await get('/api/observe/errors/fp1?window=24h');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.group).toEqual(expect.objectContaining({ fingerprint: 'fp1', count: 2 }));
    expect(d.occurrences).toHaveLength(2);
    expect(d.occurrences[0].stack).toContain('Error: x');
    expect(d.affectedUsers).toEqual([expect.objectContaining({ count: 2, user: expect.objectContaining({ name: 'Tee Cher' }) })]);
    expect(d.series.reduce((n, p) => n + p.count, 0)).toBe(2);
    expect((await get('/api/observe/errors/nothing')).status).toBe(404);
  });

  it('GET /logins returns series, recent and repeat failures', async () => {
    const res = await get('/api/observe/logins?window=24h');
    const d = res.body.data;
    expect(d.tiles).toEqual({ logins: 1, failedLogins: 2, uniqueUsers: 1 });
    expect(d.series.reduce((n, p) => n + p.failed, 0)).toBe(2);
    expect(d.recent[0]).toEqual(expect.objectContaining({ email: 'ghost@test.com', outcome: 'unknown_email' }));
    expect(d.recent.find((r) => r.outcome === 'success').user).toEqual(expect.objectContaining({ name: 'Tee Cher' }));
    expect(d.failedByEmail).toEqual([expect.objectContaining({ email: 'ghost@test.com', attempts: 2, outcomes: ['unknown_email'] })]);
  });
});

describe('Integration: /api/observe/scanner', () => {
  let pool;
  const POLLER_ID = '550e8400-e29b-41d4-a716-446655440010';
  const CLICKER_ID = '550e8400-e29b-41d4-a716-446655440011';
  const UNREAD = '/api/messaging/conversations/unread-count';
  const YEARS = '/api/school-years';

  // n requests from one user to one route, `stepMs` apart, starting at `start`.
  const insertStream = (userId, route, { n, stepMs, start, status = 304, offsetMs = 0 }) =>
    pool.query(
      `INSERT INTO request_events (ts, request_id, user_id, school, role, method, route, path, status, duration_ms)
       SELECT $1::timestamptz + ($5::int + i * $4::int) * INTERVAL '1 millisecond', gen_random_uuid()::text, $2, 'ALHAADIACADEMY', 'TEACHER', 'GET', $3, $3, $6, 20
       FROM generate_series(0, $7::int - 1) AS i`,
      [start, userId, route, stepMs, offsetMs, status, n]
    );

  beforeAll(() => { getApp(); pool = getTestPool(); process.env.PLATFORM_OWNER_EMAILS = 'owner@test.com'; process.env.OBSERVE_DISABLED = 'true'; });
  afterAll(() => { delete process.env.PLATFORM_OWNER_EMAILS; });

  beforeEach(async () => {
    await insertUser(pool, { id: OWNER_ID, email: 'owner@test.com', first: 'Own', last: 'Er', role: 'ADMIN' });
    await insertUser(pool, { id: POLLER_ID, email: 'poller@test.com', first: 'Po', last: 'Ller', role: 'TEACHER' });
    await insertUser(pool, { id: CLICKER_ID, email: 'clicker@test.com', first: 'Cli', last: 'Cker', role: 'TEACHER' });
    const start = ago(200);
    // A 30 s poller: 250 requests over 125 minutes, all 304.
    await insertStream(POLLER_ID, UNREAD, { n: 250, stepMs: 30000, start });
    // Duplicate mounts: 20 pairs of school-years 100 ms apart, 60 s between pairs.
    await insertStream(CLICKER_ID, YEARS, { n: 20, stepMs: 60000, start, status: 200 });
    await insertStream(CLICKER_ID, YEARS, { n: 20, stepMs: 60000, start, status: 200, offsetMs: 100 });
    // The clicker also polls unread-count, but slowly and under the threshold.
    await insertStream(CLICKER_ID, UNREAD, { n: 10, stepMs: 300000, start });
    // Console traffic and anonymous rows are never counted.
    await insertRequest(pool, { ts: ago(5), userId: OWNER_ID, role: 'ADMIN', route: '/api/observe/scanner' });
    await pool.query(`INSERT INTO request_events (ts, method, route, path, status, duration_ms) VALUES ($1, 'GET', '/api/health', '/api/health', 200, 1)`, [ago(5)]);
  });

  it('403s a non-owner', async () => {
    expect((await get('/api/observe/scanner', adminToken())).status).toBe(403);
  });

  it('ranks routes with cadence, 304 share and p95, and lists polling suspects', async () => {
    const res = await get('/api/observe/scanner?window=24h');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals).toEqual({ requests: 300, users: 2, routes: 2 });
    expect(d.thresholds).toEqual({ burstGapS: 2, suspectMinRequests: 200, suspectMaxMedianGapS: 120 });

    const unread = d.routes.find((r) => r.route === UNREAD);
    expect(unread).toEqual(expect.objectContaining({ method: 'GET', requests: 260, users: 2, status304Share: 1, p95Ms: 20, burstShare: 0, pattern: 'timer' }));
    // Per-user gaps: 249 × 30 s and 9 × 300 s; the median is still 30 s.
    expect(unread.medianGapS).toBe(30);
    expect(unread.gaps).toBe(258);

    const years = d.routes.find((r) => r.route === YEARS);
    expect(years).toEqual(expect.objectContaining({ requests: 40, users: 1, status304Share: 0, pattern: 'duplicate' }));
    expect(years.medianGapS).toBeCloseTo(0.1, 3);
    // 39 gaps: 20 of 0.1 s and 19 of 59.9 s.
    expect(years.burstShare).toBeCloseTo(20 / 39, 5);

    expect(d.routes.map((r) => r.route)).not.toContain('/api/observe/scanner');
    expect(d.routes.map((r) => r.route)).not.toContain('/api/health');

    expect(d.suspects).toEqual([
      expect.objectContaining({ method: 'GET', route: UNREAD, requests: 250, medianGapS: 30, burstShare: 0, gaps: 249, pattern: 'timer', status304Share: 1, user: expect.objectContaining({ id: POLLER_ID, name: 'Po Ller', role: 'TEACHER' }) }),
    ]);
  });

  it('filters by user and validates the id', async () => {
    const res = await get(`/api/observe/scanner?window=24h&user=${CLICKER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({ requests: 50, users: 1, routes: 2 });
    expect(res.body.data.suspects).toEqual([]);
    expect(res.body.data.routes.find((r) => r.route === UNREAD).requests).toBe(10);
    expect((await get('/api/observe/scanner?user=nope')).status).toBe(400);
  });

  it('GET /scanner/series buckets one route into 5-minute slots', async () => {
    const res = await get(`/api/observe/scanner/series?window=24h&method=get&route=${encodeURIComponent(UNREAD)}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.bucket).toBe('5 minutes');
    expect(d.series).toHaveLength(24 * 12);
    expect(d.series.reduce((n, p) => n + p.requests, 0)).toBe(260);
    // A full 5-minute bucket inside the poller's run holds exactly 10 of its requests (plus at most one from the clicker).
    expect(Math.max(...d.series.map((p) => p.requests))).toBeGreaterThanOrEqual(10);
    expect(Math.max(...d.series.map((p) => p.requests))).toBeLessThanOrEqual(11);

    const filtered = await get(`/api/observe/scanner/series?window=24h&user=${CLICKER_ID}&method=GET&route=${encodeURIComponent(UNREAD)}`);
    expect(filtered.body.data.series.reduce((n, p) => n + p.requests, 0)).toBe(10);

    const hourly = await get(`/api/observe/scanner/series?window=1h&method=GET&route=${encodeURIComponent(UNREAD)}`);
    expect(hourly.body.data.bucket).toBe('1 minute');
    expect(hourly.body.data.series).toHaveLength(60);

    expect((await get('/api/observe/scanner/series?window=24h&method=GET')).status).toBe(400);
    expect((await get('/api/observe/scanner/series?window=24h&route=/x')).status).toBe(400);
    expect((await get(`/api/observe/scanner/series?window=24h&method=GET&route=${encodeURIComponent(UNREAD)}&user=bad`)).status).toBe(400);
  });

  it('returns empty lists, not errors, for an empty window', async () => {
    await pool.query('TRUNCATE request_events');
    const res = await get('/api/observe/scanner?window=1h');
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({ requests: 0, users: 0, routes: 0 });
    expect(res.body.data.routes).toEqual([]);
    expect(res.body.data.suspects).toEqual([]);
  });
});
