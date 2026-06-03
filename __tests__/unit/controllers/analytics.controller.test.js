const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const engine = require('../../../services/analyticsEngine');

let app;
beforeAll(() => {
  app = getApp();
});

beforeEach(() => {
  engine.invalidateCache();
});

const authHeader = () => ({ Authorization: `Bearer ${mockAdminUser()}` });

function matrixRow(overrides = {}) {
  return {
    class_id: 'c1',
    class_grade: '5',
    subject: 'Math',
    teacher_name: 'Ms. Test',
    term_id: 't1',
    student_id: 's1',
    student_name: 'Alice',
    student_grade: '5',
    homeroom_teacher_id: 'hr1',
    assessment_id: 'a1',
    assessment_name: 'Quiz 1',
    weight_percent: 100,
    weight_points: 100,
    max_score: 100,
    is_parent: false,
    parent_assessment_id: null,
    assessment_date: '2025-10-01',
    sort_order: 1,
    score: 85,
    is_excluded: false,
    ...overrides,
  };
}

const sampleRows = [
  matrixRow(),
  matrixRow({ student_id: 's2', student_name: 'Bob', score: 65 }),
];

// ─── GET /api/analytics/overview ────────────────────────────────
describe('GET /api/analytics/overview', () => {
  const url = '/api/analytics/overview';

  it('returns overview data with grade and subject roll-ups', async () => {
    mockQueryResponse(sampleRows); // matrix
    mockQueryResponse([{ term_id: 't1', name: 'Term 1', is_active: true }]); // terms

    const res = await request(app).get(url).set(authHeader()).query({ termId: 't1' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.engine).toBe('null_skip');
    expect(res.body.data.school.stats.avg).toBe(75);
    expect(res.body.data.byGrade).toHaveLength(1);
    expect(res.body.data.byGrade[0].grade).toBe('5');
    expect(res.body.data.byGrade[0].students).toHaveLength(2);
    expect(res.body.data.bySubject[0].subject).toBe('Math');
    expect(res.body.data.termDiff).toBeUndefined();
  });

  it('includes termDiff when compareTerm is provided', async () => {
    mockQueryResponse(sampleRows); // current matrix
    mockQueryResponse([matrixRow({ term_id: 't0', score: 70 })]); // compare matrix
    mockQueryResponse([]); // terms

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ termId: 't1', compareTerm: 't0' });

    expect(res.status).toBe(200);
    expect(res.body.data.compareTermId).toBe('t0');
    expect(res.body.data.termDiff.byGrade[0]).toMatchObject({
      grade: '5',
      currentAvg: 75,
      previousAvg: 70,
      avgDiff: 5,
    });
  });

  it('returns 400 when termId is missing', async () => {
    const res = await request(app).get(url).set(authHeader());
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('termId');
  });

  it('returns 400 for an unknown engine', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ termId: 't1', engine: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Unknown grade engine');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB down');
    const res = await request(app).get(url).set(authHeader()).query({ termId: 't1' });
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(url).query({ termId: 't1' });
    expect(res.status).toBe(401);
  });

  it('allows teachers (school-wide access)', async () => {
    mockQueryResponse(sampleRows);
    mockQueryResponse([]);
    const res = await request(app)
      .get(url)
      .set({ Authorization: `Bearer ${mockTeacherUser()}` })
      .query({ termId: 't1' });
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/analytics/class/:classId ──────────────────────────
describe('GET /api/analytics/class/:classId', () => {
  it('returns class detail with rankings and assessment stats', async () => {
    mockQueryResponse(sampleRows); // matrix (termId provided, no class lookup)

    const res = await request(app)
      .get('/api/analytics/class/c1')
      .set(authHeader())
      .query({ termId: 't1' });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.classId).toBe('c1');
    expect(d.summary.stats.median).toBe(75);
    expect(d.students[0]).toMatchObject({ studentName: 'Alice', finalPct: 85, rank: 1 });
    expect(d.students[1]).toMatchObject({ studentName: 'Bob', finalPct: 65, rank: 2 });
    expect(d.assessments).toHaveLength(1);
    expect(d.assessments[0].completionRate).toBe(1);
    expect(d.trend).toHaveLength(1);
  });

  it('resolves the term when termId is omitted', async () => {
    mockQueryResponse([{ term_id: 't1', subject: 'Math', grade: '5', teacher_name: 'Ms. Test' }]); // selectTermIdForClass
    mockQueryResponse(sampleRows); // matrix

    const res = await request(app).get('/api/analytics/class/c1').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.data.termId).toBe('t1');
  });

  it('404s for a class not in the matrix', async () => {
    mockQueryResponse(sampleRows);
    const res = await request(app)
      .get('/api/analytics/class/nope')
      .set(authHeader())
      .query({ termId: 't1' });
    expect(res.status).toBe(404);
  });

  it('404s when the class lookup finds nothing', async () => {
    mockQueryResponse([]); // selectTermIdForClass empty
    const res = await request(app).get('/api/analytics/class/nope').set(authHeader());
    expect(res.status).toBe(404);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB down');
    const res = await request(app)
      .get('/api/analytics/class/c1')
      .set(authHeader())
      .query({ termId: 't1' });
    expect(res.status).toBe(500);
  });
});

