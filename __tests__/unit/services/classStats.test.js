// Who a class's statistics pool (services/classStats.js), and that leaving a
// student out never touches their own grade or the roll-ups above the class.

const fs = require('fs');
const path = require('path');
const engine = require('../../../services/analyticsEngine');
const classStats = require('../../../services/classStats');

const { COUNTED, EVERYONE } = classStats.POOL;

// One matrix row (selectAnalyticsMatrix shape) with the stats_left_out_* flags.
function row(overrides = {}) {
  return {
    class_id: 'c1',
    class_grade: '6',
    subject: 'Math',
    teacher_name: 'Ms. Test',
    term_id: 't1',
    student_id: 's1',
    student_name: 'Student One',
    student_grade: '6',
    assessment_id: 'a1',
    assessment_name: 'Quiz',
    weight_points: 50,
    max_score: 100,
    is_parent: false,
    parent_assessment_id: null,
    sort_order: 1,
    is_published: true,
    score: 80,
    stats_left_out_class: false,
    stats_left_out_assessment: false,
    ...overrides,
  };
}

// Three students, two quizzes. s3 scores far below the others.
function classRows({ s3 = {}, s3a1 = {}, s3a2 = {} } = {}) {
  return [
    row({ student_id: 's1', assessment_id: 'a1', score: 80 }),
    row({ student_id: 's1', assessment_id: 'a2', assessment_name: 'Quiz 2', score: 90 }),
    row({ student_id: 's2', assessment_id: 'a1', score: 70 }),
    row({ student_id: 's2', assessment_id: 'a2', assessment_name: 'Quiz 2', score: 80 }),
    row({ student_id: 's3', assessment_id: 'a1', score: 20, ...s3, ...s3a1 }),
    row({ student_id: 's3', assessment_id: 'a2', assessment_name: 'Quiz 2', score: 30, ...s3, ...s3a2 }),
  ];
}

const classOf = (rows) => engine.buildMatrixFromRows(rows, 't1').classes.get('c1');

describe('attachLeftOut', () => {
  it('leaves everyone in when no row is flagged', () => {
    const cls = classOf(classRows());
    for (const stu of cls.students.values()) expect(stu.leftOut).toBeNull();
  });

  it('reads a whole-class exclusion from the rows', () => {
    const cls = classOf(classRows({ s3: { stats_left_out_class: true } }));
    expect(cls.students.get('s3').leftOut).toEqual({ wholeClass: true, assessmentIds: new Set() });
  });

  it('a category left out covers its children; a child never covers its category', () => {
    const rows = [
      row({ assessment_id: 'cat', is_parent: true, score: null, stats_left_out_assessment: true }),
      row({ assessment_id: 'k1', parent_assessment_id: 'cat' }),
      row({ assessment_id: 'k2', parent_assessment_id: 'cat' }),
      row({ student_id: 's2', assessment_id: 'cat', is_parent: true, score: null }),
      row({ student_id: 's2', assessment_id: 'k1', parent_assessment_id: 'cat', stats_left_out_assessment: true }),
      row({ student_id: 's2', assessment_id: 'k2', parent_assessment_id: 'cat' }),
    ];
    const cls = classOf(rows);
    expect([...cls.students.get('s1').leftOut.assessmentIds].sort()).toEqual(['cat', 'k1', 'k2']);
    expect([...cls.students.get('s2').leftOut.assessmentIds]).toEqual(['k1']);
  });
});

describe('whole-class exclusion', () => {
  const cls = classOf(classRows({ s3: { stats_left_out_class: true } }));

  it("never changes the student's own grade", () => {
    expect(cls.students.get('s3').finalPct).toBeCloseTo(25);
  });

  it('leaves the class average and median, but not the figure with everyone', () => {
    expect(classStats.classAverage(cls, COUNTED)).toBe(80);
    expect(classStats.classMedian(cls, COUNTED)).toBe(80);
    expect(classStats.classAverage(cls, EVERYONE)).toBeCloseTo(61.7, 1);
    expect(classStats.everyonePcts(cls)).toHaveLength(3);
    expect(classStats.leftOutCount(cls)).toBe(1);
  });

  it('leaves every per-assessment average', () => {
    const avgs = classStats.assessmentAverages(cls, COUNTED);
    expect(avgs.get('a1')).toEqual({ avg: 75, n: 2 });
    expect(avgs.get('a2')).toEqual({ avg: 85, n: 2 });
    expect(classStats.leftOutCount(cls, 'a1')).toBe(1);
  });

  it('is not ranked, and the others rank 1..n with no gap', () => {
    const ranks = classStats.rankInClass(cls);
    expect(ranks.get('s3')).toEqual({ rank: null, percentile: null });
    expect(ranks.get('s1')).toEqual({ rank: 1, percentile: 50 });
    expect(ranks.get('s2')).toEqual({ rank: 2, percentile: 0 });
  });
});

