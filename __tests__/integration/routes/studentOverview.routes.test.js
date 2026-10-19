// Real-SQL check of the staff student profile endpoints against the
// integration schema: every query in queries/studentOverview.queries.js runs
// for real, plus the analytics matrix the grades come from.
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const engine = require('../../../services/analyticsEngine');

const TEACHER_ID = '550e8400-e29b-41d4-a716-4466554400aa';
const PARENT_ID = '550e8400-e29b-41d4-a716-4466554400bb';

describe('student profile endpoints', () => {
  let pool, yearId, term1, term2, studentId, peerId;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    engine.invalidateCache();
    const { rows: [year] } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    yearId = year.school_year_id;

    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school) VALUES
       ($1, 'teacher.one@example.test', 'teacher1', 'x', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', TRUE, TRUE),
       ($2, 'guardian.one@example.test', 'guardian1', 'x', 'Guardian', 'One', 'ALHAADIACADEMY', 'PARENT', TRUE, TRUE)`,
      [TEACHER_ID, PARENT_ID]);

    const { rows: terms } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id) VALUES
       ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2025-12-31', FALSE, $1),
       ('ALHAADIACADEMY', 'Term 2', '2026-01-05', '2026-03-31', TRUE, $1)
       RETURNING term_id, name`, [yearId]);
    term1 = terms.find((t) => t.name === 'Term 1').term_id;
    term2 = terms.find((t) => t.name === 'Term 2').term_id;

    const { rows: students } = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, mother_name) VALUES
       ('Student One', '5', 'ALHAADIACADEMY', $1, $2, 'Guardian One'),
       ('Student Two', '5', 'ALHAADIACADEMY', $1, NULL, NULL)
       RETURNING student_id, name`, [yearId, TEACHER_ID]);
    studentId = students.find((s) => s.name === 'Student One').student_id;
    peerId = students.find((s) => s.name === 'Student Two').student_id;

    const { rows: classes } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id) VALUES
       ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, $2, 'Term 1', $4),
       ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, $3, 'Term 2', $4)
       RETURNING class_id, term_name`, [TEACHER_ID, term1, term2, yearId]);
    const c1 = classes.find((c) => c.term_name === 'Term 1').class_id;
    const c2 = classes.find((c) => c.term_name === 'Term 2').class_id;

    await pool.query(
      `INSERT INTO class_students (class_id, student_id) VALUES ($1, $3), ($2, $3), ($2, $4)`,
      [c1, c2, studentId, peerId]);

    const { rows: assessments } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_points, max_score, date, sort_order) VALUES
       ($1, 'Quiz 1', 10, 10, '2025-10-01', 1),
       ($2, 'Quiz 2', 10, 10, '2026-02-01', 1),
       ($2, 'Quiz 3', 10, 10, '2026-02-15', 2)
       RETURNING assessment_id, name`, [c1, c2]);
    const a = Object.fromEntries(assessments.map((r) => [r.name, r.assessment_id]));

    await pool.query(
      `INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES
       ($1, $3, 8, 'graded'),
       ($1, $4, 9, 'graded'),
       ($1, $5, NULL, 'missing'),
       ($2, $4, 7, 'graded')`,
      [studentId, peerId, a['Quiz 1'], a['Quiz 2'], a['Quiz 3']]);

    await pool.query(
      `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES
       ($1, '2025-10-01', 'PRESENT', 'ALHAADIACADEMY'),
       ($1, '2025-10-02', 'ABSENT', 'ALHAADIACADEMY'),
       ($1, '2026-02-02', 'LATE', 'ALHAADIACADEMY')`, [studentId]);

    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, relation, school) VALUES
       ($1, $2, NULL, 'mother', 'ALHAADIACADEMY'),
       ($1, NULL, 'Guardian Two', 'father', 'ALHAADIACADEMY')`, [studentId, PARENT_ID]);

    await pool.query(
      `INSERT INTO report_cards (student_id, term, student_name, file_path, school) VALUES
       ($1, 'Term 1', 'Student One', 'ALHAADIACADEMY/term-1/student-one.pdf', 'ALHAADIACADEMY')`, [studentId]);
  });

  it('GET /overview returns the year at a glance', async () => {
    const res = await authenticatedRequest('get', `/api/students/${studentId}/overview`, { role: 'TEACHER', userId: TEACHER_ID });
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.student).toMatchObject({ name: 'Student One', homeroomTeacherName: 'Teacher One' });
    expect(d.defaultTermId).toBe(term2);
    expect(d.terms.map((t) => [t.name, t.avg, t.startDate])).toEqual([
      ['Term 1', 80, '2025-09-01'],
      // Quiz 2 = 9/10, Quiz 3 flagged missing = 0 → 45%.
      ['Term 2', 45, '2026-01-05'],
    ]);
    expect(d.terms[0].attendance).toMatchObject({ totalDays: 2, pct: 50 });
    expect(d.attendance.days).toEqual([
      { date: '2025-10-01', status: 'PRESENT' },
      { date: '2025-10-02', status: 'ABSENT' },
      { date: '2026-02-02', status: 'LATE' },
    ]);
    expect(d.enrollments.map((e) => e.termId)).toEqual([term1, term2]);
    expect(d.guardianAccounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Guardian One', email: 'guardian.one@example.test', status: 'linked' }),
      expect.objectContaining({ name: 'Guardian Two', status: 'none' }),
    ]));
    expect(d.reports.reportCards).toHaveLength(1);
  });

  it('GET /grades returns the active term breakdown by default', async () => {
    const res = await authenticatedRequest('get', `/api/students/${studentId}/grades`);
    expect(res.status).toBe(200);
    expect(res.body.data.termId).toBe(term2);
    const detail = res.body.data.detail;
    expect(detail.overall).toMatchObject({ avg: 45, missingCount: 1 });
    expect(detail.classes[0]).toMatchObject({ subject: 'Math', finalPct: 45, classAvg: 57.5 });
    expect(detail.missingWork.map((m) => m.assessmentName)).toEqual(['Quiz 3']);
  });

  it('GET /grades?termId= switches term', async () => {
    const res = await authenticatedRequest('get', `/api/students/${studentId}/grades?termId=${term1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.detail.overall.avg).toBe(80);
  });

  it('refuses parent tokens', async () => {
    const res = await authenticatedRequest('get', `/api/students/${studentId}/overview`, { role: 'PARENT', userId: PARENT_ID });
    expect(res.status).toBe(403);
  });

  it('404s for a student of another school', async () => {
    const res = await authenticatedRequest('get', `/api/students/${studentId}/overview`, { school: 'PLAYGROUND' });
    expect(res.status).toBe(404);
  });
});
