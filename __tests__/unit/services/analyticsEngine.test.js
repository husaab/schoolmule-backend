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
    is_published: true,
    parent_comment: null,
    published_at: '2025-10-02T00:00:00.000Z',
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

describe('publishedOnly (parent-visible matrix)', () => {
  // Two standalones worth 50 pts each: a1 graded 80%, a2 graded 40%.
  // Unfiltered that averages to 60%.
  const rows = [
    matrixRow({ assessment_id: 'a1', score: 80, is_published: true }),
    matrixRow({ assessment_id: 'a2', assessment_name: 'Quiz 2', score: 40, is_published: false }),
  ];

  it('defaults to off — the full matrix is unchanged', () => {
    const withoutOption = engine.buildMatrixFromRows(rows, 't1', 'null_skip');
    const explicitlyOff = engine.buildMatrixFromRows(rows, 't1', 'null_skip', {
      publishedOnly: false,
    });
    expect(withoutOption.classes.get('c1').students.get('s1').finalPct).toBeCloseTo(60);
    expect(explicitlyOff.classes.get('c1').students.get('s1').finalPct).toBeCloseTo(60);
  });

  it('recomputes finalPct over the published subset, not just hiding rows', () => {
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_skip', { publishedOnly: true });
    const stu = matrix.classes.get('c1').students.get('s1');
    // a2's 40% is gone AND its 50 pts leave the denominator -> 80%, not 60%.
    expect(stu.finalPct).toBeCloseTo(80);
    expect(stu.rows).toHaveLength(1);
    expect(matrix.classes.get('c1').assessments).toHaveLength(1);
  });

  it('does the same for the null_zero engine', () => {
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_zero', { publishedOnly: true });
    expect(matrix.classes.get('c1').students.get('s1').finalPct).toBeCloseTo(80);
  });

  it('does not count unpublished work as missing', () => {
    const withMissing = [
      matrixRow({ assessment_id: 'a1', score: 80, is_published: true }),
      matrixRow({ assessment_id: 'a2', score: null, is_published: false }),
    ];
    const parentView = engine.buildMatrixFromRows(withMissing, 't1', 'null_skip', {
      publishedOnly: true,
    });
    const teacherView = engine.buildMatrixFromRows(withMissing, 't1', 'null_skip');
    expect(parentView.classes.get('c1').students.get('s1').missingCount).toBe(0);
    expect(teacherView.classes.get('c1').students.get('s1').missingCount).toBe(1);
  });

  // The structural-inclusion rule. Both engines reach a category's children
  // only by finding the category in the top-level list first, so dropping an
  // unpublished category would make its published child unreachable — it
  // would silently vanish from finalPct with no error anywhere.
  describe('structural inclusion of categories', () => {
    const categoryRows = [
      matrixRow({
        assessment_id: 'cat',
        assessment_name: 'Quizzes',
        is_parent: true,
        weight_points: 100,
        max_score: null,
        score: null,
        is_published: false, // category itself never explicitly published
      }),
      matrixRow({
        assessment_id: 'kid1',
        assessment_name: 'Quiz 1',
        parent_assessment_id: 'cat',
        weight_points: 10,
        score: 90,
        is_published: true,
      }),
      matrixRow({
        assessment_id: 'kid2',
        assessment_name: 'Quiz 2',
        parent_assessment_id: 'cat',
        weight_points: 10,
        score: 50,
        is_published: false,
      }),
    ];

    it('keeps an unpublished category alive when a child is published', () => {
      const matrix = engine.buildMatrixFromRows(categoryRows, 't1', 'null_skip', {
        publishedOnly: true,
      });
      const cls = matrix.classes.get('c1');
      const ids = cls.assessments.map((a) => a.assessment_id);
      expect(ids).toContain('cat');
      expect(ids).toContain('kid1');
      expect(ids).not.toContain('kid2');
      // Rollup over the published child only: 90%, not (90+50)/2.
      expect(cls.students.get('s1').finalPct).toBeCloseTo(90);
    });

    it('drops a category once none of its children are published', () => {
      const nonePublished = categoryRows.map((r) => ({ ...r, is_published: false }));
      const matrix = engine.buildMatrixFromRows(nonePublished, 't1', 'null_skip', {
        publishedOnly: true,
      });
      const cls = matrix.classes.get('c1');
      expect(cls.assessments).toHaveLength(0);
      expect(cls.students.get('s1').finalPct).toBeNull();
    });
  });
});