describe('per-assessment exclusion', () => {
  const cls = classOf(classRows({ s3a1: { stats_left_out_assessment: true } }));

  it('leaves only that assessment average', () => {
    const avgs = classStats.assessmentAverages(cls, COUNTED);
    expect(avgs.get('a1')).toEqual({ avg: 75, n: 2 });
    expect(avgs.get('a2')).toEqual({ avg: 66.7, n: 3 });
  });

  it('still counts the student in the class average and rank', () => {
    expect(classStats.classPcts(cls, COUNTED)).toHaveLength(3);
    expect(classStats.leftOutCount(cls)).toBe(0);
    expect(classStats.rankInClass(cls).get('s3').rank).toBe(3);
  });
});

describe('assessmentPools', () => {
  it('keeps excused cells out of completion and out of the average', () => {
    const cls = classOf(classRows({ s3a1: { status: 'excused' } }));
    const a1 = classStats.assessmentPools(cls, COUNTED).get('a1');
    expect(a1.eligible).toBe(2);
    expect(a1.pcts).toEqual([80, 70]);
  });

  it('rejects an unknown pool instead of guessing', () => {
    const cls = classOf(classRows());
    expect(() => classStats.classPcts(cls, 'all')).toThrow(/Unknown statistics pool/);
  });
});

describe('getStudentClassBreakdown (parent and student portals)', () => {
  const matrix = engine.buildMatrixFromRows(classRows({ s3: { stats_left_out_class: true } }), 't1');

  it('shows the left-out student and a classmate the same counted average', () => {
    // Five counted classmates, so the floor (MIN_STUDENTS_FOR_AVERAGE) is met.
    const bigger = engine.buildMatrixFromRows(
      [
        ...classRows({ s3: { stats_left_out_class: true } }),
        ...['s4', 's5', 's6'].flatMap((id) => [
          row({ student_id: id, assessment_id: 'a1', score: 75 }),
          row({ student_id: id, assessment_id: 'a2', assessment_name: 'Quiz 2', score: 85 }),
        ]),
      ],
      't1',
    );
    const left = engine.getStudentClassBreakdown(bigger, 's3').classes[0];
    const peer = engine.getStudentClassBreakdown(bigger, 's1').classes[0];
    expect(left.classAvg).toBe(80);
    expect(peer.classAvg).toBe(80);
    expect(left.finalPct).toBe(25);
    expect(left.assessmentScores.find((s) => s.assessmentId === 'a1').classAvgPct).toBe(75);
  });

  it('never tells a family who is left out', () => {
    const json = JSON.stringify(engine.getStudentClassBreakdown(matrix, 's3'));
    expect(json).not.toMatch(/leftOut|stats_left_out|classAvgAll/);
  });

  it('floors the parent portal average while anyone is left out', () => {
    // 2 counted students: below MIN_STUDENTS_FOR_AVERAGE, so no class or column average.
    const left = engine.getStudentClassBreakdown(matrix, 's1').classes[0];
    expect(left.classAvg).toBeNull();
    expect(left.assessmentScores.every((sc) => sc.classAvgPct === null)).toBe(true);
    // With nobody left out the parent portal keeps today's unfloored averages.
    const open = engine.getStudentClassBreakdown(engine.buildMatrixFromRows(classRows(), 't1'), 's1').classes[0];
    expect(open.classAvg).toBeCloseTo(61.7, 1);
  });

  it('floors the classroom average on the counted head count', () => {
    const classroomMatrix = engine.buildMatrixFromRows(
      classRows({ s3: { stats_left_out_class: true } }).map((r) => ({ ...r, show_class_average: true })),
      't1',
    );
    // 2 counted students < MIN_STUDENTS_FOR_AVERAGE (5): no average in Classroom.
    expect(engine.getStudentClassBreakdown(classroomMatrix, 's1', { classroom: true }).classes[0].classAvg).toBeNull();
  });
});

