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

describe('Integration: Progress Reports Routes (Feedback CRUD)', () => {
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

  const seedStudent = async (name = 'Alice Smith') => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ($1, 'ALHAADIACADEMY', '5') RETURNING student_id`,
      [name]
    );
    return rows[0].student_id;
  };

  const seedFeedback = async (studentId, classId, overrides = {}) => {
    const defaults = {
      term: 'Term 1 2025-2026',
      coreStandards: 'Meeting expectations',
      workHabit: 'Consistent',
      behavior: 'Good',
      comment: 'Great progress',
    };
    const data = { ...defaults, ...overrides };
    const { rows } = await pool.query(
      `INSERT INTO progress_report_feedback (student_id, class_id, term, core_standards, work_habit, behavior, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [studentId, classId, data.term, data.coreStandards, data.workHabit, data.behavior, data.comment]
    );
    return rows[0];
  };

  describe('POST /api/progress-reports/feedback/student/:studentId/class/:classId', () => {
    it('creates progress report feedback', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      const res = await authenticatedRequest('post', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`)
        .send({
          term: 'Term 1 2025-2026',
          coreStandards: 'Meeting expectations',
          workHabit: 'Consistent',
          behavior: 'Good',
          comment: 'Alice shows great improvement.',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(studentId);
      expect(res.body.data.classId).toBe(classId);
      expect(res.body.data.coreStandards).toBe('Meeting expectations');

      const dbResult = await pool.query(
        'SELECT * FROM progress_report_feedback WHERE student_id = $1 AND class_id = $2',
        [studentId, classId]
      );
      expect(dbResult.rows).toHaveLength(1);
    });

    it('upserts feedback on second call', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      // First call
      await authenticatedRequest('post', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`)
        .send({ term: 'Term 1 2025-2026', coreStandards: 'Initial', workHabit: 'Initial' });

      // Second call (upsert)
      const res = await authenticatedRequest('post', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`)
        .send({ term: 'Term 1 2025-2026', coreStandards: 'Updated', workHabit: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.coreStandards).toBe('Updated');

      const dbResult = await pool.query(
        'SELECT * FROM progress_report_feedback WHERE student_id = $1 AND class_id = $2 AND term = $3',
        [studentId, classId, 'Term 1 2025-2026']
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].core_standards).toBe('Updated');
    });
  });

  describe('GET /api/progress-reports/feedback/student/:studentId/class/:classId', () => {
    it('returns feedback for a student in a class', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();
      await seedFeedback(studentId, classId);

      const res = await authenticatedRequest('get',
        `/api/progress-reports/feedback/student/${studentId}/class/${classId}?term=Term 1 2025-2026`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(studentId);
      expect(res.body.data.coreStandards).toBe('Meeting expectations');
    });

    it('returns null data when no feedback exists', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      const res = await authenticatedRequest('get',
        `/api/progress-reports/feedback/student/${studentId}/class/${classId}?term=NonExistent`
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });
  });

  describe('GET /api/progress-reports/feedback/student/:studentId', () => {
    it('returns all feedback for a student across classes', async () => {
      const classId1 = await seedClass();
      const { rows: classRows2 } = await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
         VALUES ('ALHAADIACADEMY', 5, 'Science', 'Teacher One', $1, (SELECT term_id FROM terms LIMIT 1), 'Term 1 2025-2026') RETURNING class_id`,
        [TEACHER_USER_ID]
      );
      const classId2 = classRows2[0].class_id;
      const studentId = await seedStudent();

      await seedFeedback(studentId, classId1, { comment: 'Math feedback' });
      await seedFeedback(studentId, classId2, { comment: 'Science feedback' });

      const res = await authenticatedRequest('get', `/api/progress-reports/feedback/student/${studentId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('GET /api/progress-reports/feedback/class/:classId', () => {
    it('returns all feedback for a class and term', async () => {
      const classId = await seedClass();
      const studentId1 = await seedStudent('Alice');
      const studentId2 = await seedStudent('Bob');

      await seedFeedback(studentId1, classId, { comment: 'Alice comment' });
      await seedFeedback(studentId2, classId, { comment: 'Bob comment' });

      const res = await authenticatedRequest('get', `/api/progress-reports/feedback/class/${classId}?term=Term 1 2025-2026`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('DELETE /api/progress-reports/feedback/student/:studentId/class/:classId', () => {
    it('deletes progress report feedback', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();
      await seedFeedback(studentId, classId);

      const res = await authenticatedRequest('delete',
        `/api/progress-reports/feedback/student/${studentId}/class/${classId}?term=Term 1 2025-2026`
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query(
        'SELECT * FROM progress_report_feedback WHERE student_id = $1 AND class_id = $2',
        [studentId, classId]
      );
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 when feedback does not exist', async () => {
      const classId = await seedClass();
      const studentId = await seedStudent();

      const res = await authenticatedRequest('delete',
        `/api/progress-reports/feedback/student/${studentId}/class/${classId}?term=Term 1 2025-2026`
      );

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/progress-reports/feedback/bulk', () => {
    it('bulk upserts feedback for multiple students', async () => {
      const classId = await seedClass();
      const studentId1 = await seedStudent('Alice');
      const studentId2 = await seedStudent('Bob');

      const res = await authenticatedRequest('post', '/api/progress-reports/feedback/bulk')
        .send({
          feedbackEntries: [
            {
              studentId: studentId1,
              classId,
              term: 'Term 1 2025-2026',
              coreStandards: 'Meeting',
              workHabit: 'Good',
              behavior: 'Good',
              comment: 'Alice comment',
            },
            {
              studentId: studentId2,
              classId,
              term: 'Term 1 2025-2026',
              coreStandards: 'Exceeding',
              workHabit: 'Excellent',
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
        'SELECT * FROM progress_report_feedback WHERE class_id = $1',
        [classId]
      );
      expect(dbResult.rows).toHaveLength(2);
    });

    it('returns 400 when feedbackEntries is empty', async () => {
      const res = await authenticatedRequest('post', '/api/progress-reports/feedback/bulk')
        .send({ feedbackEntries: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when entries have missing required fields', async () => {
      const res = await authenticatedRequest('post', '/api/progress-reports/feedback/bulk')
        .send({
          feedbackEntries: [
            { studentId: '00000000-0000-0000-0000-000000000000' }, // missing classId, term
          ],
        });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/progress-reports/reports', () => {
    it('creates a progress report record', async () => {
      const studentId = await seedStudent();

      const res = await authenticatedRequest('post', '/api/progress-reports/reports')
        .send({
          studentId,
          term: 'Term 1 2025-2026',
          studentName: 'Alice Smith',
          grade: '5',
          school: 'ALHAADIACADEMY',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('student_id');
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/progress-reports/reports')
        .send({ studentName: 'Alice' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/progress-reports/reports/student/:studentId', () => {
    it('returns progress reports for a student', async () => {
      const studentId = await seedStudent();

      await pool.query(
        `INSERT INTO progress_reports (student_id, term, student_name, grade, school)
         VALUES ($1, 'Term 1 2025-2026', 'Alice Smith', '5', 'ALHAADIACADEMY')`,
        [studentId]
      );

      const res = await authenticatedRequest('get', `/api/progress-reports/reports/student/${studentId}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/progress-reports/feedback/student/x/class/x');

      expect(res.status).toBe(401);
    });
  });
});
