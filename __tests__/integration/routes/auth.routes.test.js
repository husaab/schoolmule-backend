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

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
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
      expect(res.body.success).toBe(false);
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

    it('returns 500 with error message for non-existent user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@test.com',
          password: 'password123',
        });

      // The login controller throws { status: 404, message: "User not found" } which gets caught
      // by responseParser's catch block and returned as status 500
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });

    it('returns 500 with error message for wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'wrongpassword',
        });

      // The login controller throws { status: 401, message: "Invalid credentials" } which gets caught
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
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

    it('returns 400 when school is missing', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
      );

      const res = await authenticatedRequest('get', '/api/auth/pending-approvals');

      expect(res.status).toBe(400);
    });
  });
});
