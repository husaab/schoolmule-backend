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

describe('Integration: Class Routes', () => {
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
    // Seed teacher user (needed as FK for classes)
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEACHER_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
    );
    // Seed second teacher
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEACHER2_USER_ID, 'teacher2@test.com', 'Teacher Two', 'hashed', 'Teacher', 'Two', 'ALHAADIACADEMY', 'TEACHER']
    );
  });

  // Helper to seed a term and return its ID
  const seedTerm = async () => {
    const { rows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`
    );
    return rows[0].term_id;
  };

  // Helper to seed a class
  const seedClass = async (termId, overrides = {}) => {
    const defaults = {
      school: 'ALHAADIACADEMY',
      grade: 5,
      subject: 'Math',
      teacherName: 'Teacher One',
      teacherId: TEACHER_USER_ID,
      termName: 'Term 1 2025-2026',
    };
    const data = { ...defaults, ...overrides };
    const { rows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.school, data.grade, data.subject, data.teacherName, data.teacherId, termId, data.termName]
    );
    return rows[0];
  };

  // Helper to seed a student
  const seedStudent = async (name = 'Alice Smith', grade = '5') => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ($1, 'ALHAADIACADEMY', $2) RETURNING student_id`,
      [name, grade]
    );
    return rows[0].student_id;
  };

  describe('POST /api/classes', () => {
    it('creates a class and persists it in the database', async () => {
      const termId = await seedTerm();

      const res = await authenticatedRequest('post', '/api/classes')
        .send({
          school: 'ALHAADIACADEMY',
          grade: 5,
          subject: 'Math',
          teacherName: 'Teacher One',
          teacherId: TEACHER_USER_ID,
          termId,
          termName: 'Term 1 2025-2026',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.subject).toBe('Math');
      expect(res.body.data.grade).toBe('5');

      const dbResult = await pool.query('SELECT * FROM classes WHERE subject = $1', ['Math']);
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/classes')
        .send({ school: 'ALHAADIACADEMY', grade: 5 });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/classes?school=', () => {
    it('returns all classes for a school', async () => {
      const termId = await seedTerm();
      await seedClass(termId, { subject: 'Math' });
      await seedClass(termId, { subject: 'Science' });

      const res = await authenticatedRequest('get', '/api/classes?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 400 when school param is missing', async () => {
      const res = await authenticatedRequest('get', '/api/classes');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/classes/:id', () => {
    it('returns a class by ID', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      const res = await authenticatedRequest('get', `/api/classes/${cls.class_id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.classId).toBe(cls.class_id);
    });

    it('returns 404 for non-existent class', async () => {
      const res = await authenticatedRequest('get', '/api/classes/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid UUID format', async () => {
      const res = await authenticatedRequest('get', '/api/classes/not-a-uuid');

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/classes/:id', () => {
    it('updates a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      const res = await authenticatedRequest('patch', `/api/classes/${cls.class_id}`)
        .send({ subject: 'Advanced Math' });

      expect(res.status).toBe(200);
      expect(res.body.data.subject).toBe('Advanced Math');
    });

    it('returns 404 for non-existent class', async () => {
      const res = await authenticatedRequest('patch', '/api/classes/00000000-0000-0000-0000-000000000000')
        .send({ subject: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/classes/:id', () => {
    it('deletes a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      const res = await authenticatedRequest('delete', `/api/classes/${cls.class_id}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM classes WHERE class_id = $1', [cls.class_id]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent class', async () => {
      const res = await authenticatedRequest('delete', '/api/classes/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/classes/:classId/students (enroll)', () => {
    it('enrolls a student in a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);
      const studentId = await seedStudent();

      const res = await authenticatedRequest('post', `/api/classes/${cls.class_id}/students`)
        .send({ studentId });

      expect(res.status).toBe(201);
      expect(res.body.data.classId).toBe(cls.class_id);
      expect(res.body.data.studentId).toBe(studentId);

      const dbResult = await pool.query(
        'SELECT * FROM class_students WHERE class_id = $1 AND student_id = $2',
        [cls.class_id, studentId]
      );
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 409 for duplicate enrollment', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);
      const studentId = await seedStudent();

      await pool.query(
        'INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)',
        [cls.class_id, studentId]
      );

      const res = await authenticatedRequest('post', `/api/classes/${cls.class_id}/students`)
        .send({ studentId });

      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/classes/:classId/students', () => {
    it('returns students in a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);
      const studentId = await seedStudent('Alice Smith', '5');

      await pool.query(
        'INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)',
        [cls.class_id, studentId]
      );

      const res = await authenticatedRequest('get', `/api/classes/${cls.class_id}/students`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Alice Smith');
    });
  });

  describe('DELETE /api/classes/:classId/students/:studentId (unenroll)', () => {
    it('unenrolls a student from a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);
      const studentId = await seedStudent();

      await pool.query(
        'INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)',
        [cls.class_id, studentId]
      );

      const res = await authenticatedRequest('delete', `/api/classes/${cls.class_id}/students/${studentId}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query(
        'SELECT * FROM class_students WHERE class_id = $1 AND student_id = $2',
        [cls.class_id, studentId]
      );
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 when enrollment does not exist', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);
      const studentId = await seedStudent();

      const res = await authenticatedRequest('delete', `/api/classes/${cls.class_id}/students/${studentId}`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/classes/:classId/teachers (add additional teacher)', () => {
    it('adds an additional teacher to a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId); // primary teacher is TEACHER_USER_ID

      const res = await authenticatedRequest('post', `/api/classes/${cls.class_id}/teachers`)
        .send({ teacherId: TEACHER2_USER_ID });

      expect(res.status).toBe(201);
      expect(res.body.data.teacherId).toBe(TEACHER2_USER_ID);
    });

    it('returns 409 when adding the primary teacher as additional', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      const res = await authenticatedRequest('post', `/api/classes/${cls.class_id}/teachers`)
        .send({ teacherId: TEACHER_USER_ID });

      expect(res.status).toBe(409);
    });

    it('returns 400 when teacherId is missing', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      const res = await authenticatedRequest('post', `/api/classes/${cls.class_id}/teachers`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/classes/:classId/teachers/:teacherId', () => {
    it('removes an additional teacher from a class', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      await pool.query(
        'INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)',
        [cls.class_id, TEACHER2_USER_ID]
      );

      const res = await authenticatedRequest('delete', `/api/classes/${cls.class_id}/teachers/${TEACHER2_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('returns 404 when teacher assignment does not exist', async () => {
      const termId = await seedTerm();
      const cls = await seedClass(termId);

      const res = await authenticatedRequest('delete', `/api/classes/${cls.class_id}/teachers/${TEACHER2_USER_ID}`);

      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/classes?school=ALHAADIACADEMY');

      expect(res.status).toBe(401);
    });
  });
});
