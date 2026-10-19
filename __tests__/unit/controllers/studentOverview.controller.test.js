const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, mockParentUser } = require('../../helpers/mockAuth');
const db = require('../../__mocks__/config/database');
const engine = require('../../../services/analyticsEngine');
const q = require('../../../queries/studentOverview.queries');
const analyticsQueries = require('../../../queries/analytics.queries');
const parentPortalQueries = require('../../../queries/parentPortal.queries');
const progressReportQueries = require('../../../queries/progressReports.queries');

const STUDENT_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = '22222222-2222-4222-8222-222222222222';
const YEAR_ID = '33333333-3333-4333-8333-333333333333';

let app;
beforeAll(() => {
  app = getApp();
});

beforeEach(() => {
  engine.invalidateCache();
});

const asAdmin = () => ({ Authorization: `Bearer ${mockAdminUser()}` });

function studentRow(overrides = {}) {
  return {
    student_id: STUDENT_ID,
    name: 'Test Student',
    school: 'ALHAADIACADEMY',
    school_year_id: YEAR_ID,
    previous_student_id: null,
    homeroom_teacher_id: null,
    homeroom_teacher_name: 'Homeroom Teacher',
    grade: '5',
    oen: '123456789',
    mother_name: 'Guardian One',
    mother_email: 'guardian.one@example.test',
    mother_number: '555-0100',
    father_name: null,
    father_email: null,
    father_number: null,
    is_archived: false,
    ...overrides,
  };
}

const TERMS = [
  { term_id: 't1', name: 'Term 1', start_date: '2025-09-01', end_date: '2025-12-31', is_active: false, school_year_id: YEAR_ID },
  { term_id: 't2', name: 'Term 2', start_date: '2026-01-05', end_date: '2026-03-31', is_active: true, school_year_id: YEAR_ID },
];

function matrixRow(overrides = {}) {
  return {
    class_id: 'c1',
    class_grade: '5',
    subject: 'Math',
    teacher_name: 'Ms. Test',
    term_id: 't1',
    student_id: STUDENT_ID,
    student_name: 'Test Student',
    student_grade: '5',
    homeroom_teacher_id: null,
    assessment_id: 'a1',
    assessment_name: 'Quiz 1',
    weight_percent: 100,
    weight_points: 100,
    max_score: 100,
    is_parent: false,
    parent_assessment_id: null,
    assessment_date: '2025-10-01',
    sort_order: 1,
    score: 80,
    status: 'graded',
    is_excluded: false,
    ...overrides,
  };
}

// Matrix rows per term: Term 1 = 80% in Math, Term 2 = 90% in Math (peer 70%).
const MATRIX = {
  t1: [matrixRow()],
  t2: [
    matrixRow({ class_id: 'c2', term_id: 't2', assessment_id: 'a2', score: 90 }),
    matrixRow({ class_id: 'c2', term_id: 't2', assessment_id: 'a2', student_id: PEER_ID, student_name: 'Peer', score: 70 }),
  ],
};

/** Answer db.query by SQL identity, so Promise.all ordering never matters. */
function routeQueries({ student = studentRow(), overrides = {} } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    if (typeof sql === 'string' && sql.includes('FROM school_years')) {
      return { rows: [{ school_year_id: YEAR_ID, school: 'ALHAADIACADEMY', is_active: true, label: '2025-2026' }] };
    }
    if (overrides[sql]) return { rows: overrides[sql] };
    switch (sql) {
      case q.selectStudent: return { rows: student ? [student] : [] };
      case q.selectTerms: return { rows: TERMS };
      case q.selectEnrollments: return { rows: [
        { class_id: 'c1', subject: 'Math', class_grade: '5', teacher_id: null, teacher_name: 'Ms. Test', term_id: 't1' },
        { class_id: 'c2', subject: 'Math', class_grade: '5', teacher_id: null, teacher_name: 'Ms. Test', term_id: 't2' },
      ] };
      case q.selectAttendanceDays: return { rows: [
        { date: '2025-10-01', status: 'PRESENT' },
        { date: '2025-10-02', status: 'ABSENT' },
        { date: '2026-02-02', status: 'LATE' },
        { date: '2026-02-03', status: 'PRESENT' },
      ] };
      case q.selectGuardianLinks: return { rows: [
        { parent_student_link_id: 'l1', parent_id: 'p1', relation: 'mother', name: 'Guardian One', email: 'guardian.one@example.test', phone: null, invited_at: null },
        { parent_student_link_id: 'l2', parent_id: null, relation: 'father', name: 'Guardian Two', email: 'guardian.two@example.test', phone: null, invited_at: '2026-01-10T00:00:00Z' },
      ] };
      case q.selectReportCards: return { rows: [
        { term: 'Term 1', file_path: 'rc/t1.pdf', generated_at: '2026-01-02T00:00:00Z', email_sent: true, email_sent_at: '2026-01-03T00:00:00Z' },
      ] };
      case q.selectProgressReports: return { rows: [] };
      case parentPortalQueries.selectReportCardFeedbackByStudent: return { rows: [
        { class_id: 'c1', subject: 'Math', teacher_name: 'Ms. Test', term: 'Term 1', work_habits: 'G', behavior: 'E', comment: 'Steady work.' },
      ] };
      case progressReportQueries.getStudentProgressReportFeedback: return { rows: [] };
      case analyticsQueries.selectAnalyticsMatrix: return { rows: MATRIX[params[1]] || [] };
      case analyticsQueries.selectAttendanceForTerm: return { rows: [
        { student_id: STUDENT_ID, present_days: 2, total_days: 2, attendance_pct: '100.0' },
      ] };
      default: return { rows: [] };
    }
  });
}

