// POST /api/auth/google against the real schema: the new users.google_sub
// column, its partial unique index, and the three queries behind sign-in.
// Google itself is mocked; each test picks the identity the popup returns.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

jest.mock('../../../services/google/googleSignIn', () => {
  const actual = jest.requireActual('../../../services/google/googleSignIn');
  return { ...actual, verifySignInCode: jest.fn() };
});

const request = require('supertest');
const { getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { verifySignInCode } = require('../../../services/google/googleSignIn');

const identity = (overrides = {}) => ({
  sub: 'google-sub-integration-1',
  email: 'google.parent@example.test',
  emailVerified: true,
  givenName: 'Google',
  familyName: 'Parent',
  name: 'Google Parent',
  ...overrides,
});

const insertUser = (pool, { email, password = '$2b$10$existinghash', isVerified = true, role = 'PARENT' }) =>
  pool.query(
    `INSERT INTO users (email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 'Existing Parent', $2, 'Existing', 'Parent', 'ALHAADIACADEMY', $3, $4, true)
     RETURNING user_id`,
    [email, password, role, isVerified]
  ).then((r) => r.rows[0].user_id);

describe('Integration: POST /api/auth/google', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  it('signs up a pending, email-verified account and signs it back in by Google id', async () => {
    verifySignInCode.mockResolvedValue(identity());

    const signup = await request(app)
      .post('/api/auth/google')
      .send({ code: 'c', intent: 'signup', school: 'ALHAADIACADEMY', role: 'PARENT' });

    expect(signup.status).toBe(200);
    expect(signup.body.data).toMatchObject({ accountCreated: true, isVerified: true, isVerifiedSchool: false });

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', ['google.parent@example.test']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      google_sub: 'google-sub-integration-1',
      first_name: 'Google',
      last_name: 'Parent',
      username: 'Google Parent',
      role: 'PARENT',
      school: 'ALHAADIACADEMY',
      is_verified: true,
      is_verified_school: false,
      email_token: null,
    });
    // A real bcrypt hash nobody knows, not the invite sentinel.
    expect(rows[0].password).toMatch(/^\$2[aby]\$/);

    // The address changed on Google's side: the Google id still finds the account.
    verifySignInCode.mockResolvedValue(identity({ email: 'renamed.parent@example.test' }));
    const login = await request(app).post('/api/auth/google').send({ code: 'c', intent: 'login' });
    expect(login.status).toBe(200);
    expect(login.body.data).toMatchObject({ userId: rows[0].user_id, accountCreated: false });
  });

  it('links an existing account by email, ignoring case, and accepts a pending invite', async () => {
    const userId = await insertUser(pool, { email: 'Invited.Parent@Example.test', password: '!' });
    verifySignInCode.mockResolvedValue(identity({ sub: 'google-sub-integration-2', email: 'invited.parent@example.test' }));

    const res = await request(app).post('/api/auth/google').send({ code: 'c', intent: 'login' });

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(userId);
    const { rows } = await pool.query('SELECT google_sub, password, is_verified FROM users WHERE user_id = $1', [userId]);
    expect(rows[0].google_sub).toBe('google-sub-integration-2');
    expect(rows[0].password).not.toBe('!');
    expect(rows[0].is_verified).toBe(true);
  });

  it('keeps an existing password when linking', async () => {
    const userId = await insertUser(pool, { email: 'password.parent@example.test' });
    verifySignInCode.mockResolvedValue(identity({ sub: 'google-sub-integration-3', email: 'password.parent@example.test' }));

    await request(app).post('/api/auth/google').send({ code: 'c' });

    const { rows } = await pool.query('SELECT password FROM users WHERE user_id = $1', [userId]);
    expect(rows[0].password).toBe('$2b$10$existinghash');
  });

  it('invalidates a password typed by whoever signed up before the address was verified', async () => {
    const userId = await insertUser(pool, { email: 'squatted.parent@example.test', password: '$2b$10$squatterhash', isVerified: false });
    verifySignInCode.mockResolvedValue(identity({ sub: 'google-sub-integration-6', email: 'squatted.parent@example.test' }));

    const res = await request(app).post('/api/auth/google').send({ code: 'c' });

    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT password, is_verified FROM users WHERE user_id = $1', [userId]);
    expect(rows[0].password).not.toBe('$2b$10$squatterhash');
    expect(rows[0].is_verified).toBe(true);
  });

  it('answers GOOGLE_NO_ACCOUNT on login and creates nothing', async () => {
    verifySignInCode.mockResolvedValue(identity({ sub: 'google-sub-integration-4', email: 'nobody@example.test' }));

    const res = await request(app).post('/api/auth/google').send({ code: 'c', intent: 'login' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('GOOGLE_NO_ACCOUNT');
    const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', ['nobody@example.test']);
    expect(rows).toHaveLength(0);
  });

  it('enforces one SchoolMule account per Google account', async () => {
    await insertUser(pool, { email: 'first@example.test' });
    await pool.query("UPDATE users SET google_sub = 'google-sub-dupe' WHERE email = 'first@example.test'");
    await insertUser(pool, { email: 'second@example.test' });

    await expect(
      pool.query("UPDATE users SET google_sub = 'google-sub-dupe' WHERE email = 'second@example.test'")
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('400s on a school label Postgres does not know', async () => {
    verifySignInCode.mockResolvedValue(identity({ sub: 'google-sub-integration-5', email: 'lost.parent@example.test' }));

    const res = await request(app)
      .post('/api/auth/google')
      .send({ code: 'c', intent: 'signup', school: 'NOSUCHSCHOOL', role: 'PARENT' });

    expect(res.status).toBe(400);
  });
});