describe('getStudentClassBreakdown', () => {
  it('returns null for a student who is not in the matrix', () => {
    const matrix = engine.buildMatrixFromRows([matrixRow()], 't1', 'null_skip');
    expect(engine.getStudentClassBreakdown(matrix, 'nobody')).toBeNull();
  });

  it('gives a category its rollup percentage instead of a null score', () => {
    const rows = [
      matrixRow({
        assessment_id: 'cat',
        assessment_name: 'Quizzes',
        is_parent: true,
        weight_points: 100,
        max_score: null,
        score: null,
      }),
      matrixRow({
        assessment_id: 'kid1',
        parent_assessment_id: 'cat',
        weight_points: 10,
        score: 90,
      }),
      matrixRow({
        assessment_id: 'kid2',
        parent_assessment_id: 'cat',
        weight_points: 10,
        score: 70,
      }),
    ];
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_skip');
    const breakdown = engine.getStudentClassBreakdown(matrix, 's1');
    const category = breakdown.classes[0].assessmentScores.find((a) => a.assessmentId === 'cat');

    expect(category.score).toBeNull(); // categories have no raw score...
    expect(category.rollupPct).toBeCloseTo(80); // ...but do have a rollup
    expect(category.isParent).toBe(true);
  });

  it('leaves rollupPct null on a category with no graded children', () => {
    const rows = [
      matrixRow({
        assessment_id: 'cat',
        is_parent: true,
        weight_points: 100,
        max_score: null,
        score: null,
      }),
      matrixRow({ assessment_id: 'kid1', parent_assessment_id: 'cat', score: null }),
    ];
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_skip');
    const breakdown = engine.getStudentClassBreakdown(matrix, 's1');
    const category = breakdown.classes[0].assessmentScores.find((a) => a.assessmentId === 'cat');
    expect(category.rollupPct).toBeNull();
  });

  it('flags category rows in missingWork so the parent portal can filter them', () => {
    const rows = [
      matrixRow({
        assessment_id: 'cat',
        is_parent: true,
        weight_points: 100,
        max_score: null,
        score: null,
      }),
      matrixRow({ assessment_id: 'kid1', parent_assessment_id: 'cat', score: null }),
    ];
    const matrix = engine.buildMatrixFromRows(rows, 't1', 'null_skip');
    const breakdown = engine.getStudentClassBreakdown(matrix, 's1');
    expect(breakdown.missingWork).toHaveLength(1);
    expect(breakdown.missingWork[0].isParent).toBe(true);
  });
});

describe('invalidateCache with the publishedOnly key', () => {
  it('clears both the full and published-only variants by exact key', async () => {
    mockQueryResponse([matrixRow()]);
    const full = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip');
    mockQueryResponse([matrixRow()]);
    const parentView = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip', {
      publishedOnly: true,
    });
    expect(db.query).toHaveBeenCalledTimes(2); // separate cache entries

    // The exact-match branch must know about the :pub/:all suffix — a bare
    // 3-part key would silently match nothing and leave both entries stale.
    engine.invalidateCache('SCH', 't1', 'null_skip');

    mockQueryResponse([matrixRow()]);
    const refetchedFull = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip');
    mockQueryResponse([matrixRow()]);
    const refetchedParent = await engine.buildAnalyticsMatrix('SCH', 't1', 'null_skip', {
      publishedOnly: true,
    });

    expect(refetchedFull).not.toBe(full);
    expect(refetchedParent).not.toBe(parentView);
    expect(db.query).toHaveBeenCalledTimes(4);
  });
});
