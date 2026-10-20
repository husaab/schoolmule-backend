jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Integration: Auth Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  // Note: auth routes (register, login) are public and do NOT require verifyUser middleware.
  // However, approve-school and pending-approvals DO require verifyUser.

  describe('POST /api/auth/register', () => {
    it('registers a new user and returns user data with token', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'John Doe',
          email: 'john@test.com',
          password: 'password123',
          school: 'ALHAADIACADEMY',
          role: 'TEACHER',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data.email).toBe('john@test.com');
      expect(res.body.data.username).toBe('John Doe');
      expect(res.body.data.school).toBe('ALHAADIACADEMY');
      expect(res.body.data.role).toBe('TEACHER');
      expect(res.body.data.isVerified).toBe(false);

      // Verify in DB
      const dbResult = await pool.query('SELECT * FROM users WHERE email = $1', ['john@test.com']);
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].username).toBe('John Doe');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'john@test.com', password: 'password123' });

      // A bad request is a 400, answered before a connection is taken.
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Missing required fields');
    });

    it('refuses a password shorter than 6 characters, as the form does', async () => {
      const res = await request(app).post('/api/auth/register').set('X-Forwarded-For', '10.7.0.2').send({
        username: 'Sara Mansour', email: 'short.pass@example.com', password: '12345', school: 'ALHAADIACADEMY', role: 'PARENT',
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 6 characters.' });
      expect((await pool.query(`SELECT 1 FROM users WHERE email = 'short.pass@example.com'`)).rows).toHaveLength(0);
    });

    it('returns 400 when email already exists', async () => {
      // First registration
      await request(app)
        .post('/api/auth/register')
        .send({
          username: 'John Doe',
          email: 'duplicate@test.com',
          password: 'password123',
          school: 'ALHAADIACADEMY',
          role: 'TEACHER',
        });

      // Second registration with same email
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          username: 'Jane Doe',
          email: 'duplicate@test.com',
          password: 'password456',
          school: 'ALHAADIACADEMY',
          role: 'TEACHER',
        });

      expect(res.status).toBe(400);
      // Controller catches the duplicate key error and RETURNS { status: 400 }.
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('email already exists');
      expect(res.body.code).toBe('EMAIL_TAKEN');
    });

    it('refuses the same address in another spelling, so sign-in never sees two accounts', async () => {
      const signUp = (email) => request(app).post('/api/auth/register').set('X-Forwarded-For', '10.7.0.1').send({
        username: 'Sara Mansour', email, password: 'password123', school: 'ALHAADIACADEMY', role: 'PARENT',
      });
      expect((await signUp('sara.mansour@example.com')).status).toBe(200);

      const again = await signUp(' Sara.Mansour@Example.com ');
      expect(again.status).toBe(400);
      expect(again.body).toMatchObject({ success: false, code: 'EMAIL_TAKEN' });
      const { rows } = await pool.query(`SELECT email FROM users WHERE LOWER(email) = 'sara.mansour@example.com'`);
      expect(rows).toEqual([{ email: 'sara.mansour@example.com' }]);
    });

    describe('an address that already has an account names the way in', () => {
      const EXISTING_ID = '550e8400-e29b-41d4-a716-446655440041';
      const existing = ({ password = 'some-hash', archived = false, role = 'PARENT' } = {}) => pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
         VALUES ($1, 'omar.haddad@example.com', 'Omar Haddad', $2, 'Omar', 'Haddad', 'ALHAADIACADEMY', $3, true, true, $4)`,
        [EXISTING_ID, password, role, archived],
      );
      let ip = 10;
      const signUp = () => request(app).post('/api/auth/register').set('X-Forwarded-For', `10.7.1.${ip++}`).send({
        username: 'Omar Haddad', email: 'Omar.Haddad@example.com', password: 'password123', school: 'ALHAADIACADEMY', role: 'PARENT',
      });

      it('an invite not yet accepted: use the invite, or reset for a new link', async () => {
        await existing({ password: '!' });
        const res = await signUp();
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ACCOUNT_INVITED');
        expect(res.body.message).toMatch(/invite email/);
      });

      it('an archived account: contact the school', async () => {
        await existing({ archived: true, password: '!' });
        const res = await signUp();
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: 'ACCOUNT_ARCHIVED', message: 'This account has been archived. Contact your school admin.' });
      });

      it("a student's pending invite is not offered a reset", async () => {
        await existing({ password: '!', role: 'STUDENT' });
        expect((await signUp()).body.code).toBe('EMAIL_TAKEN');
      });

      it('a live account: sign in, and no second account is created', async () => {
        await existing();
        expect((await signUp()).body.code).toBe('EMAIL_TAKEN');
        expect((await pool.query(`SELECT user_id FROM users WHERE LOWER(email) = 'omar.haddad@example.com'`)).rows)
          .toEqual([{ user_id: EXISTING_ID }]);
      });
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      const hashedPassword = await bcrypt.hash('correctpassword', 10);
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [TEST_USER_ID, 'admin@test.com', 'Admin User', hashedPassword, 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
      );
    });

    it('logs in with correct credentials and returns token', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'correctpassword',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('token');
      expect(res.body.data.email).toBe('admin@test.com');
      expect(res.body.data.role).toBe('ADMIN');

      // Verify the token is valid
      const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET || 'test-jwt-secret-key-for-integration-tests');
      expect(decoded.userId).toBe(TEST_USER_ID);
      expect(decoded.email).toBe('admin@test.com');
    });

    it('refuses archived accounts even with the right password', async () => {
      await pool.query(`UPDATE users SET is_archived = true WHERE user_id = $1`, [TEST_USER_ID]);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@test.com', password: 'correctpassword' });

      // The controller's thrown { status: 403 } is the verdict, not a crash.
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/archived/i);
      expect(res.body.data?.token).toBeUndefined();
    });

    it('returns 404 with error message for non-existent user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@test.com',
          password: 'password123',
        });

      // The login controller returns the thrown { status: 404, message } as-is.
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 with error message for wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'wrongpassword',
        });

      // Same pattern: a wrong password is a 401, never a server error.
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('matches the email ignoring case and surrounding spaces', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: ' Admin@TEST.com ', password: 'correctpassword' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ userId: TEST_USER_ID, email: 'admin@test.com' });
    });

    describe('two accounts whose addresses differ only by case', () => {
      const UPPER_ID = '550e8400-e29b-41d4-a716-446655440031';
      const LOWER_ID = '550e8400-e29b-41d4-a716-446655440032';
      const signIn = (email, password) => request(app).post('/api/auth/login').send({ email, password });

      beforeEach(async () => {
        const [upperHash, lowerHash] = await Promise.all([bcrypt.hash('upper-pass-1', 4), bcrypt.hash('lower-pass-2', 4)]);
        await pool.query(
          `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
           VALUES ($1, 'Pat.Kareem@example.com', 'Pat Kareem', $2, 'Pat', 'Kareem', 'ALHAADIACADEMY', 'PARENT', true, true),
                  ($3, 'pat.kareem@example.com', 'Pat Kareem', $4, 'Pat', 'Kareem', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
          [UPPER_ID, upperHash, LOWER_ID, lowerHash],
        );
      });

      it('opens the account with the exact spelling, and only with its own password', async () => {
        expect((await signIn('Pat.Kareem@example.com', 'upper-pass-1')).body.data.userId).toBe(UPPER_ID);
        expect((await signIn('pat.kareem@example.com', 'lower-pass-2')).body.data.userId).toBe(LOWER_ID);
        // The exact spelling picks the account; the other one's password doesn't open it.
        const crossed = await signIn('pat.kareem@example.com', 'upper-pass-1');
        expect(crossed.status).toBe(401);
        expect(crossed.body.data).toBeNull();
      });

      it('refuses a third spelling instead of picking one (409 EMAIL_AMBIGUOUS)', async () => {
        for (const password of ['upper-pass-1', 'lower-pass-2']) {
          const res = await signIn('PAT.KAREEM@EXAMPLE.COM', password);
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ success: false, code: 'EMAIL_AMBIGUOUS', data: null });
        }
      });

      it('"Forgot password" follows the same rule', async () => {
        const ambiguous = await request(app).post('/api/auth/request-password-reset').send({ email: 'PAT.KAREEM@example.com' });
        expect(ambiguous.status).toBe(409);
        expect(ambiguous.body.code).toBe('EMAIL_AMBIGUOUS');

        const exact = await request(app).post('/api/auth/request-password-reset').send({ email: 'Pat.Kareem@example.com' });
        expect(exact.status).toBe(200);
        const { rows } = await pool.query(`SELECT user_id FROM password_reset_tokens`);
        expect(rows).toEqual([{ user_id: UPPER_ID }]);
      });
    });
  });

  describe('POST /api/auth/reset-password (hardening, student invitations R8)', () => {
    const insertUser = (overrides = {}) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
       VALUES ($1, 'pat.reset@example.com', 'Pat Reset', 'old-hash', 'Pat', 'Reset', 'ALHAADIACADEMY', 'TEACHER', true, true, $2)`,
      [TEST_USER_ID, overrides.archived ?? false],
    );
    const token = async () => (await pool.query(
      `INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, NOW() + interval '1 hour') RETURNING token`, [TEST_USER_ID],
    )).rows[0].token;
    const reset = (body) => request(app).post('/api/auth/reset-password').set('X-Forwarded-For', '10.8.0.1').send(body);

    it('a missing or short password is a 400, not a 500', async () => {
      await insertUser();
      const t = await token();
      expect((await reset({ token: t })).status).toBe(400);
      const short = await reset({ token: t, newPassword: '12345' });
      expect(short.status).toBe(400);
      expect(short.body.message).toBe('Password must be at least 6 characters.');
    });

    it('a malformed token is a 400 on both routes', async () => {
      expect((await reset({ token: 'not-a-uuid', newPassword: 'long-enough' })).status).toBe(400);
      expect((await request(app).get('/api/auth/validate-reset-token?token=not-a-uuid')).status).toBe(400);
    });

    it("using one link kills the user's other open links", async () => {
      await insertUser();
      const first = await token();
      const second = await token();
      expect((await reset({ token: first, newPassword: 'long-enough' })).status).toBe(200);
      expect((await reset({ token: second, newPassword: 'another-one' })).status).toBe(400);
      expect((await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [TEST_USER_ID])).rows).toHaveLength(0);
    });

    it('an archived account cannot set a password', async () => {
      await insertUser({ archived: true });
      const res = await reset({ token: await token(), newPassword: 'long-enough' });
      expect(res.status).toBe(400);
      expect((await pool.query(`SELECT password FROM users WHERE user_id = $1`, [TEST_USER_ID])).rows[0].password).toBe('old-hash');
    });

    it('a dead link answers RESET_LINK_INVALID, so the page can tell it from a refused password', async () => {
      await insertUser();
      const t = await token();
      const check = () => request(app).get(`/api/auth/validate-reset-token?token=${t}`).set('X-Forwarded-For', '10.8.0.2');
      expect((await check()).body).toMatchObject({ success: true, data: { passwordRule: 'standard' } });

      expect((await reset({ token: t, newPassword: 'long-enough' })).status).toBe(200);
      for (const res of [await check(), await reset({ token: t, newPassword: 'long-enough' })]) {
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('RESET_LINK_INVALID');
      }
    });

    it('"Forgot password" makes no link for an archived account and says why', async () => {
      await insertUser({ archived: true });
      const res = await request(app).post('/api/auth/request-password-reset').set('X-Forwarded-For', '10.8.0.3')
        .send({ email: 'pat.reset@example.com' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, code: 'ACCOUNT_ARCHIVED', message: 'This account has been archived. Contact your school admin.' });
      expect((await pool.query(`SELECT 1 FROM password_reset_tokens`)).rows).toHaveLength(0);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('logs out successfully', async () => {
      const res = await request(app).post('/api/auth/logout');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/auth/me (session validation)', () => {
    it('returns user data for a valid token', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
      );

      const secret = process.env.JWT_SECRET || 'test-jwt-secret-key-for-integration-tests';
      const token = jwt.sign({ userId: TEST_USER_ID, email: 'admin@test.com' }, secret, { expiresIn: '1h' });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.userId).toBe(TEST_USER_ID);
      expect(res.body.data.email).toBe('admin@test.com');
    });

    it('ends the session of an archived account', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, true)`,
        [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
      );
      const secret = process.env.JWT_SECRET || 'test-jwt-secret-key-for-integration-tests';
      const token = jwt.sign({ userId: TEST_USER_ID, email: 'admin@test.com' }, secret, { expiresIn: '1h' });

      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/archived/i);
    });

    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 for an invalid token', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token-here');

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/auth/pending-approvals?school= (requires auth)', () => {
    it('returns pending approvals for a school', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
      );

      const res = await authenticatedRequest('get', '/api/auth/pending-approvals?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('users');
      expect(Array.isArray(res.body.users)).toBe(true);
    });

    it('uses the admin\'s own school and ignores ?school=', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, 'pending@test.com', 'Pending User', 'hashed', 'Pending', 'User', 'PLAYGROUND', 'TEACHER', true, false)`,
        ['550e8400-e29b-41d4-a716-446655440077']
      );

      const res = await authenticatedRequest('get', '/api/auth/pending-approvals?school=PLAYGROUND');

      expect(res.status).toBe(200);
      expect(res.body.users.map((u) => u.email)).not.toContain('pending@test.com');
    });

    it('rejects non-admins', async () => {
      const res = await authenticatedRequest('get', '/api/auth/pending-approvals', { role: 'TEACHER' });
      expect(res.status).toBe(403);
    });
  });
});