const matrixCalls = () => db.query.mock.calls.filter(([sql]) => sql === analyticsQueries.selectAnalyticsMatrix);

describe('GET /api/students/:id/overview', () => {
  const url = `/api/students/${STUDENT_ID}/overview`;

  it('refuses parents', async () => {
    routeQueries();
    const res = await request(app).get(url).set({ Authorization: `Bearer ${mockParentUser()}` });
    expect(res.status).toBe(403);
  });

  it('404s a malformed id without querying the student', async () => {
    routeQueries();
    const res = await request(app).get('/api/students/not-a-uuid/overview').set(asAdmin());
    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => sql === q.selectStudent)).toBe(false);
  });

  it('404s a student of another school', async () => {
    routeQueries({ student: studentRow({ school: 'PLAYGROUND' }) });
    const res = await request(app).get(url).set(asAdmin());
    expect(res.status).toBe(404);
  });

  it('returns the profile, per-term trend, attendance, guardians and reports', async () => {
    routeQueries();
    const res = await request(app).get(url).set({ Authorization: `Bearer ${mockTeacherUser()}` });

    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.student).toMatchObject({ studentId: STUDENT_ID, name: 'Test Student', homeroomTeacherName: 'Homeroom Teacher' });
    expect(d.gradingMode).toBe('numeric');
    expect(d.defaultTermId).toBe('t2'); // the active term

    expect(d.terms.map((t) => [t.termId, t.avg])).toEqual([['t1', 80], ['t2', 90]]);
    expect(d.terms[0].subjects).toEqual([{ subject: 'Math', pct: 80 }]);
    // Attendance is split by each term's date window; LATE counts as present.
    expect(d.terms[0].attendance).toMatchObject({ presentDays: 1, absentDays: 1, totalDays: 2, pct: 50 });
    expect(d.terms[1].attendance).toMatchObject({ presentDays: 1, lateDays: 1, totalDays: 2, pct: 100 });
    expect(d.attendance.summary).toEqual({ presentDays: 2, lateDays: 1, absentDays: 1, totalDays: 4, pct: 75 });
    expect(d.attendance.days).toHaveLength(4);

    expect(d.enrollments).toHaveLength(2);
    expect(d.guardianAccounts.map((g) => g.status)).toEqual(['linked', 'invited']);
    expect(d.reports.reportCards).toEqual([
      { term: 'Term 1', filePath: 'rc/t1.pdf', generatedAt: '2026-01-02T00:00:00Z', emailSent: true, emailSentAt: '2026-01-03T00:00:00Z' },
    ]);
    expect(d.reports.reportCardFeedback[0]).toMatchObject({ subject: 'Math', workHabits: 'G', comment: 'Steady work.' });
  });

  it('skips the grade matrix for JK/SK students', async () => {
    routeQueries({ student: studentRow({ grade: 'SK' }) });
    const res = await request(app).get(url).set(asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.data.gradingMode).toBe('competency');
    expect(res.body.data.terms.every((t) => t.avg == null)).toBe(true);
    expect(matrixCalls()).toHaveLength(0);
  });

  it('500s when a query fails', async () => {
    routeQueries();
    db.query.mockImplementation(async (sql) => {
      if (sql === q.selectStudent) return { rows: [studentRow()] };
      throw new Error('DB down');
    });
    const res = await request(app).get(url).set(asAdmin());
    expect(res.status).toBe(500);
  });
});

describe('GET /api/students/:id/grades', () => {
  const url = `/api/students/${STUDENT_ID}/grades`;

  it('refuses parents', async () => {
    routeQueries();
    const res = await request(app).get(url).set({ Authorization: `Bearer ${mockParentUser()}` });
    expect(res.status).toBe(403);
  });

  it('defaults to the active term and returns the analytics detail', async () => {
    routeQueries();
    const res = await request(app).get(url).set(asAdmin());

    expect(res.status).toBe(200);
    expect(res.body.data.termId).toBe('t2');
    const detail = res.body.data.detail;
    expect(detail.overall.avg).toBe(90);
    expect(detail.classes).toHaveLength(1);
    expect(detail.classes[0]).toMatchObject({ classId: 'c2', finalPct: 90, classAvg: 80 });
    expect(detail.attendance).toEqual({ presentDays: 2, totalDays: 2, pct: 100 });
  });

  it('honours an explicit term of the student\'s year', async () => {
    routeQueries();
    const res = await request(app).get(url).query({ termId: 't1' }).set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data.termId).toBe('t1');
    expect(res.body.data.detail.overall.avg).toBe(80);
  });

  it('400s a term outside the student\'s school year', async () => {
    routeQueries();
    const res = await request(app).get(url).query({ termId: 'someone-elses-term' }).set(asAdmin());
    expect(res.status).toBe(400);
    expect(matrixCalls()).toHaveLength(0);
  });

  it('returns a null detail when the student has nothing graded that term', async () => {
    routeQueries({ overrides: { [analyticsQueries.selectAnalyticsMatrix]: [] } });
    const res = await request(app).get(url).set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ termId: 't2', detail: null });
  });

  it('returns a null detail for JK/SK without building a matrix', async () => {
    routeQueries({ student: studentRow({ grade: 'JK' }) });
    const res = await request(app).get(url).set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.data.detail).toBeNull();
    expect(matrixCalls()).toHaveLength(0);
  });

  it('404s a student of another school', async () => {
    routeQueries({ student: studentRow({ school: 'PLAYGROUND' }) });
    const res = await request(app).get(url).set(asAdmin());
    expect(res.status).toBe(404);
  });
});
