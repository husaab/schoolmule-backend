// Observe alerts against a real Postgres: the worker's tick end to end
// (incident row, claims, threaded emails, recovery) and the console API.
const mockSend = jest.fn(async () => ({ data: { id: 'email-1' } }));
jest.mock('../../../utils/emailUtils', () => ({
  ...jest.requireActual('../../../utils/emailUtils'),
  getResend: () => ({ emails: { send: mockSend } }),
}));
jest.mock('../../../services/observe/alerts/probes', () => ({
  ...jest.requireActual('../../../services/observe/alerts/probes'),
  probeLoopback: jest.fn(async () => ({ ok: true, error: null })),
}));
jest.mock('../../../services/observe/railwayMetrics', () => ({
  ...jest.requireActual('../../../services/observe/railwayMetrics'),
  getLatest: jest.fn(async () => ({ available: false, reason: 'not in tests' })),
}));
jest.mock('../../../services/push/expoClient', () => ({ sendBatch: jest.fn(async (msgs) => msgs.map(() => ({ status: 'ok', id: 't' }))) }));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const signals = require('../../../services/observe/alerts/signals');
const store = require('../../../services/observe/alerts/store');
const worker = require('../../../services/observe/alerts/worker');
const notifier = require('../../../services/observe/alerts/notifier');
const ownerPush = require('../../../services/observe/alerts/ownerPush');
const q = require('../../../queries/observeAlerts.queries');

const OWNER_ID = '550e8400-e29b-41d4-a716-446655440000';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440001';
const MIN = 60 * 1000;