// ─── GET /api/analytics/student/:studentId ──────────────────────
describe('GET /api/analytics/student/:studentId', () => {
  it('returns student detail with percentiles, attendance and missing work', async () => {
    const rows = [
      ...sampleRows,
      matrixRow({ assessment_id: 'a2', assessment_name: 'Quiz 2', score: null, weight_points: 50 }),
      matrixRow({
        student_id: 's2',
        student_name: 'Bob',
        assessment_id: 'a2',
        assessment_name: 'Quiz 2',
        score: 50,
        weight_points: 50,
      }),
    ];
    mockQueryResponse(rows); // matrix
    mockQueryResponse([
      { student_id: 's1', present_days: 48, total_days: 50, attendance_pct: '96.0' },
    ]); // attendance

    const res = await request(app)
      .get('/api/analytics/student/s1')
      .set(authHeader())
      .query({ termId: 't1' });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.studentName).toBe('Alice');
    expect(d.attendance.pct).toBe(96);
    expect(d.overall.avg).toBe(85); // null_skip: Quiz 2 ungraded -> skipped
    expect(d.classes).toHaveLength(1);
    expect(d.missingWork).toHaveLength(1);
    expect(d.missingWork[0].assessmentName).toBe('Quiz 2');
    expect(d.termTrajectory).toBeUndefined();
  });

  it('includes termTrajectory when compareTerm is provided', async () => {
    mockQueryResponse(sampleRows); // current matrix
    mockQueryResponse([]); // attendance
    mockQueryResponse([matrixRow({ term_id: 't0', score: 75 })]); // compare matrix

    const res = await request(app)
      .get('/api/analytics/student/s1')
      .set(authHeader())
      .query({ termId: 't1', compareTerm: 't0' });

    expect(res.status).toBe(200);
    expect(res.body.data.termTrajectory).toMatchObject({
      currentAvg: 85,
      compareAvg: 75,
      diff: 10,
    });
  });

  it('returns 400 when termId is missing', async () => {
    const res = await request(app).get('/api/analytics/student/s1').set(authHeader());
    expect(res.status).toBe(400);
  });

  it('404s for an unknown student', async () => {
    mockQueryResponse(sampleRows);
    mockQueryResponse([]);
    const res = await request(app)
      .get('/api/analytics/student/nope')
      .set(authHeader())
      .query({ termId: 't1' });
    expect(res.status).toBe(404);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB down');
    mockQueryError('DB down');
    const res = await request(app)
      .get('/api/analytics/student/s1')
      .set(authHeader())
      .query({ termId: 't1' });
    expect(res.status).toBe(500);
  });
});

// ─── GET /api/analytics/snapshot ────────────────────────────────
describe('GET /api/analytics/snapshot', () => {
  it('returns the compact AI snapshot', async () => {
    mockQueryResponse(sampleRows); // matrix
    mockQueryResponse([]); // attendance

    const res = await request(app)
      .get('/api/analytics/snapshot')
      .set(authHeader())
      .query({ termId: 't1' });

    expect(res.status).toBe(200);
    expect(res.body.data.students).toHaveLength(2);
    expect(res.body.data.students[0]).toHaveProperty('overallAvg');
    expect(res.body.data.students[0]).toHaveProperty('missingCount');
  });

  it('returns 400 when termId is missing', async () => {
    const res = await request(app).get('/api/analytics/snapshot').set(authHeader());
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/analytics/invalidate-cache ───────────────────────
describe('POST /api/analytics/invalidate-cache', () => {
  it('invalidates and returns success', async () => {
    const res = await request(app)
      .post('/api/analytics/invalidate-cache')
      .set(authHeader())
      .send({ termId: 't1' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });
});
