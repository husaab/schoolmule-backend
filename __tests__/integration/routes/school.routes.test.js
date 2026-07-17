jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Integration: School Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
  });

  describe('POST /api/schools', () => {
    // These tests exercise creating 'ALHAADIACADEMY' from scratch (and a
    // 409-on-duplicate case), so undo setupTestDB's global baseline seed
    // (a schools row + active school_year, added so resolveSchoolYear
    // doesn't 400 pre-existing write-path tests elsewhere) — this describe
    // block needs the table genuinely empty first.
    beforeEach(async () => {
      await pool.query(`DELETE FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    });

    it('creates a school and persists it in the database', async () => {
      const res = await authenticatedRequest('post', '/api/schools')
        .send({
          schoolCode: 'ALHAADIACADEMY',
          name: 'Al Haadi Academy',
          address: '123 Main St',
          phone: '555-0100',
          email: 'info@alhaadi.com',
          timezone: 'America/Toronto',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('Al Haadi Academy');
      expect(res.body.data.schoolCode).toBe('ALHAADIACADEMY');
      expect(res.body.data.address).toBe('123 Main St');

      const dbResult = await pool.query('SELECT * FROM schools WHERE name = $1', ['Al Haadi Academy']);
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 400 when school code is missing', async () => {
      const res = await authenticatedRequest('post', '/api/schools')
        .send({ name: 'Some School' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('returns 400 when name is missing', async () => {
      const res = await authenticatedRequest('post', '/api/schools')
        .send({ schoolCode: 'ALHAADIACADEMY' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('returns 409 for duplicate school code', async () => {
      await authenticatedRequest('post', '/api/schools')
        .send({ schoolCode: 'ALHAADIACADEMY', name: 'School One' });

      const res = await authenticatedRequest('post', '/api/schools')
        .send({ schoolCode: 'ALHAADIACADEMY', name: 'School Two' });

      expect(res.status).toBe(409);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/schools', () => {
    it('returns all schools', async () => {
      await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name`
      );

      const res = await authenticatedRequest('get', '/api/schools');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0]).toHaveProperty('schoolId');
      expect(res.body.data[0]).toHaveProperty('name');
    });
  });

  describe('GET /api/schools/:code', () => {
    it('returns a school by code', async () => {
      await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name`
      );

      const res = await authenticatedRequest('get', '/api/schools/ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.schoolCode).toBe('ALHAADIACADEMY');
      expect(res.body.data.name).toBe('Al Haadi Academy');
    });

    it('returns 404 for non-existent code', async () => {
      const res = await authenticatedRequest('get', '/api/schools/PLAYGROUND');

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/schools/id/:id', () => {
    it('returns a school by ID', async () => {
      const insertResult = await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name
         RETURNING school_id`
      );
      const schoolId = insertResult.rows[0].school_id;

      const res = await authenticatedRequest('get', `/api/schools/id/${schoolId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.schoolId).toBe(schoolId);
    });

    it('returns 404 for non-existent ID', async () => {
      const res = await authenticatedRequest('get', '/api/schools/id/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/schools/:id', () => {
    it('updates a school', async () => {
      const insertResult = await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name
         RETURNING school_id`
      );
      const schoolId = insertResult.rows[0].school_id;

      const res = await authenticatedRequest('put', `/api/schools/${schoolId}`)
        .send({
          name: 'Al Haadi Academy Updated',
          address: '456 New St',
          phone: '555-0200',
          email: 'updated@alhaadi.com',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Al Haadi Academy Updated');
      expect(res.body.data.address).toBe('456 New St');
    });

    it('returns 400 when name is missing', async () => {
      const insertResult = await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name
         RETURNING school_id`
      );
      const schoolId = insertResult.rows[0].school_id;

      const res = await authenticatedRequest('put', `/api/schools/${schoolId}`)
        .send({ address: '456 New St' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent school', async () => {
      const res = await authenticatedRequest('put', '/api/schools/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/schools/:id', () => {
    it('deletes a school', async () => {
      const insertResult = await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
         ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name
         RETURNING school_id`
      );
      const schoolId = insertResult.rows[0].school_id;

      const res = await authenticatedRequest('delete', `/api/schools/${schoolId}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM schools WHERE school_id = $1', [schoolId]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent school', async () => {
      const res = await authenticatedRequest('delete', '/api/schools/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/schools');

      expect(res.status).toBe(401);
    });
  });
});
