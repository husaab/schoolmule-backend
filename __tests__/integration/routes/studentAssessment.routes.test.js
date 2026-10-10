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

describe('Integration: Student Assessment Routes', () => {
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

  // Seed helpers
  const seedClassWithAssessments = async () => {
    const { rows: termRows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`
    );

    const { rows: classRows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, $2, 'Term 1') RETURNING class_id`,
      [TEACHER_USER_ID, termRows[0].term_id]
    );
    const classId = classRows[0].class_id;

    // Create assessments
    const { rows: a1 } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, is_parent, max_score, weight_points)
       VALUES ($1, 'Quiz 1', 20, false, 100, 20) RETURNING assessment_id`,
      [classId]
    );
    const { rows: a2 } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, is_parent, max_score, weight_points)
       VALUES ($1, 'Quiz 2', 30, false, 100, 30) RETURNING assessment_id`,
      [classId]
    );

    return {
      classId,
      assessmentId1: a1[0].assessment_id,
      assessmentId2: a2[0].assessment_id,
    };
  };

  const seedStudent = async () => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Alice Smith', 'ALHAADIACADEMY', '5') RETURNING student_id`
    );
    return rows[0].student_id;
  };

  describe('POST /api/studentAssessments/classes/:classId/scores (upsert)', () => {
    it('upserts scores for students', async () => {
      const { classId, assessmentId1, assessmentId2 } = await seedClassWithAssessments();
      const studentId = await seedStudent();

      // Enroll student
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);

      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({
          scores: [
            { studentId, assessmentId: assessmentId1, score: 85 },
            { studentId, assessmentId: assessmentId2, score: 92 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);

      // Verify in DB
      const dbResult = await pool.query(
        'SELECT * FROM student_assessments WHERE student_id = $1',
        [studentId]
      );
      expect(dbResult.rows).toHaveLength(2);
    });

    it('updates existing scores on re-submit', async () => {
      const { classId, assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();

      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);

      // First upsert
      await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({
          scores: [{ studentId, assessmentId: assessmentId1, score: 80 }],
        });

      // Second upsert (update)
      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({
          scores: [{ studentId, assessmentId: assessmentId1, score: 95 }],
        });

      expect(res.status).toBe(200);
      // PostgreSQL NUMERIC returns as string
      expect(parseFloat(res.body.data[0].score)).toBe(95);

      // Verify single row in DB
      const dbResult = await pool.query(
        'SELECT score FROM student_assessments WHERE student_id = $1 AND assessment_id = $2',
        [studentId, assessmentId1]
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(parseFloat(dbResult.rows[0].score)).toBe(95);
    });

    it('allows null scores for clearing', async () => {
      const { classId, assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();

      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);

      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({
          scores: [{ studentId, assessmentId: assessmentId1, score: null }],
        });

      expect(res.status).toBe(200);
      expect(res.body.data[0].score).toBeNull();
    });

    it('stores a status with a score and clears the score for missing', async () => {
      const { classId, assessmentId1, assessmentId2 } = await seedClassWithAssessments();
      const studentId = await seedStudent();
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);

      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({
          scores: [
            { studentId, assessmentId: assessmentId1, score: 40, status: 'excused' },
            { studentId, assessmentId: assessmentId2, score: 50, status: 'missing' },
          ],
        });

      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.data.map((r) => [r.assessment_id, r]));
      expect(byId[assessmentId1]).toMatchObject({ status: 'excused' });
      expect(parseFloat(byId[assessmentId1].score)).toBe(40);
      expect(byId[assessmentId2]).toMatchObject({ status: 'missing', score: null });

      // A plain score resets the status to graded
      const again = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({ scores: [{ studentId, assessmentId: assessmentId1, score: 70 }] });
      expect(again.body.data[0].status).toBe('graded');
    });

    it('rejects an unknown status', async () => {
      const { classId, assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();
      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({ scores: [{ studentId, assessmentId: assessmentId1, score: 5, status: 'late' }] });
      expect(res.status).toBe(400);
    });

    it('returns 400 when scores array is empty', async () => {
      const { classId } = await seedClassWithAssessments();

      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({ scores: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when scores is not an array', async () => {
      const { classId } = await seedClassWithAssessments();

      const res = await authenticatedRequest('post', `/api/studentAssessments/classes/${classId}/scores`)
        .send({ scores: 'not an array' });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/studentAssessments/classes/:classId/status', () => {
    it('sets missing / excused / graded on a cell and expands a category to its children', async () => {
      const { classId, assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
      await pool.query(
        'INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, 80)',
        [studentId, assessmentId1]
      );

      const excused = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId: assessmentId1, status: 'excused' });
      expect(excused.status).toBe(200);
      expect(excused.body.data[0]).toMatchObject({ status: 'excused' });
      expect(parseFloat(excused.body.data[0].score)).toBe(80); // score kept

      const missing = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId: assessmentId1, status: 'missing' });
      expect(missing.body.data[0]).toMatchObject({ status: 'missing', score: null });

      const graded = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId: assessmentId1, status: 'graded' });
      expect(graded.body.data[0]).toMatchObject({ status: 'graded' });

      // Category → every child
      const { rows: p } = await pool.query(
        `INSERT INTO assessments (class_id, name, is_parent, weight_points) VALUES ($1, 'Quizzes', true, 50) RETURNING assessment_id`,
        [classId]
      );
      await pool.query(
        `INSERT INTO assessments (class_id, name, is_parent, parent_assessment_id, weight_points, max_score)
         VALUES ($1, 'Q1', false, $2, 25, 10), ($1, 'Q2', false, $2, 25, 10)`,
        [classId, p[0].assessment_id]
      );
      const cat = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId: p[0].assessment_id, status: 'excused' });
      expect(cat.status).toBe(200);
      expect(cat.body.data).toHaveLength(2);
      expect(cat.body.data.every((r) => r.status === 'excused')).toBe(true);

      // The matrix reports the status
      const matrix = await authenticatedRequest('get', `/api/studentAssessments/classes/${classId}/scores`);
      const rows = matrix.body.data.filter((r) => r.student_id === studentId);
      expect(rows.find((r) => r.assessment_id === assessmentId1).status).toBe('graded');
      expect(rows.filter((r) => r.status === 'excused')).toHaveLength(2);
    });

    it('returns 404 for an assessment outside the class and 400 for a bad status', async () => {
      const { classId } = await seedClassWithAssessments();
      const studentId = await seedStudent();
      const notFound = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId: '00000000-0000-0000-0000-000000000000', status: 'missing' });
      expect(notFound.status).toBe(404);
      const bad = await authenticatedRequest('patch', `/api/studentAssessments/classes/${classId}/status`)
        .send({ studentId, assessmentId: '00000000-0000-0000-0000-000000000000', status: 'late' });
      expect(bad.status).toBe(400);
    });
  });

  describe('GET /api/studentAssessments/classes/:classId/scores', () => {
    it('returns scores matrix for a class', async () => {
      const { classId, assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();

      // Enroll and add a score
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
      await pool.query(
        'INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)',
        [studentId, assessmentId1, 88]
      );

      const res = await authenticatedRequest('get', `/api/studentAssessments/classes/${classId}/scores`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/studentAssessments/:studentId/:assessmentId', () => {
    it('returns a single student assessment record', async () => {
      const { classId, assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();

      await pool.query(
        'INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)',
        [studentId, assessmentId1, 90]
      );

      const res = await authenticatedRequest('get', `/api/studentAssessments/${studentId}/${assessmentId1}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).not.toBeNull();
      expect(parseFloat(res.body.data.score)).toBe(90);
    });

    it('returns null data when no score exists', async () => {
      const { assessmentId1 } = await seedClassWithAssessments();
      const studentId = await seedStudent();

      const res = await authenticatedRequest('get', `/api/studentAssessments/${studentId}/${assessmentId1}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/studentAssessments/classes/00000000-0000-0000-0000-000000000000/scores');

      expect(res.status).toBe(401);
    });
  });
});
