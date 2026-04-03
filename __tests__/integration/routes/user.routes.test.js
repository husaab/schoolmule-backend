jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Integration: User Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
  });

  describe('GET /api/users', () => {
    it('returns all users', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [OTHER_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
      );

      const res = await authenticatedRequest('get', '/api/users');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0]).toHaveProperty('userId');
      expect(res.body.data[0]).toHaveProperty('email');
      expect(res.body.data[0]).toHaveProperty('role');
    });
  });

  describe('GET /api/users/:id', () => {
    it('returns a user by ID', async () => {
      const res = await authenticatedRequest('get', `/api/users/${TEST_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.userId).toBe(TEST_USER_ID);
      expect(res.body.data.email).toBe('admin@test.com');
      expect(res.body.data.fullName).toBe('Admin User');
    });

    it('returns 404 for non-existent user', async () => {
      const res = await authenticatedRequest('get', '/api/users/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/users/email/:email', () => {
    it('returns a user by email', async () => {
      const res = await authenticatedRequest('get', '/api/users/email/admin@test.com');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.email).toBe('admin@test.com');
    });

    it('returns 404 for non-existent email', async () => {
      const res = await authenticatedRequest('get', '/api/users/email/nonexistent@test.com');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/users/school/:school', () => {
    it('returns users by school', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [OTHER_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
      );

      const res = await authenticatedRequest('get', '/api/users/school/ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data.every(u => u.school === 'ALHAADIACADEMY')).toBe(true);
    });
  });

  describe('PUT /api/users/:id', () => {
    it('updates a user', async () => {
      const res = await authenticatedRequest('put', `/api/users/${TEST_USER_ID}`)
        .send({
          email: 'updated@test.com',
          username: 'Updated User',
          school: 'ALHAADIACADEMY',
          role: 'ADMIN',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT email, username FROM users WHERE user_id = $1', [TEST_USER_ID]);
      expect(dbResult.rows[0].email).toBe('updated@test.com');
      expect(dbResult.rows[0].username).toBe('Updated User');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('put', `/api/users/${TEST_USER_ID}`)
        .send({ email: 'updated@test.com' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent user', async () => {
      const res = await authenticatedRequest('put', '/api/users/00000000-0000-0000-0000-000000000000')
        .send({
          email: 'test@test.com',
          username: 'Test',
          school: 'ALHAADIACADEMY',
          role: 'ADMIN',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/users/:id/password', () => {
    it('updates password when old password is correct', async () => {
      const hashedPassword = await bcrypt.hash('oldpassword', 10);
      await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hashedPassword, TEST_USER_ID]);

      const res = await authenticatedRequest('put', `/api/users/${TEST_USER_ID}/password`)
        .send({
          oldPassword: 'oldpassword',
          newPassword: 'newpassword123',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // Verify new password works
      const dbResult = await pool.query('SELECT password FROM users WHERE user_id = $1', [TEST_USER_ID]);
      const isMatch = await bcrypt.compare('newpassword123', dbResult.rows[0].password);
      expect(isMatch).toBe(true);
    });

    it('returns 401 when old password is incorrect', async () => {
      const hashedPassword = await bcrypt.hash('correctpassword', 10);
      await pool.query('UPDATE users SET password = $1 WHERE user_id = $2', [hashedPassword, TEST_USER_ID]);

      const res = await authenticatedRequest('put', `/api/users/${TEST_USER_ID}/password`)
        .send({
          oldPassword: 'wrongpassword',
          newPassword: 'newpassword123',
        });

      expect(res.status).toBe(401);
    });

    it('returns 404 when user does not exist', async () => {
      const res = await authenticatedRequest('put', '/api/users/00000000-0000-0000-0000-000000000000/password')
        .send({
          oldPassword: 'old',
          newPassword: 'new',
        });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('deletes a user', async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
        [OTHER_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
      );

      const res = await authenticatedRequest('delete', `/api/users/${OTHER_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM users WHERE user_id = $1', [OTHER_USER_ID]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent user', async () => {
      const res = await authenticatedRequest('delete', '/api/users/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/users');

      expect(res.status).toBe(401);
    });
  });
});
