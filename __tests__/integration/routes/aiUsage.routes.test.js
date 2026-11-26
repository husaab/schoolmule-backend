jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const aiUsage = require('../../../services/aiUsage');
const audit = require('../../../services/audit/auditLog');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000'; // authenticatedRequest's default account
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440041';

// The AI features spend one shared OpenAI key. These count what each person
// and school uses and refuse a request once a limit is reached.
describe('AI usage: counting and limits', () => {
  let pool;
  const env = { ...process.env };

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });
  afterEach(() => {
    process.env.AI_USER_DAILY_REQUESTS = env.AI_USER_DAILY_REQUESTS || '';
    process.env.AI_SCHOOL_MONTHLY_TOKENS = env.AI_SCHOOL_MONTHLY_TOKENS || '';
    if (!env.AI_USER_DAILY_REQUESTS) delete process.env.AI_USER_DAILY_REQUESTS;
    if (!env.AI_SCHOOL_MONTHLY_TOKENS) delete process.env.AI_SCHOOL_MONTHLY_TOKENS;
  });

  const start = (feature = 'generate_comment', token) => authenticatedRequest('post', '/api/ai-usage/start', token).send({ feature });
  const record = (body, token) => authenticatedRequest('post', '/api/ai-usage/record', token).send(body);
  const usage = async () => (await pool.query(
    `SELECT user_id, feature, school, requests, input_tokens::int, cached_input_tokens::int, output_tokens::int,
            day = (NOW() AT TIME ZONE 'America/Toronto')::date AS today
     FROM ai_usage_daily ORDER BY feature`)).rows;

  it('counts a request, then the tokens it used, on today\'s row', async () => {
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(200);
    expect((await record({ feature: 'generate_comment', inputTokens: 900, cachedInputTokens: 300, outputTokens: 120 })).status).toBe(200);

    expect(await usage()).toEqual([{
      user_id: ADMIN_ID, feature: 'generate_comment', school: 'ALHAADIACADEMY',
      requests: 2, input_tokens: 900, cached_input_tokens: 300, output_tokens: 120, today: true,
    }]);
  });

  it('keeps one row per feature', async () => {
    await start('generate_comment');
    await start('analytics_chat');
    expect((await usage()).map((r) => [r.feature, r.requests])).toEqual([['analytics_chat', 1], ['generate_comment', 1]]);
  });

  it('refuses the request after a person\'s daily limit, across features, and counts nothing more', async () => {
    process.env.AI_USER_DAILY_REQUESTS = '2';
    expect((await start('generate_comment')).status).toBe(200);
    expect((await start('analytics_chat')).status).toBe(200);

    const res = await start('dashboard_briefing');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('AI_LIMIT_USER_DAILY');
    expect(res.body.message).toMatch(/resets tomorrow/);
    expect((await usage()).map((r) => r.feature)).toEqual(['analytics_chat', 'generate_comment']);
  });

  it('does not count yesterday against today', async () => {
    process.env.AI_USER_DAILY_REQUESTS = '1';
    await pool.query(
      `INSERT INTO ai_usage_daily (user_id, day, feature, school, requests)
       VALUES ($1, (NOW() AT TIME ZONE 'America/Toronto')::date - 1, 'generate_comment', 'ALHAADIACADEMY', 50)`, [ADMIN_ID]);
    expect((await start()).status).toBe(200);
  });

  it('refuses everyone at the school once its month of tokens is used, and not another school', async () => {
    process.env.AI_SCHOOL_MONTHLY_TOKENS = '1000';
    await pool.query(
      `INSERT INTO ai_usage_daily (user_id, day, feature, school, requests, input_tokens, output_tokens)
       VALUES ($1, (NOW() AT TIME ZONE 'America/Toronto')::date, 'analytics_report', 'ALHAADIACADEMY', 1, 700, 300)`, [PARENT_ID]);

    const res = await start();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('AI_LIMIT_SCHOOL_MONTHLY');
    expect((await aiUsage.checkSchool('PLAYGROUND')).ok).toBe(true);
  });

  it('switches a limit off at zero', async () => {
    process.env.AI_USER_DAILY_REQUESTS = '0';
    for (let i = 0; i < 3; i += 1) expect((await start()).status).toBe(200);
  });

  it('refuses a feature it does not know, and a made-up token count', async () => {
    expect((await start('mine_bitcoin')).status).toBe(400);
    expect((await record({ feature: 'generate_comment', inputTokens: -5, outputTokens: 'lots' })).status).toBe(200);
    expect(await usage()).toEqual([expect.objectContaining({ requests: 0, input_tokens: 0, output_tokens: 0 })]);
  });

  it('is for staff views only', async () => {
    const parent = { userId: PARENT_ID, role: 'PARENT', email: 'p@test.com' };
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'p@test.com', 'p@test.com', 'x', 'Pat', 'Parent', 'ALHAADIACADEMY', 'PARENT', true, true)`, [PARENT_ID]);
    expect((await start('generate_comment', parent)).status).toBe(403);
    expect(await usage()).toEqual([]);
  });

  describe('audit log', () => {
    it('writes a row with its changes and gives back its id', async () => {
      const id = await audit.record({
        school: 'ALHAADIACADEMY', actorUserId: null, actorView: 'ADMIN', action: 'school_asset.replace',
        entityType: 'school_asset', summary: 'School stamp replaced',
        changes: [{ key: 'school_stamp', label: 'School stamp', before: 'A/school_stamp.png', after: 'A/school_stamp.jpg' }],
      });
      const { rows } = await pool.query(`SELECT source, action, summary, changes FROM audit_log WHERE audit_id = $1`, [id]);
      expect(rows).toEqual([{
        source: 'ui', action: 'school_asset.replace', summary: 'School stamp replaced',
        changes: [{ key: 'school_stamp', label: 'School stamp', before: 'A/school_stamp.png', after: 'A/school_stamp.jpg' }],
      }]);
    });

    it('never throws: an entry it cannot write resolves to null', async () => {
      await expect(audit.record({ school: 'NOT_A_SCHOOL', action: 'x', entityType: 'y', summary: 'z' })).resolves.toBeNull();
      await expect(audit.record({ action: 'x' })).resolves.toBeNull();
      await expect(audit.record(undefined)).resolves.toBeNull();
    });
  });
});