describe('one place pools a class', () => {
  // The copy-pasted idiom this module replaced. Pooling a class's term grades
  // anywhere else would skip the exclusions (or, for a roll-up, should read
  // classStats.everyonePcts so the choice is visible).
  const POOLING = /students\.values\(\)\]\s*\.map\(\(?\s*\w+\s*\)?\s*=>\s*\w+\.finalPct\)/;

  function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return jsFiles(p);
      return e.name.endsWith('.js') ? [p] : [];
    });
  }

  it('no controller or service maps cls.students to finalPct itself', () => {
    const root = path.join(__dirname, '../../..');
    const offenders = [...jsFiles(path.join(root, 'controllers')), ...jsFiles(path.join(root, 'services'))]
      .filter((f) => !f.endsWith(`${path.sep}classStats.js`))
      .filter((f) => POOLING.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});

describe('modified marks', () => {
  const LABEL = 'Earlier grade level skills';
  const modifiedS3 = () => classOf(classRows({ s3a1: { is_modified: true, modified_label: LABEL, status: 'graded' } }));

  it('a modified mark stays out of its own column, in the counted pool only', () => {
    const stu = modifiedS3().students.get('s3');
    expect(classStats.inPool(stu, COUNTED, 'a1')).toBe(false);
    expect(classStats.inPool(stu, EVERYONE, 'a1')).toBe(true);
    expect(classStats.inPool(stu, COUNTED, 'a2')).toBe(true);
  });

  it('the student stays in the class pool', () => {
    expect(classStats.inPool(modifiedS3().students.get('s3'), COUNTED)).toBe(true);
  });

  it('the column average leaves the mark out; another column is untouched', () => {
    const averages = classStats.assessmentAverages(modifiedS3(), COUNTED);
    expect(averages.get('a1')).toEqual({ avg: 75, n: 2 });
    expect(averages.get('a2').n).toBe(3);
  });

  it('class average, median and rank do not change', () => {
    const plain = classOf(classRows());
    const cls = modifiedS3();
    expect(classStats.classAverage(cls, COUNTED)).toBe(classStats.classAverage(plain, COUNTED));
    expect(classStats.classMedian(cls, COUNTED)).toBe(classStats.classMedian(plain, COUNTED));
    expect(classStats.rankInClass(cls).get('s3')).toEqual(classStats.rankInClass(plain).get('s3'));
  });

  it('never reads as a teacher leaving the student out', () => {
    const cls = modifiedS3();
    expect(cls.students.get('s3').leftOut).toBeNull();
    expect(classStats.leftOutCount(cls, 'a1')).toBe(0);
    expect(classStats.leftOutCount(cls)).toBe(0);
    expect(classStats.modifiedCount(cls, 'a1')).toBe(1);
    expect(classStats.modifiedCount(cls, 'a2')).toBe(0);
  });

  it('a teacher exclusion still counts while a modified mark is on the same column', () => {
    const cls = classOf(classRows({ s3a1: { is_modified: true, status: 'graded', stats_left_out_assessment: true } }));
    expect(classStats.leftOutCount(cls, 'a1')).toBe(1);
  });

  it.each([
    ['missing', { status: 'missing', score: null }],
    ['excused', { status: 'excused', score: 40 }],
    ['blank', { status: 'graded', score: null }],
  ])('a %s cell with the flag behaves as if it had none', (_name, cell) => {
    const flagged = classOf(classRows({ s3a1: { is_modified: true, ...cell } }));
    const plain = classOf(classRows({ s3a1: cell }));
    expect(classStats.modifiedCount(flagged, 'a1')).toBe(0);
    expect(classStats.assessmentAverages(flagged, COUNTED).get('a1')).toEqual(classStats.assessmentAverages(plain, COUNTED).get('a1'));
  });

  it('a category holding a modified mark leaves that student out of the category too', () => {
    const cat = (student_id, score, flag = {}) => [
      row({ student_id, assessment_id: 'cat', is_parent: true, score: null, max_score: null }),
      row({ student_id, assessment_id: 'kid', parent_assessment_id: 'cat', score, ...flag }),
    ];
    const cls = classOf([...cat('s1', 80), ...cat('s2', 60), ...cat('s3', 20, { is_modified: true, status: 'graded' })]);
    const stu = cls.students.get('s3');
    expect(classStats.inPool(stu, COUNTED, 'cat')).toBe(false);
    expect(classStats.modifiedCount(cls, 'cat')).toBe(1);
    expect(classStats.assessmentAverages(cls, COUNTED).get('cat').n).toBe(2);
  });

  describe('what other families see on a small class', () => {
    const LETTERS = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const portal = (rows, studentId) =>
      engine.getStudentClassBreakdown(engine.buildMatrixFromRows(rows, 't1', 'null_skip', { publishedOnly: true }), studentId).classes[0];
    const scored = (count) => LETTERS.slice(0, count + 1).map((student_id, k) => row({
      student_id,
      student_name: `Student ${k}`,
      score: k === 0 ? 20 : 80,
      ...(k === 0 ? { is_modified: true, modified_label: LABEL, status: 'graded' } : {}),
    }));

    it('one modified mark and 4 others: no column average, so nobody can subtract to it', () => {
      expect(portal(scored(4), 's2').assessmentScores[0].classAvgPct).toBeNull();
    });

    it('one modified mark and 5 others: the average of the 5', () => {
      expect(portal(scored(5), 's2').assessmentScores[0].classAvgPct).toBe(80);
    });

    it('does not hide the class-level average', () => {
      const cls = portal(scored(4), 's2');
      expect(cls.classAvg).not.toBeNull();
    });
  });
});
