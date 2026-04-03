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

describe('Integration: Assessment Routes', () => {
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

  // Helper: seed a class and return its class_id
  const seedClass = async () => {
    const { rows: termRows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`
    );
    const termId = termRows[0].term_id;

    const { rows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', 5, 'Math', 'Teacher One', $1, $2, 'Term 1 2025-2026') RETURNING class_id`,
      [TEACHER_USER_ID, termId]
    );
    return rows[0].class_id;
  };

  // Helper: seed an assessment
  const seedAssessment = async (classId, overrides = {}) => {
    const defaults = {
      name: 'Quiz 1',
      weightPercent: 10,
      parentAssessmentId: null,
      isParent: false,
      sortOrder: 1,
      maxScore: 100,
      weightPoints: 10,
    };
    const data = { ...defaults, ...overrides };
    const { rows } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, parent_assessment_id, is_parent, sort_order, max_score, weight_points)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [classId, data.name, data.weightPercent, data.parentAssessmentId, data.isParent, data.sortOrder, data.maxScore, data.weightPoints]
    );
    return rows[0];
  };

  describe('POST /api/assessments', () => {
    it('creates a standalone assessment', async () => {
      const classId = await seedClass();

      const res = await authenticatedRequest('post', '/api/assessments')
        .send({
          classId,
          name: 'Midterm Exam',
          weightPercent: 30,
          maxScore: 100,
          weightPoints: 30,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('Midterm Exam');
      expect(res.body.data.weightPercent).toBe(30);
      expect(res.body.data.classId).toBe(classId);

      const dbResult = await pool.query('SELECT * FROM assessments WHERE name = $1', ['Midterm Exam']);
      expect(dbResult.rows).toHaveLength(1);
    });

    it('creates a parent assessment with children', async () => {
      const classId = await seedClass();

      const res = await authenticatedRequest('post', '/api/assessments')
        .send({
          classId,
          name: 'Quizzes',
          weightPercent: 40,
          isParent: true,
          childCount: 2,
          weightPoints: 40,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.parent).toBeDefined();
      expect(res.body.data.parent.isParent).toBe(true);
      expect(res.body.data.children).toHaveLength(2);
      expect(res.body.data.children[0].parentAssessmentId).toBe(res.body.data.parent.assessmentId);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/assessments')
        .send({ weightPercent: 30 });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/assessments/:id', () => {
    it('returns an assessment by ID', async () => {
      const classId = await seedClass();
      const assessment = await seedAssessment(classId);

      const res = await authenticatedRequest('get', `/api/assessments/${assessment.assessment_id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.assessmentId).toBe(assessment.assessment_id);
      expect(res.body.data.name).toBe('Quiz 1');
    });

    it('returns 404 for non-existent assessment', async () => {
      const res = await authenticatedRequest('get', '/api/assessments/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/assessments/class/:classId', () => {
    it('returns all assessments for a class', async () => {
      const classId = await seedClass();
      await seedAssessment(classId, { name: 'Quiz 1' });
      await seedAssessment(classId, { name: 'Quiz 2', sortOrder: 2 });

      const res = await authenticatedRequest('get', `/api/assessments/class/${classId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns empty array when class has no assessments', async () => {
      const classId = await seedClass();

      const res = await authenticatedRequest('get', `/api/assessments/class/${classId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('PATCH /api/assessments/:id', () => {
    it('updates an assessment', async () => {
      const classId = await seedClass();
      const assessment = await seedAssessment(classId);

      const res = await authenticatedRequest('patch', `/api/assessments/${assessment.assessment_id}`)
        .send({
          name: 'Quiz 1 Updated',
          weightPercent: 15,
          maxScore: 50,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Quiz 1 Updated');
      expect(res.body.data.weightPercent).toBe(15);

      const dbResult = await pool.query('SELECT name FROM assessments WHERE assessment_id = $1', [assessment.assessment_id]);
      expect(dbResult.rows[0].name).toBe('Quiz 1 Updated');
    });

    it('returns 404 for non-existent assessment', async () => {
      const res = await authenticatedRequest('patch', '/api/assessments/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/assessments/:id', () => {
    it('deletes an assessment', async () => {
      const classId = await seedClass();
      const assessment = await seedAssessment(classId);

      const res = await authenticatedRequest('delete', `/api/assessments/${assessment.assessment_id}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM assessments WHERE assessment_id = $1', [assessment.assessment_id]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent assessment', async () => {
      const res = await authenticatedRequest('delete', '/api/assessments/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/assessments/batch', () => {
    it('batch updates multiple assessments', async () => {
      const classId = await seedClass();
      const a1 = await seedAssessment(classId, { name: 'Quiz 1', sortOrder: 1 });
      const a2 = await seedAssessment(classId, { name: 'Quiz 2', sortOrder: 2 });

      const res = await authenticatedRequest('patch', '/api/assessments/batch')
        .send({
          updates: [
            { assessmentId: a1.assessment_id, name: 'Quiz 1 Updated', weightPercent: 20 },
            { assessmentId: a2.assessment_id, name: 'Quiz 2 Updated', weightPercent: 25 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 400 when updates array is empty', async () => {
      const res = await authenticatedRequest('patch', '/api/assessments/batch')
        .send({ updates: [] });

      expect(res.status).toBe(400);
    });

    it('returns 400 when updates is not an array', async () => {
      const res = await authenticatedRequest('patch', '/api/assessments/batch')
        .send({ updates: 'not an array' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when an update is missing assessmentId', async () => {
      const res = await authenticatedRequest('patch', '/api/assessments/batch')
        .send({ updates: [{ name: 'No ID' }] });

      expect(res.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/assessments/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(401);
    });
  });
});
