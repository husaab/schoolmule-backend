const { loadMatrixRows, joinMatrixRows } = require('../../../services/analyticsMatrix');
const q = require('../../../queries/analytics.queries');
const db = require('../../__mocks__/config/database');
const { mockMatrixRows } = require('../../helpers/mockDb');

const cls = (overrides = {}) => ({
  class_id: 'c1', class_grade: '5', subject: 'Math', teacher_name: 'Ms. Test', show_class_average: true, term_id: 't1', ...overrides,
});
const assessment = (overrides = {}) => ({
  class_id: 'c1',
  assessment_id: 'a1',
  assessment_name: 'Quiz 1',
  weight_percent: null,
  weight_points: '10',
  max_score: '10',
  is_parent: false,
  parent_assessment_id: null,
  assessment_date: '2026-10-01',
  sort_order: 1,
  is_published: true,
  parent_comment: null,
  published_at: null,
  is_turn_in: false,
  ...overrides,
});
const student = (id, name) => ({ student_id: id, student_name: name, student_grade: '5', homeroom_teacher_id: 'hr1' });

const reads = (overrides = {}) => ({
  classes: [cls()],
  assessments: [assessment(), assessment({ assessment_id: 'a2', assessment_name: 'Quiz 2', sort_order: 2 })],
  enrollments: [
    { class_id: 'c1', student_id: 's1', stats_left_out_class: false },
    { class_id: 'c1', student_id: 's2', stats_left_out_class: true },
  ],
  students: [student('s1', 'Alice'), student('s2', 'Bea')],
  scores: [
    { student_id: 's1', assessment_id: 'a1', score: '8', status: null },
    { student_id: 's2', assessment_id: 'a1', score: null, status: 'excused' },
    { student_id: 's2', assessment_id: 'a2', score: null, status: 'missing' },
  ],
  leftOutCells: [{ class_id: 'c1', student_id: 's1', assessment_id: 'a2' }],
  ...overrides,
});

const cell = (rows, studentId, assessmentId) =>
  rows.find((r) => r.student_id === studentId && r.assessment_id === assessmentId);

describe('joinMatrixRows', () => {
  it('gives every enrolled student a row for every assessment of the class, in order', () => {
    const rows = joinMatrixRows(reads());
    expect(rows.map((r) => `${r.student_id}:${r.assessment_id}`)).toEqual(['s1:a1', 's1:a2', 's2:a1', 's2:a2']);
  });

  it('carries every column the wide matrix query returned', () => {
    expect(cell(joinMatrixRows(reads()), 's1', 'a1')).toEqual({
      class_id: 'c1',
      class_grade: '5',
      subject: 'Math',
      teacher_name: 'Ms. Test',
      show_class_average: true,
      term_id: 't1',
      student_id: 's1',
      student_name: 'Alice',
      student_grade: '5',
      homeroom_teacher_id: 'hr1',
      assessment_id: 'a1',
      assessment_name: 'Quiz 1',
      weight_percent: null,
      weight_points: '10',
      max_score: '10',
      is_parent: false,
      parent_assessment_id: null,
      assessment_date: '2026-10-01',
      sort_order: 1,
      is_published: true,
      parent_comment: null,
      published_at: null,
      is_turn_in: false,
      score: '8',
      status: 'graded',
      is_excluded: false,
      stats_left_out_class: false,
      stats_left_out_assessment: false,
    });
  });

  it('reads a cell with no score row as blank: no score, status graded', () => {
    const blank = cell(joinMatrixRows(reads()), 's1', 'a2');
    expect(blank).toMatchObject({ score: null, status: 'graded', is_excluded: false });
  });

  it('keeps the stored status, and an excused cell is excluded', () => {
    const rows = joinMatrixRows(reads());
    expect(cell(rows, 's2', 'a1')).toMatchObject({ status: 'excused', is_excluded: true });
    expect(cell(rows, 's2', 'a2')).toMatchObject({ status: 'missing', is_excluded: false });
  });

  it('flags students left out of the class and cells left out of one assessment', () => {
    const rows = joinMatrixRows(reads());
    expect(cell(rows, 's2', 'a1').stats_left_out_class).toBe(true);
    expect(cell(rows, 's1', 'a2').stats_left_out_assessment).toBe(true);
    expect(cell(rows, 's1', 'a1').stats_left_out_assessment).toBe(false);
  });

  it('gives a class with no assessments no rows', () => {
    expect(joinMatrixRows(reads({ assessments: [] }))).toEqual([]);
  });

  it('skips a student or class that appeared between the parallel reads', () => {
    const rows = joinMatrixRows(reads({ students: [student('s1', 'Alice')] }));
    expect(new Set(rows.map((r) => r.student_id))).toEqual(new Set(['s1']));
    expect(joinMatrixRows(reads({ classes: [] }))).toEqual([]);
  });
});

describe('loadMatrixRows', () => {
  it('runs each narrow query for the scope with its params, and joins them', async () => {
    mockMatrixRows([
      { ...cls(), ...assessment(), ...student('s1', 'Alice'), score: '9', status: null },
    ]);
    const rows = await loadMatrixRows('students', ['SCH', 't1', ['s1']]);

    const sql = db.query.mock.calls.map(([text]) => text);
    expect(sql).toEqual([
      q.selectMatrixClasses.students,
      q.selectMatrixAssessments.students,
      q.selectMatrixEnrollments.students,
      q.selectMatrixStudents.students,
      q.selectMatrixScores.students,
      q.selectMatrixLeftOutCells.students,
    ]);
    for (const [, params] of db.query.mock.calls) expect(params).toEqual(['SCH', 't1', ['s1']]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ student_id: 's1', assessment_id: 'a1', score: '9', status: 'graded' });
  });
});

describe('the scope filters', () => {
  it('keep JK/SK out of every read and give each scope its own filter', () => {
    for (const key of ['selectMatrixClasses', 'selectMatrixAssessments', 'selectMatrixEnrollments', 'selectMatrixStudents', 'selectMatrixScores', 'selectMatrixLeftOutCells']) {
      expect(Object.keys(q[key])).toEqual(['term', 'allTerms', 'class', 'students']);
      for (const text of Object.values(q[key])) expect(text).toContain("c.grade NOT IN ('JK', 'SK')");
      expect(q[key].term).toContain('c.term_id = $2');
      expect(q[key].class).toContain('c.class_id = $1');
      expect(q[key].students).toContain('ANY($3::uuid[])');
    }
  });
});
