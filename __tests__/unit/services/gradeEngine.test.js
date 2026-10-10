const engine = require('../../../services/gradeEngine');

const standalone = (id, weight, max = 100) => ({
  assessment_id: id, weight_points: weight, max_score: max, is_parent: false, parent_assessment_id: null,
});
const parent = (id, weight) => ({
  assessment_id: id, weight_points: weight, max_score: null, is_parent: true, parent_assessment_id: null,
});
const child = (id, parentId, weight, max = 10) => ({
  assessment_id: id, weight_points: weight, max_score: max, is_parent: false, parent_assessment_id: parentId,
});
const row = (assessment_id, score, status = 'graded') => ({ assessment_id, score, status });

describe('cellState', () => {
  it('maps rows to the four states', () => {
    expect(engine.cellState(undefined)).toBe('blank');
    expect(engine.cellState(row('a', null))).toBe('blank');
    expect(engine.cellState(row('a', 0))).toBe('graded');
    expect(engine.cellState(row('a', '7.5'))).toBe('graded');
    expect(engine.cellState(row('a', null, 'missing'))).toBe('missing');
    expect(engine.cellState(row('a', 9, 'excused'))).toBe('excused');
  });
  it('honours legacy is_excluded when status is absent', () => {
    expect(engine.cellState({ assessment_id: 'a', score: 5, is_excluded: true })).toBe('excused');
    expect(engine.cellState({ assessment_id: 'a', score: 5, is_excluded: false })).toBe('graded');
  });
});

describe('computeClassGrade — standalone assessments', () => {
  const assessments = [standalone('a1', 50), standalone('a2', 50)];

  it('averages graded work only (blank carries no weight)', () => {
    const r = engine.computeClassGrade(assessments, [row('a1', 80)]);
    expect(r.pct).toBeCloseTo(80);
    expect(r.coverage).toMatchObject({ assessed: 1, graded: 1, missing: 0, excused: 0, blank: 1, total: 2, countedWeight: 50, totalWeight: 100 });
  });

  it('returns null, never 0, when nothing has evidence', () => {
    expect(engine.computeClassGrade(assessments, []).pct).toBeNull();
    expect(engine.computeClassGrade(assessments, [row('a1', null), row('a2', null)]).pct).toBeNull();
  });

  it('counts a typed 0 as a real zero', () => {
    const r = engine.computeClassGrade(assessments, [row('a1', 0), row('a2', 100)]);
    expect(r.pct).toBeCloseTo(50);
  });

  it('counts missing as 0 with full weight', () => {
    const r = engine.computeClassGrade(assessments, [row('a1', 80), row('a2', null, 'missing')]);
    expect(r.pct).toBeCloseTo(40);
    expect(r.coverage.missing).toBe(1);
    expect(r.coverage.assessed).toBe(2);
    expect(r.missingAssessments.map((a) => a.assessment_id)).toEqual(['a2']);
  });

  it('ignores excused cells even when they hold a score', () => {
    const r = engine.computeClassGrade(assessments, [row('a1', 80), row('a2', 10, 'excused')]);
    expect(r.pct).toBeCloseTo(80);
    expect(r.coverage.excused).toBe(1);
  });

  it('all excused -> null', () => {
    expect(engine.computeClassGrade(assessments, [row('a1', 80, 'excused'), row('a2', 10, 'excused')]).pct).toBeNull();
  });

  it('respects max_score and unequal weights', () => {
    const a = [standalone('q', 20, 10), standalone('t', 80, 50)];
    const r = engine.computeClassGrade(a, [row('q', 5), row('t', 50)]);
    // q = 50% * 20 = 10, t = 100% * 80 = 80 -> 90 / 100
    expect(r.pct).toBeCloseTo(90);
  });

  it('scales to counted weight when the class does not total 100 points', () => {
    const a = [standalone('q', 20), standalone('t', 30)];
    const r = engine.computeClassGrade(a, [row('q', 50), row('t', 100)]);
    expect(r.pct).toBeCloseTo((10 + 30) / 50 * 100);
  });
});

