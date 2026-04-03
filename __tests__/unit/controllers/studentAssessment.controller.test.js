const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildStudentAssessmentRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockTeacherUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/studentAssessments/classes/:classId/scores ────────
describe('GET /api/studentAssessments/classes/:classId/scores', () => {
  it('returns scores matrix for a class', async () => {
    const rows = [
      {
        student_id: 's1', student_name: 'Alice',
        assessment_id: 'a1', assessment_name: 'Quiz 1',
        weight_percent: 10, score: 28,
      },
      {
        student_id: 's1', student_name: 'Alice',
        assessment_id: 'a2', assessment_name: 'Quiz 2',
        weight_percent: 15, score: null,
      },
      {
        student_id: 's2', student_name: 'Bob',
        assessment_id: 'a1', assessment_name: 'Quiz 1',
        weight_percent: 10, score: 30,
      },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toHaveProperty('student_id');
    expect(res.body.data[0]).toHaveProperty('assessment_id');
    expect(res.body.data[0]).toHaveProperty('score');
  });

  it('returns empty array when no scores found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/studentAssessments/classes/class-empty/scores')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Error fetching scores');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .get('/api/studentAssessments/classes/class-123/scores');

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/studentAssessments/classes/:classId/scores ───────
describe('POST /api/studentAssessments/classes/:classId/scores', () => {
  it('upserts scores successfully', async () => {
    const upsertedRows = [
      { student_id: 's1', assessment_id: 'a1', score: 85 },
      { student_id: 's2', assessment_id: 'a1', score: 90 },
    ];
    mockQueryResponse(upsertedRows);

    const res = await request(app)
      .post('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader())
      .send({
        scores: [
          { studentId: 's1', assessmentId: 'a1', score: 85 },
          { studentId: 's2', assessmentId: 'a1', score: 90 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
  });

  it('allows null scores for deletion', async () => {
    const upsertedRows = [
      { student_id: 's1', assessment_id: 'a1', score: null },
    ];
    mockQueryResponse(upsertedRows);

    const res = await request(app)
      .post('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader())
      .send({
        scores: [
          { studentId: 's1', assessmentId: 'a1', score: null },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data[0].score).toBeNull();
  });

  it('returns 400 when scores array is empty', async () => {
    const res = await request(app)
      .post('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader())
      .send({ scores: [] });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('non-empty');
  });

  it('returns 400 when scores is not an array', async () => {
    const res = await request(app)
      .post('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader())
      .send({ scores: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .post('/api/studentAssessments/classes/class-123/scores')
      .set(authHeader())
      .send({
        scores: [
          { studentId: 's1', assessmentId: 'a1', score: 85 },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/studentAssessments/classes/:classId/scores/csv ────
describe('GET /api/studentAssessments/classes/:classId/scores/csv (Excel export)', () => {
  it('returns 404 when no data found for the class', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/studentAssessments/classes/class-empty/scores/csv')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('No data found');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/studentAssessments/classes/class-123/scores/csv')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });

  it('returns an Excel file when data exists', async () => {
    const rows = [
      {
        student_id: 's1', student_name: 'Alice',
        assessment_id: 'a1', assessment_name: 'Quiz 1',
        weight_percent: 50, weight_points: 50, max_score: 100,
        score: 85, is_excluded: false, is_parent: false,
        parent_assessment_id: null,
      },
      {
        student_id: 's1', student_name: 'Alice',
        assessment_id: 'a2', assessment_name: 'Quiz 2',
        weight_percent: 50, weight_points: 50, max_score: 100,
        score: 90, is_excluded: false, is_parent: false,
        parent_assessment_id: null,
      },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/studentAssessments/classes/class-123/scores/csv')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('gradebook_class-123.xlsx');
  });
});

// ─── GET /api/studentAssessments/:studentId/:assessmentId ───────
describe('GET /api/studentAssessments/:studentId/:assessmentId', () => {
  it('returns a student assessment record', async () => {
    const row = buildStudentAssessmentRow({
      student_id: 'student-1',
      assessment_id: 'assess-1',
      score: 92,
    });
    mockQueryResponse([row]);

    const res = await request(app)
      .get('/api/studentAssessments/student-1/assess-1')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('student_id');
    expect(res.body.data.score).toBe(92);
  });

  it('returns null data when record not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/studentAssessments/nonexistent/nonexistent')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toBeNull();
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/studentAssessments/student-1/assess-1')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
