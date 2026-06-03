const engine = require('../../../services/analyticsEngine');
const db = require('../../__mocks__/config/database');
const { mockQueryResponse } = require('../../helpers/mockDb');

// Build one flat matrix row (shape of selectAnalyticsMatrix output).
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
    weight_percent: 50,
    weight_points: 50,
    max_score: 100,
    is_parent: false,
    parent_assessment_id: null,
    assessment_date: '2025-10-01',
    sort_order: 1,
    score: 80,
    is_excluded: false,
    ...overrides,
  };
}

beforeEach(() => {
  engine.invalidateCache();
});

describe('normalizeEngine', () => {
  it('defaults to null_skip', () => {
    expect(engine.normalizeEngine(undefined)).toBe('null_skip');
    expect(engine.normalizeEngine('')).toBe('null_skip');
  });
  it('accepts valid engines', () => {
    expect(engine.normalizeEngine('null_zero')).toBe('null_zero');
  });
  it('throws a 400-coded error for unknown engines', () => {
    expect(() => engine.normalizeEngine('bogus')).toThrow(/Unknown grade engine/);
    try {
      engine.normalizeEngine('bogus');
    } catch (e) {
      expect(e.statusCode).toBe(400);
    }
  });
});

describe('buildMatrixFromRows + engine toggle', () => {
  // Two assessments, 50 pts each; one graded 80%, one ungraded.
  const rows = [
    matrixRow({ assessment_id: 'a1', score: 80 }),
    matrixRow({ assessment_id: 'a2', assessment_name: 'Quiz 2', score: null }),
  ];

  it('null_skip skips ungraded work (80%)', () => {
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_skip');
    const stu = matrix.classes.get('c1').students.get('s1');
    expect(stu.finalPct).toBeCloseTo(80);
  });

  it('null_zero counts ungraded work as 0 (40%)', () => {
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_zero');
    const stu = matrix.classes.get('c1').students.get('s1');
    expect(stu.finalPct).toBeCloseTo(40);
  });

  it('null_skip returns null when nothing is graded', () => {
    const ungraded = [matrixRow({ score: null })];
    const matrix = engine.buildMatrixFromRows(ungraded, 't1', 'null_skip');
    expect(matrix.classes.get('c1').students.get('s1').finalPct).toBeNull();
  });

  it('builds the cross-class student record', () => {
    const twoClasses = [
      matrixRow(),
      matrixRow({ class_id: 'c2', subject: 'Science', assessment_id: 'a9', score: 60 }),
    ];
    const matrix = engine.buildMatrixFromRows(twoClasses, 't1', 'null_skip');
    const cross = matrix.students.get('s1');
    expect(cross.classes).toHaveLength(2);
    expect(engine.overallAvgForStudent(cross)).toBeCloseTo(70);
  });
});

describe('countWorkStatus', () => {
  it('counts missing standalone, skips excluded', () => {
    const assessments = [
      { assessment_id: 'a1', is_parent: false, parent_assessment_id: null },
      { assessment_id: 'a2', is_parent: false, parent_assessment_id: null },
      { assessment_id: 'a3', is_parent: false, parent_assessment_id: null },
    ];
    const rows = [
      { assessment_id: 'a1', score: 80, is_excluded: false },
      { assessment_id: 'a2', score: null, is_excluded: false },
      { assessment_id: 'a3', score: null, is_excluded: true },
    ];
    const ws = engine.countWorkStatus(assessments, rows);
    expect(ws.missing).toBe(1);
    expect(ws.excluded).toBe(1);
    expect(ws.missingAssessments.map((a) => a.assessment_id)).toEqual(['a2']);
  });

  it('a parent is missing only when no child is graded', () => {
    const assessments = [
      { assessment_id: 'p1', is_parent: true, parent_assessment_id: null },
      { assessment_id: 'ch1', is_parent: false, parent_assessment_id: 'p1' },
      { assessment_id: 'ch2', is_parent: false, parent_assessment_id: 'p1' },
    ];
    const graded = engine.countWorkStatus(assessments, [
      { assessment_id: 'ch1', score: 5, is_excluded: false },
      { assessment_id: 'ch2', score: null, is_excluded: false },
    ]);
    expect(graded.missing).toBe(0);

    const ungraded = engine.countWorkStatus(assessments, [
      { assessment_id: 'ch1', score: null, is_excluded: false },
      { assessment_id: 'ch2', score: null, is_excluded: false },
    ]);
    expect(ungraded.missing).toBe(1);
  });
});

describe('buildAnalyticsMatrix caching', () => {
  it('caches per (school, term, engine) and invalidates correctly', async () => {
    mockQueryResponse([matrixRow()]);
    const first = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip');
    const second = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip');
    expect(second).toBe(first); // cache hit, no second query
    expect(db.query).toHaveBeenCalledTimes(1);

    // Different engine -> separate cache entry -> new query
    mockQueryResponse([matrixRow()]);
    await engine.buildAnalyticsMatrix('SCH', 't1', 'null_zero');
    expect(db.query).toHaveBeenCalledTimes(2);

    // Invalidate school -> re-fetch
    engine.invalidateCache('SCH');
    mockQueryResponse([matrixRow()]);
    const third = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip');
    expect(third).not.toBe(first);
    expect(db.query).toHaveBeenCalledTimes(3);
  });
});

describe('ALL_TERMS combined mode', () => {
  it('merges classes from multiple terms into one matrix', async () => {
    mockQueryResponse([
      matrixRow({ term_id: 't1', score: 80 }),
      matrixRow({ term_id: 't2', class_id: 'c2', subject: 'Math', assessment_id: 'a9', score: 60 }),
    ]);
    const matrix = await engine.buildAnalyticsMatrix('SCH', engine.ALL_TERMS, 'null_skip');
    expect(matrix.classes.size).toBe(2);
    const cross = matrix.students.get('s1');
    expect(cross.classes).toHaveLength(2);
    expect(engine.overallAvgForStudent(cross)).toBeCloseTo(70);
    // The all-terms variant must use the school-only query (1 param)
    expect(db.query.mock.calls[0][1]).toEqual(['SCH']);
  });

  it('uses the all-terms attendance query', async () => {
    mockQueryResponse([
      { student_id: 's1', present_days: 90, total_days: 100, attendance_pct: '90.0' },
    ]);
    const map = await engine.getAttendanceMap('SCH', engine.ALL_TERMS);
    expect(map.get('s1').pct).toBe(90);
    expect(db.query.mock.calls[0][1]).toEqual(['SCH']);
  });
});

describe('buildAiSnapshot', () => {
  it('returns compact per-student records with attendance and lowest subject', async () => {
    // matrix query
    mockQueryResponse([
      matrixRow({ score: 90 }),
      matrixRow({ class_id: 'c2', subject: 'Science', assessment_id: 'a9', score: 40 }),
    ]);
    // attendance query
    mockQueryResponse([
      { student_id: 's1', present_days: 45, total_days: 50, attendance_pct: '90.0' },
    ]);

    const snap = await engine.buildAiSnapshot('SCH', 't1', 'null_skip');
    expect(snap.students).toHaveLength(1);
    const s = snap.students[0];
    expect(s.overallAvg).toBeCloseTo(65);
    expect(s.attendancePct).toBe(90);
    expect(s.lowestSubject).toBe('Science');
    expect(s.lowestPct).toBeCloseTo(40);
  });
});
