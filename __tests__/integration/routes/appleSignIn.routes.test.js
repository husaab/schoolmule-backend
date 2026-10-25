// POST /api/auth/apple and /apple/connect against the real schema: the new
// users.apple_sub column, its partial unique index and the queries behind
// sign-in. Apple itself is mocked; each test picks the identity it returns.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

jest.mock('../../../services/apple/appleSignIn', () => {
  const actual = jest.requireActual('../../../services/apple/appleSignIn');
  return { ...actual, verifyIdentityToken: jest.fn() };
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { verifyIdentityToken } = require('../../../services/apple/appleSignIn');

const BODY = { identityToken: 't', nonce: 'raw-nonce-0123456789abcdef' };
const identity = (overrides = {}) => ({
  sub: 'apple-sub-integration-1',
  email: 'apple.parent@example.test',
  emailVerified: true,
  privateEmail: false,
  ...overrides,
});

const insertUser = (pool, { email, password = '$2b$10$existinghash', isVerified = true, role = 'PARENT' }) =>
  pool.query(
    `INSERT INTO users (email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 'Existing Parent', $2, 'Existing', 'Parent', 'ALHAADIACADEMY', $3, $4, true)
     RETURNING user_id`,
    [email, password, role, isVerified]
  ).then((r) => r.rows[0].user_id);

describe('Integration: POST /api/auth/apple', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  it('signs up a pending account and signs it back in by Apple ID once the address is gone', async () => {
    verifyIdentityToken.mockResolvedValue(identity());

    const signup = await request(app).post('/api/auth/apple')
      .send({ ...BODY, intent: 'signup', school: 'ALHAADIACADEMY', role: 'PARENT', givenName: 'Apple', familyName: 'Parent' });

    expect(signup.status).toBe(200);
    expect(signup.body.data).toMatchObject({ accountCreated: true, isVerified: true, isVerifiedSchool: false });
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', ['apple.parent@example.test']);
    expect(rows[0]).toMatchObject({ apple_sub: 'apple-sub-integration-1', first_name: 'Apple', last_name: 'Parent', role: 'PARENT' });

    // Later authorizations may carry no address: the Apple ID still finds the account.
    verifyIdentityToken.mockResolvedValue(identity({ email: null, emailVerified: false }));
    const login = await request(app).post('/api/auth/apple').send(BODY);
    expect(login.status).toBe(200);
    expect(login.body.data.userId).toBe(rows[0].user_id);
  });

  it('links an existing account by email, ignoring case', async () => {
    const userId = await insertUser(pool, { email: 'Linked.Parent@Example.test' });
    verifyIdentityToken.mockResolvedValue(identity({ sub: 'apple-sub-integration-2', email: 'linked.parent@example.test' }));

    const res = await request(app).post('/api/auth/apple').send(BODY);

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(userId);
    const { rows } = await pool.query('SELECT apple_sub, password FROM users WHERE user_id = $1', [userId]);
    expect(rows[0]).toEqual({ apple_sub: 'apple-sub-integration-2', password: '$2b$10$existinghash' });
  });

  it('connects a hidden-email Apple ID to the signed-in account, then signs in with it', async () => {
    const userId = await insertUser(pool, { email: 'hidden.parent@example.test' });
    const relay = identity({ sub: 'apple-sub-integration-3', email: 'q8z1@privaterelay.appleid.com', privateEmail: true });
    verifyIdentityToken.mockResolvedValue(relay);

    const miss = await request(app).post('/api/auth/apple').send(BODY);
    expect(miss.status).toBe(404);
    expect(miss.body.data.privateEmail).toBe(true);

    const token = jwt.sign(
      { userId, email: 'hidden.parent@example.test', school: 'ALHAADIACADEMY', role: 'PARENT', isVerified: true, isVerifiedSchool: true },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    const connect = await request(app).post('/api/auth/apple/connect').set('Authorization', `Bearer ${token}`).send(BODY);
    expect(connect.status).toBe(200);

    const again = await request(app).post('/api/auth/apple').send(BODY);
    expect(again.status).toBe(200);
    expect(again.body.data.userId).toBe(userId);
  });

  it('enforces one SchoolMule account per Apple ID', async () => {
    await insertUser(pool, { email: 'apple.first@example.test' });
    await pool.query("UPDATE users SET apple_sub = 'apple-sub-dupe' WHERE email = 'apple.first@example.test'");
    await insertUser(pool, { email: 'apple.second@example.test' });

    await expect(
      pool.query("UPDATE users SET apple_sub = 'apple-sub-dupe' WHERE email = 'apple.second@example.test'")
    ).rejects.toMatchObject({ code: '23505' });
  });
});
