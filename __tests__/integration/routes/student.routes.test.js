jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Integration: Student Routes', () => {
  let app, pool, activeYearId;

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
    // setupTestDB's global beforeEach seeds a baseline ALHAADIACADEMY school,
    // which fires a trigger creating an active '2025-2026' school_years row.
    // Student list queries now filter by that active year, so seeds below
    // need to attach it.
    const { rows } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active = true`
    );
    activeYearId = rows[0].school_year_id;
  });

  describe('POST /api/students', () => {
    it('creates a student and persists it in the database', async () => {
      const res = await authenticatedRequest('post', '/api/students')
        .send({
          name: 'John Smith',
          grade: 5,
          school: 'ALHAADIACADEMY',
          oen: '123456789',
          mother: { name: 'Jane', email: 'jane@test.com', phone: '555-0100' },
          father: { name: 'Bob', email: 'bob@test.com', phone: '555-0101' },
          emergencyContact: '555-0199',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('John Smith');
      expect(res.body.data.grade).toBe('5');
      expect(res.body.data.school).toBe('ALHAADIACADEMY');

      // Verify in DB
      const dbResult = await pool.query(
        'SELECT * FROM students WHERE name = $1',
        ['John Smith']
      );
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/students')
        .send({ school: 'ALHAADIACADEMY' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/students', () => {
    it('returns all students for a school', async () => {
      await pool.query(
        `INSERT INTO students (name, school, grade, school_year_id) VALUES ('Alice', 'ALHAADIACADEMY', '3', $1), ('Bob', 'ALHAADIACADEMY', '5', $1)`,
        [activeYearId]
      );

      const res = await authenticatedRequest('get', '/api/students?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('uses the JWT school even without a query param', async () => {
      await pool.query(
        `INSERT INTO students (name, school, grade, school_year_id) VALUES ('Alice', 'ALHAADIACADEMY', '3', $1)`,
        [activeYearId]
      );

      const res = await authenticatedRequest('get', '/api/students');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('does not return archived students', async () => {
      await pool.query(
        `INSERT INTO students (name, school, grade, is_archived, school_year_id) VALUES ('Active', 'ALHAADIACADEMY', '3', false, $1), ('Archived', 'ALHAADIACADEMY', '5', true, $1)`,
        [activeYearId]
      );

      const res = await authenticatedRequest('get', '/api/students?school=ALHAADIACADEMY');

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Active');
    });
  });

  describe('GET /api/students/:id', () => {
    it('returns a student by ID', async () => {
      const insertResult = await pool.query(
        `INSERT INTO students (name, school, grade) VALUES ('Alice', 'ALHAADIACADEMY', '3') RETURNING student_id`
      );
      const studentId = insertResult.rows[0].student_id;

      const res = await authenticatedRequest('get', `/api/students/${studentId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Alice');
    });

    it('returns 404 for non-existent student', async () => {
      const res = await authenticatedRequest('get', '/api/students/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/students/:id', () => {
    it('updates a student', async () => {
      const insertResult = await pool.query(
        `INSERT INTO students (name, school, grade) VALUES ('Alice', 'ALHAADIACADEMY', '3') RETURNING student_id`
      );
      const studentId = insertResult.rows[0].student_id;

      const res = await authenticatedRequest('patch', `/api/students/${studentId}`)
        .send({ name: 'Alice Updated', grade: 4 });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Alice Updated');

      const dbResult = await pool.query('SELECT name FROM students WHERE student_id = $1', [studentId]);
      expect(dbResult.rows[0].name).toBe('Alice Updated');
    });
  });

  describe('DELETE /api/students/:id', () => {
    it('deletes a student', async () => {
      const insertResult = await pool.query(
        `INSERT INTO students (name, school, grade) VALUES ('Alice', 'ALHAADIACADEMY', '3') RETURNING student_id`
      );
      const studentId = insertResult.rows[0].student_id;

      const res = await authenticatedRequest('delete', `/api/students/${studentId}`);

      expect(res.status).toBe(200);

      const dbResult = await pool.query('SELECT * FROM students WHERE student_id = $1', [studentId]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent student', async () => {
      const res = await authenticatedRequest('delete', '/api/students/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/students/:id/archive', () => {
    it('archives a student', async () => {
      const insertResult = await pool.query(
        `INSERT INTO students (name, school, grade) VALUES ('Alice', 'ALHAADIACADEMY', '3') RETURNING student_id`
      );
      const studentId = insertResult.rows[0].student_id;

      const res = await authenticatedRequest('post', `/api/students/${studentId}/archive`);

      expect(res.status).toBe(200);
      expect(res.body.data.isArchived).toBe(true);

      const dbResult = await pool.query('SELECT is_archived FROM students WHERE student_id = $1', [studentId]);
      expect(dbResult.rows[0].is_archived).toBe(true);
    });

    it('returns 400 when student is already archived', async () => {
      const insertResult = await pool.query(
        `INSERT INTO students (name, school, grade, is_archived) VALUES ('Alice', 'ALHAADIACADEMY', '3', true) RETURNING student_id`
      );
      const studentId = insertResult.rows[0].student_id;

      const res = await authenticatedRequest('post', `/api/students/${studentId}/archive`);

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/students/:id/unarchive', () => {
    it('unarchives a student', async () => {
      const insertResult = await pool.query(
        `INSERT INTO students (name, school, grade, is_archived, archived_at) VALUES ('Alice', 'ALHAADIACADEMY', '3', true, NOW()) RETURNING student_id`
      );
      const studentId = insertResult.rows[0].student_id;

      const res = await authenticatedRequest('post', `/api/students/${studentId}/unarchive`);

      expect(res.status).toBe(200);
      expect(res.body.data.isArchived).toBe(false);
    });
  });

  describe('GET /api/students/archived', () => {
    it('returns only archived students', async () => {
      await pool.query(
        `INSERT INTO students (name, school, grade, is_archived, school_year_id) VALUES ('Active', 'ALHAADIACADEMY', '3', false, $1), ('Archived', 'ALHAADIACADEMY', '5', true, $1)`,
        [activeYearId]
      );

      const res = await authenticatedRequest('get', '/api/students/archived?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Archived');
    });
  });

  describe('GET /api/students/all', () => {
    it('returns all students including archived', async () => {
      await pool.query(
        `INSERT INTO students (name, school, grade, is_archived, school_year_id) VALUES ('Active', 'ALHAADIACADEMY', '3', false, $1), ('Archived', 'ALHAADIACADEMY', '5', true, $1)`,
        [activeYearId]
      );

      const res = await authenticatedRequest('get', '/api/students/all?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/students?school=ALHAADIACADEMY');

      expect(res.status).toBe(401);
    });
  });
});
