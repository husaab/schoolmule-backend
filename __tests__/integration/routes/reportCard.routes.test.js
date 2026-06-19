jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn().mockResolvedValue(undefined),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Integration: Report Card Routes (Feedback CRUD)', () => {
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
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEACHER_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
    );
  });

  // Helpers
  const seedClass = async () => {
    const { rows: termRows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`
    );
    const { rows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', 5, 'Math', 'Teacher One', $1, $2, 'Term 1 2025-2026') RETURNING class_id`,
      [TEACHER_USER_ID, termRows[0].term_id]
    );
    return rows[0].class_id;
  };

  const seedStudent = async () => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Alice Smith', 'ALHAADIACADEMY', '5') RETURNING student_id`
    );
    return rows[0].student_id;
  };

  describe('POST /api/report-cards/feedback', () => {
    it('creates feedback for a student in a class', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      const res = await authenticatedRequest('post', '/api/report-cards/feedback')
        .send({
          studentId,
          classId,
          term: 'Term 1 2025-2026',
          workHabits: 'Excellent',
          behavior: 'Good',
          comment: 'Alice is doing great work!',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      // Verify in DB
      const dbResult = await pool.query(
        'SELECT * FROM report_card_feedback WHERE student_id = $1 AND class_id = $2',
        [studentId, classId]
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].work_habits).toBe('Excellent');
    });

    it('upserts feedback on second call (update)', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      // First call
      await authenticatedRequest('post', '/api/report-cards/feedback')
        .send({
          studentId,
          classId,
          term: 'Term 1 2025-2026',
          workHabits: 'Good',
          behavior: 'Good',
          comment: 'First comment',
        });

      // Second call (upsert)
      const res = await authenticatedRequest('post', '/api/report-cards/feedback')
        .send({
          studentId,
          classId,
          term: 'Term 1 2025-2026',
          workHabits: 'Excellent',
          behavior: 'Outstanding',
          comment: 'Updated comment',
        });

      expect(res.status).toBe(200);

      const dbResult = await pool.query(
        'SELECT * FROM report_card_feedback WHERE student_id = $1 AND class_id = $2 AND term = $3',
        [studentId, classId, 'Term 1 2025-2026']
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].work_habits).toBe('Excellent');
      expect(dbResult.rows[0].comment).toBe('Updated comment');
    });

    it('stores feedback under the class term, ignoring a wrong body term', async () => {
      const classId = await seedClass();        // class is Term 1 2025-2026
      const studentId = await seedStudent();

      const res = await authenticatedRequest('post', '/api/report-cards/feedback')
        .send({
          studentId,
          classId,
          term: 'Term 2 2025-2026',             // wrong on purpose — must be ignored
          workHabits: 'Excellent',
          behavior: 'Good',
          comment: 'Saved under the right term',
        });

      expect(res.status).toBe(200);

      const dbResult = await pool.query(
        'SELECT term FROM report_card_feedback WHERE student_id = $1 AND class_id = $2',
        [studentId, classId]
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].term).toBe('Term 1 2025-2026'); // class term, not body term
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/report-cards/feedback')
        .send({ studentId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/report-cards/feedback?studentId=&classId=&term=', () => {
    it('returns feedback for a student', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      await pool.query(
        `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [studentId, classId, 'Term 1 2025-2026', 'Good', 'Good', 'Nice work']
      );

      const res = await authenticatedRequest('get',
        `/api/report-cards/feedback?studentId=${studentId}&classId=${classId}&term=Term 1 2025-2026`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(studentId);
      expect(res.body.data.classId).toBe(classId);
      expect(res.body.data.workHabits).toBe('Good');
    });

    it('returns 400 when params are missing', async () => {
      const res = await authenticatedRequest('get', '/api/report-cards/feedback?studentId=test');

      expect(res.status).toBe(400);
    });

    it('returns 404 when feedback does not exist', async () => {
      const res = await authenticatedRequest('get',
        '/api/report-cards/feedback?studentId=00000000-0000-0000-0000-000000000000&classId=00000000-0000-0000-0000-000000000000&term=Term 1'
      );

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/report-cards/feedback/class/:classId?term=', () => {
    it('returns all feedback for a class in a term', async () => {
      const classId = await seedClass();
      const studentId1 = await seedStudent();
      const { rows: s2 } = await pool.query(
        `INSERT INTO students (name, school, grade) VALUES ('Bob Jones', 'ALHAADIACADEMY', '5') RETURNING student_id`
      );
      const studentId2 = s2[0].student_id;

      // Enroll students in the class
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2), ($1, $3)', [classId, studentId1, studentId2]);

      // Insert feedback
      await pool.query(
        `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment) VALUES
         ($1, $3, 'Term 1 2025-2026', 'Good', 'Good', 'Nice'),
         ($2, $3, 'Term 1 2025-2026', 'Excellent', 'Excellent', 'Great')`,
        [studentId1, studentId2, classId]
      );

      const res = await authenticatedRequest('get', `/api/report-cards/feedback/class/${classId}?term=Term 1 2025-2026`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('returns the class feedback without a term param (term derived from class)', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
      await pool.query(
        `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment)
         VALUES ($1, $2, 'Term 1 2025-2026', 'Good', 'Good', 'Nice')`,
        [studentId, classId]
      );

      const res = await authenticatedRequest('get', `/api/report-cards/feedback/class/${classId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].workHabits).toBe('Good');
    });
  });

  describe('POST /api/report-cards/feedback/bulk', () => {
    it('bulk upserts feedback for multiple students', async () => {
      const classId = await seedClass();
      const studentId1 = await seedStudent();
      const { rows: s2 } = await pool.query(
        `INSERT INTO students (name, school, grade) VALUES ('Bob Jones', 'ALHAADIACADEMY', '5') RETURNING student_id`
      );
      const studentId2 = s2[0].student_id;

      const res = await authenticatedRequest('post', '/api/report-cards/feedback/bulk')
        .send({
          feedbackEntries: [
            {
              studentId: studentId1,
              classId,
              term: 'Term 1 2025-2026',
              workHabits: 'Good',
              behavior: 'Good',
              comment: 'Alice comment',
            },
            {
              studentId: studentId2,
              classId,
              term: 'Term 1 2025-2026',
              workHabits: 'Excellent',
              behavior: 'Excellent',
              comment: 'Bob comment',
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.updated).toBe(2);
      expect(res.body.data.failed).toBe(0);

      const dbResult = await pool.query(
        'SELECT * FROM report_card_feedback WHERE class_id = $1 AND term = $2',
        [classId, 'Term 1 2025-2026']
      );
      expect(dbResult.rows).toHaveLength(2);
    });

    it('returns 400 when feedbackEntries is empty', async () => {
      const res = await authenticatedRequest('post', '/api/report-cards/feedback/bulk')
        .send({ feedbackEntries: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when entries have missing required fields', async () => {
      const res = await authenticatedRequest('post', '/api/report-cards/feedback/bulk')
        .send({
          feedbackEntries: [
            { studentId: '00000000-0000-0000-0000-000000000000' }, // missing classId, term
          ],
        });

      expect(res.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/report-cards/feedback?studentId=x&classId=x&term=x');

      expect(res.status).toBe(401);
    });
  });
});
