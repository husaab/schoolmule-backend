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

  // R1 (student invitations spec): any signed-in role used to reach these
  // routes, and the :id ones were not school-scoped.
  describe('R1: /api/students is staff-only and school-scoped', () => {
    const asParent = { userId: '550e8400-e29b-41d4-a716-446655440002', username: 'Mona Haddad', role: 'PARENT' };
    const asTeacher = { userId: '550e8400-e29b-41d4-a716-446655440001', username: 'Ziad Teacher', role: 'TEACHER' };
    const asOtherAdmin = { userId: '550e8400-e29b-41d4-a716-446655440009', username: 'Other Admin', role: 'ADMIN', school: 'PLAYGROUND' };
    let studentId;

    const rowOf = async (id) => (await pool.query('SELECT * FROM students WHERE student_id = $1', [id])).rows[0];

    beforeEach(async () => {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, 'teacher@example.com', 'Ziad Teacher', 'hashed', 'Ziad', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
        [asTeacher.userId],
      );
      const { rows } = await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id, medical_notes)
         VALUES ('Amal Haddad', '5', 'ALHAADIACADEMY', $1, 'Peanut allergy') RETURNING student_id`,
        [activeYearId],
      );
      studentId = rows[0].student_id;
    });

    it('a parent token gets 403 on every students route and nothing changes', async () => {
      const calls = [
        ['get', '/api/students'],
        ['get', `/api/students/${studentId}`],
        ['patch', `/api/students/${studentId}`, { name: 'Changed' }],
        ['delete', `/api/students/${studentId}`],
        ['post', `/api/students/${studentId}/archive`],
        ['post', '/api/students', { name: 'New Kid', grade: '2' }],
      ];
      for (const [method, url, body] of calls) {
        const req = authenticatedRequest(method, url, asParent);
        const res = body ? await req.send(body) : await req;
        expect([method, url, res.status]).toEqual([method, url, 403]);
      }
      const row = await rowOf(studentId);
      expect(row).toMatchObject({ name: 'Amal Haddad', is_archived: false });
      const { rows: created } = await pool.query(`SELECT 1 FROM students WHERE name = 'New Kid'`);
      expect(created).toHaveLength(0);
    });

    it("an admin of another school gets 404 on another school's student and nothing changes", async () => {
      // A configured school (with an active year), so writes reach the controller.
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      expect((await authenticatedRequest('get', `/api/students/${studentId}`, asOtherAdmin)).status).toBe(404);
      expect((await authenticatedRequest('patch', `/api/students/${studentId}`, asOtherAdmin)
        .send({ name: 'Changed', school: 'PLAYGROUND' })).status).toBe(404);
      expect((await authenticatedRequest('post', `/api/students/${studentId}/archive`, asOtherAdmin)).status).toBe(404);
      expect((await authenticatedRequest('post', `/api/students/${studentId}/unarchive`, asOtherAdmin)).status).toBe(404);
      expect((await authenticatedRequest('delete', `/api/students/${studentId}`, asOtherAdmin)).status).toBe(404);
      expect(await rowOf(studentId)).toMatchObject({ name: 'Amal Haddad', school: 'ALHAADIACADEMY', is_archived: false });
    });

    it('a PATCH never moves a student to another school', async () => {
      const res = await authenticatedRequest('patch', `/api/students/${studentId}`).send({ school: 'PLAYGROUND' });
      expect(res.status).toBe(200);
      expect((await rowOf(studentId)).school).toBe('ALHAADIACADEMY');
    });

    it('a teacher of the same school can still read, edit and archive', async () => {
      expect((await authenticatedRequest('get', `/api/students/${studentId}`, asTeacher)).status).toBe(200);
      const patched = await authenticatedRequest('patch', `/api/students/${studentId}`, asTeacher).send({ name: 'Amal N. Haddad' });
      expect(patched.status).toBe(200);
      expect((await authenticatedRequest('post', `/api/students/${studentId}/archive`, asTeacher)).status).toBe(200);
      expect(await rowOf(studentId)).toMatchObject({ name: 'Amal N. Haddad', is_archived: true });
    });
  });
});
