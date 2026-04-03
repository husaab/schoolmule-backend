jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEACHER2_USER_ID = '550e8400-e29b-41d4-a716-446655440002';

describe('Integration: Teacher Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    // Seed admin user
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
    // Seed teachers
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEACHER_USER_ID, 'teacher1@test.com', 'Teacher One', 'hashed', 'Jane', 'Smith', 'ALHAADIACADEMY', 'TEACHER']
    );
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEACHER2_USER_ID, 'teacher2@test.com', 'Teacher Two', 'hashed', 'John', 'Doe', 'ALHAADIACADEMY', 'TEACHER']
    );
  });

  describe('GET /api/teachers?school=', () => {
    it('returns all teachers for a school', async () => {
      const res = await authenticatedRequest('get', '/api/teachers?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      // Only TEACHER role users should be returned
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0]).toHaveProperty('userId');
      expect(res.body.data[0]).toHaveProperty('fullName');
      expect(res.body.data[0]).toHaveProperty('email');
    });

    it('returns 400 when school param is missing', async () => {
      const res = await authenticatedRequest('get', '/api/teachers');

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('returns empty array when no teachers exist for a school', async () => {
      const res = await authenticatedRequest('get', '/api/teachers?school=PLAYGROUND');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('GET /api/teachers/:id', () => {
    it('returns a teacher by ID', async () => {
      const res = await authenticatedRequest('get', `/api/teachers/${TEACHER_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.userId).toBe(TEACHER_USER_ID);
      expect(res.body.data.fullName).toBe('Jane Smith');
      expect(res.body.data.email).toBe('teacher1@test.com');
    });

    it('returns 404 for non-existent teacher', async () => {
      const res = await authenticatedRequest('get', '/api/teachers/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/teachers?school=ALHAADIACADEMY');

      expect(res.status).toBe(401);
    });
  });
});