describe('computeClassGrade — categories', () => {
  const assessments = [
    parent('P', 40), child('c1', 'P', 5), child('c2', 'P', 5), child('c3', 'P', 10),
    standalone('s', 60),
  ];

  it('rolls up counted children only', () => {
    const r = engine.computeClassGrade(assessments, [row('c1', 8), row('s', 60)]);
    // P = 80% (only c1 counts), s = 60% -> (0.8*40 + 0.6*60) / 100 = 68
    expect(r.pct).toBeCloseTo(68);
    expect(r.coverage).toMatchObject({ graded: 2, blank: 2, total: 4 });
  });

  it('a category with no counted children is not counted', () => {
    const r = engine.computeClassGrade(assessments, [row('s', 60)]);
    expect(r.pct).toBeCloseTo(60);
    expect(r.coverage.countedWeight).toBe(60);
  });

  it('a missing child counts as 0 inside the category', () => {
    const r = engine.computeClassGrade(assessments, [row('c1', 10), row('c2', null, 'missing')]);
    // P = (1*5 + 0*5) / 10 = 50%; only P counted -> 50
    expect(r.pct).toBeCloseTo(50);
  });

  it('clamps a child score above max to 100%', () => {
    const r = engine.computeClassGrade(assessments, [row('c1', 12)]);
    expect(r.pct).toBeCloseTo(100);
  });

  it('reports a fully excused category as excused', () => {
    const lookup = engine.buildScoreLookup([row('c1', 1, 'excused'), row('c2', 1, 'excused'), row('c3', 1, 'excused')]);
    const r = engine.computeAssessmentForStudent(assessments[0], assessments, lookup);
    expect(r.state).toBe('excused');
    expect(r.isCounted).toBe(false);
  });
});

describe('computeAssessmentForStudent — standalone shapes', () => {
  const a = standalone('x', 10, 20);
  it('graded', () => {
    const r = engine.computeAssessmentForStudent(a, [a], engine.buildScoreLookup([row('x', 15)]));
    expect(r).toMatchObject({ state: 'graded', isCounted: true, pct: 75, earned: 15, max: 20, weight: 10 });
  });
  it('missing', () => {
    const r = engine.computeAssessmentForStudent(a, [a], engine.buildScoreLookup([row('x', null, 'missing')]));
    expect(r).toMatchObject({ state: 'missing', isCounted: true, pct: 0, earned: 0, max: 20 });
  });
  it('blank and excused are not counted', () => {
    expect(engine.computeAssessmentForStudent(a, [a], {}).isCounted).toBe(false);
    expect(engine.computeAssessmentForStudent(a, [a], engine.buildScoreLookup([row('x', 5, 'excused')])).state).toBe('excused');
  });
});

describe('computeClassGradesForAll', () => {
  it('groups rows per student', () => {
    const assessments = [standalone('a', 100)];
    const rows = [
      { student_id: 's1', assessment_id: 'a', score: 90, status: 'graded' },
      { student_id: 's2', assessment_id: 'a', score: null, status: 'graded' },
    ];
    const out = engine.computeClassGradesForAll(assessments, rows);
    expect(out.get('s1').pct).toBe(90);
    expect(out.get('s2').pct).toBeNull();
  });
});

describe('formatCoverage / reportCardMark', () => {
  it('formats coverage', () => {
    expect(engine.formatCoverage({ assessed: 2, total: 5, missing: 1, excused: 0 })).toBe('2 of 5 assessed · 1 missing');
    expect(engine.formatCoverage({ assessed: 1, total: 5, missing: 0, excused: 1 })).toBe('1 of 5 assessed · 1 excused');
  });
  it('maps report card marks', () => {
    expect(engine.reportCardMark(null)).toBe('I');
    expect(engine.reportCardMark(42)).toBe('R');
    expect(engine.reportCardMark(50)).toBe(50);
    expect(engine.reportCardMark(88.4)).toBe(88.4);
  });
});