// Synthetic identities only.
const insertUser = (pool, { id, email, role }) =>
  pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1,$2,$3,'hashed','Test','User','ALHAADIACADEMY',$4,true,true)`,
    [id, email, email, role]
  );

const ownerToken = () => ({ userId: OWNER_ID, email: 'owner@test.com', role: 'ADMIN' });
const adminToken = () => ({ userId: ADMIN_ID, email: 'admin@test.com', role: 'ADMIN' });

function burst(now, n, userId = 'u1') {
  for (let i = 0; i < n; i += 1) signals.noteRequest({ status: 500, durationMs: 80, userId }, now - i * 1000);
}

describe('Integration: Observe alerts', () => {
  let pool;
  beforeAll(() => {
    getApp();
    pool = getTestPool();
    process.env.PLATFORM_OWNER_EMAILS = 'owner@test.com';
    process.env.OBSERVE_DISABLED = 'true';
  });
  afterAll(() => {
    delete process.env.PLATFORM_OWNER_EMAILS;
  });
  beforeEach(async () => {
    signals.reset();
    store.reset();
    worker.reset();
    notifier.reset();
    ownerPush.reset();
    mockSend.mockClear();
    await insertUser(pool, { id: OWNER_ID, email: 'owner@test.com', role: 'ADMIN' });
    await insertUser(pool, { id: ADMIN_ID, email: 'admin@test.com', role: 'ADMIN' });
  });

  describe('worker tick', () => {
    it('opens one incident, emails once, then threads the recovery email', async () => {
      const now = Date.now();
      burst(now, 8);
      await worker.runOnce(now);

      const { rows } = await pool.query('SELECT * FROM alert_incidents');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'open', tier: 'critical', title: 'Server errors burst', notified_tier: 'critical' });
      expect(rows[0].subject).toBe('[SchoolMule] Critical: Server errors burst');
      expect(mockSend).toHaveBeenCalledTimes(1);
      const first = mockSend.mock.calls[0][0];
      expect(first).toMatchObject({ to: ['owner@test.com'], subject: '[SchoolMule] Critical: Server errors burst' });
      expect(first.from).toMatch(/alerts@/);
      expect(first.headers.References).toBe(`<alert-${rows[0].incident_id}@schoolmule.ca>`);
      expect(first.html).toContain('8 failed responses');

      // Still tripping 30 s later: same incident, no new email.
      await worker.runOnce(now + 30 * 1000);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // 16 quiet minutes with both checks passing: recovered, in the same thread.
      await worker.runOnce(now + 16 * MIN + 30 * 1000);
      const after = await pool.query('SELECT * FROM alert_incidents');
      expect(after.rows[0].status).toBe('resolved');
      expect(after.rows[0].recovered_notified_at).not.toBeNull();
      expect(mockSend).toHaveBeenCalledTimes(2);
      const second = mockSend.mock.calls[1][0];
      expect(second.subject).toBe('Re: [SchoolMule] Critical: Server errors burst');
      expect(second.headers['In-Reply-To']).toBe(first.headers.References);

      const log = await pool.query('SELECT channel, kind, ok FROM alert_notifications ORDER BY ts');
      expect(log.rows.filter((r) => r.channel === 'email')).toEqual([
        { channel: 'email', kind: 'opened', ok: true },
        { channel: 'email', kind: 'recovered', ok: true },
      ]);
      const trips = await pool.query("SELECT rule_id, mode FROM alert_rule_trips WHERE rule_id = 'errors_burst'");
      expect(trips.rows).toEqual([{ rule_id: 'errors_burst', mode: 'live' }]);
    });

    it('picks up the open incident after a restart instead of opening another', async () => {
      const now = Date.now();
      burst(now, 8);
      await worker.runOnce(now);
      // A redeploy: memory gone, database kept.
      signals.reset();
      store.reset();
      worker.reset();
      burst(now + MIN, 8);
      await worker.runOnce(now + MIN);
      const { rows } = await pool.query('SELECT incident_id FROM alert_incidents');
      expect(rows).toHaveLength(1);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('a failed email hands the claim back and is retried', async () => {
      const now = Date.now();
      mockSend.mockResolvedValueOnce({ error: { name: 'application_error', message: 'Resend is down' } });
      burst(now, 8);
      await worker.runOnce(now);
      let row = (await pool.query('SELECT notified_at FROM alert_incidents')).rows[0];
      expect(row.notified_at).toBeNull();
      // Backoff is 30 s after the first failure.
      await worker.runOnce(now + 31 * 1000);
      row = (await pool.query('SELECT notified_at FROM alert_incidents')).rows[0];
      expect(row.notified_at).not.toBeNull();
      const log = await pool.query("SELECT ok, error FROM alert_notifications WHERE channel = 'email' ORDER BY ts");
      expect(log.rows).toEqual([{ ok: false, error: 'Resend is down' }, { ok: true, error: null }]);
    });

    it('respects a muted rule', async () => {
      await pool.query(`INSERT INTO alert_rule_overrides (rule_id, muted_until) VALUES ('errors_burst', NOW() + INTERVAL '1 hour')`);
      const now = Date.now();
      burst(now, 8);
      await worker.runOnce(now);
      expect((await pool.query('SELECT 1 FROM alert_incidents')).rows).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
      const trips = await pool.query("SELECT mode FROM alert_rule_trips WHERE rule_id = 'errors_burst'");
      expect(trips.rows).toEqual([{ mode: 'muted' }]);
    });
  });

  describe('claims', () => {
    it('only one open incident can exist, and an email can be claimed once', async () => {
      const id = '11111111-1111-4111-8111-111111111111';
      const params = (incidentId) => [incidentId, 'open', 'critical', 'X', null, new Date(), new Date(), null, 0, null, null, null, false, null, null, '{}', '{}'];
      await pool.query(q.upsertIncident, params(id));
      await expect(pool.query(q.upsertIncident, params('22222222-2222-4222-8222-222222222222'))).rejects.toMatchObject({ code: '23505' });
      const a = await pool.query(q.claimOpened, [id, new Date(), 'critical', 'subject']);
      const b = await pool.query(q.claimOpened, [id, new Date(), 'critical', 'other']);
      expect(a.rowCount).toBe(1);
      expect(b.rowCount).toBe(0);
    });

    it('a reminder can be claimed once an hour', async () => {
      const id = '33333333-3333-4333-8333-333333333333';
      const notified = new Date(Date.now() - 61 * MIN);
      await pool.query(q.upsertIncident, [id, 'open', 'critical', 'X', 's', notified, notified, null, 0, notified, 'critical', null, false, null, null, '{}', '{}']);
      const now = new Date();
      expect((await pool.query(q.claimReminder, [id, now])).rowCount).toBe(1);
      expect((await pool.query(q.claimReminder, [id, new Date(now.getTime() + 1000)])).rowCount).toBe(0);
    });
  });

  describe('API', () => {
    const seedIncident = async (status = 'resolved') => {
      const id = '44444444-4444-4444-8444-444444444444';
      const opened = new Date(Date.now() - 40 * MIN);
      const resolved = status === 'resolved' ? new Date(Date.now() - 10 * MIN) : null;
      const rules = { errors_burst: { name: 'Server errors burst', tier: 'critical', firstAt: opened.getTime(), lastAt: opened.getTime(), peak: 12, summary: '12 failed responses and 0 logged errors in the last 5 minutes.' } };
      const stats = { failedRequests: 30, loggedErrors: 4, people: ['a', 'b'], peakErrors5m: 12, topErrors: [{ fingerprint: 'fp1', message: 'Error loading unread summary', count: 3 }], countedThrough: 0 };
      await pool.query(q.upsertIncident, [id, status, 'critical', 'Server errors burst', '[SchoolMule] Critical: Server errors burst', opened, opened, resolved, 0, opened, 'critical', null, false, resolved, null, JSON.stringify(rules), JSON.stringify(stats)]);
      await pool.query(q.insertNotification, [id, opened, 'email', 'opened', true, 1, '[SchoolMule] Critical: Server errors burst', null]);
      return id;
    };

    it('is owner-only', async () => {
      const res = await authenticatedRequest('get', '/api/observe/alerts/status', adminToken());
      expect(res.status).toBe(403);
    });

    it('GET /status shows what is firing', async () => {
      const id = await seedIncident('open');
      const res = await authenticatedRequest('get', '/api/observe/alerts/status', ownerToken());
      expect(res.status).toBe(200);
      expect(res.body.data.firing).toMatchObject({ id, tier: 'critical', status: 'open' });
      expect(res.body.data).toMatchObject({ recipients: 1, emailCap: 6, rulesMuted: 0, rulesWatching: 3 });
    });

    it('lists incidents and opens one with its sends', async () => {
      const id = await seedIncident();
      const list = await authenticatedRequest('get', '/api/observe/alerts/incidents?window=24h', ownerToken());
      expect(list.status).toBe(200);
      expect(list.body.data.incidents).toEqual([expect.objectContaining({ id, emails: 1, pushes: 0, stats: expect.objectContaining({ peopleAffected: 2, failedRequests: 30 }) })]);
      const one = await authenticatedRequest('get', `/api/observe/alerts/incidents/${id}`, ownerToken());
      expect(one.status).toBe(200);
      expect(one.body.data.incident.notifications).toEqual([expect.objectContaining({ channel: 'email', kind: 'opened', ok: true })]);
      expect(one.body.data.incident.rules[0]).toMatchObject({ id: 'errors_burst', peak: 12 });
      expect((await authenticatedRequest('get', '/api/observe/alerts/incidents/not-a-uuid', ownerToken())).status).toBe(400);
      expect((await authenticatedRequest('get', '/api/observe/alerts/incidents/55555555-5555-4555-8555-555555555555', ownerToken())).status).toBe(404);
    });

    it('deletes a resolved incident but not an open one', async () => {
      const id = await seedIncident('open');
      expect((await authenticatedRequest('delete', `/api/observe/alerts/incidents/${id}`, ownerToken())).status).toBe(409);
      await pool.query(`UPDATE alert_incidents SET status = 'resolved', resolved_at = NOW()`);
      expect((await authenticatedRequest('delete', `/api/observe/alerts/incidents/${id}`, ownerToken())).status).toBe(200);
      expect((await pool.query('SELECT 1 FROM alert_incidents')).rows).toHaveLength(0);
      expect((await pool.query('SELECT 1 FROM alert_notifications')).rows).toHaveLength(0);
    });

    it('changes, mutes and resets a rule', async () => {
      const rules = await authenticatedRequest('get', '/api/observe/alerts/rules', ownerToken());
      expect(rules.status).toBe(200);
      expect(rules.body.data.rules.map((r) => r.id)).toContain('server_down');
      expect(rules.body.data.rules.find((r) => r.id === 'high_cpu')).toMatchObject({ mode: 'watch', locked: false });

      const bad = await authenticatedRequest('patch', '/api/observe/alerts/rules/errors_burst', ownerToken()).send({ enabled: false });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toContain("can't be switched off");

      const until = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const ok = await authenticatedRequest('patch', '/api/observe/alerts/rules/errors_burst', ownerToken()).send({ params: { serverErrors: 8 }, mutedUntil: until });
      expect(ok.status).toBe(200);
      expect(ok.body.data.rule).toMatchObject({ customized: true, mutedUntil: until });
      expect(ok.body.data.rule.params.find((p) => p.key === 'serverErrors')).toMatchObject({ value: 8, default: 5 });

      const live = await authenticatedRequest('patch', '/api/observe/alerts/rules/high_cpu', ownerToken()).send({ mode: 'live' });
      expect(live.body.data.rule.mode).toBe('live');

      const reset = await authenticatedRequest('delete', '/api/observe/alerts/rules/errors_burst/settings', ownerToken());
      expect(reset.status).toBe(200);
      expect(reset.body.data.rule).toMatchObject({ customized: false, mutedUntil: null });
      const row = await pool.query(`SELECT updated_by FROM alert_rule_overrides WHERE rule_id = 'high_cpu'`);
      expect(row.rows).toEqual([{ updated_by: 'owner@test.com' }]);
      expect((await authenticatedRequest('patch', '/api/observe/alerts/rules/nope', ownerToken()).send({ enabled: true })).status).toBe(404);
    });

    it('sends a test alert to the owners', async () => {
      const res = await authenticatedRequest('post', '/api/observe/alerts/test', ownerToken()).send({ channel: 'email' });
      expect(res.status).toBe(200);
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['owner@test.com'], subject: '[SchoolMule] Test alert' }));
      const log = await pool.query('SELECT kind, ok FROM alert_notifications');
      expect(log.rows).toEqual([{ kind: 'test', ok: true }]);
    });
  });
});
