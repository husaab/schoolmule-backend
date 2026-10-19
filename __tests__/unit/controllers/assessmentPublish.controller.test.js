const {
  expandCascade,
  countUngradedStudents,
  buildEmailTasks,
  topLevelLines,
  overlayDrafts,
  planPublish,
} = require('../../../controllers/assessmentPublish.controller');

// Shape matches selectAllAssessmentsInClass.
const assessment = (overrides = {}) => ({
  assessment_id: 'a1',
  class_id: 'c1',
  name: 'Quiz 1',
  is_parent: false,
  parent_assessment_id: null,
  weight_points: 10,
  max_score: 20,
  sort_order: 1,
  is_published: false,
  parent_comment: null,
  ...overrides,
});

// Shape matches the grouped output of selectClassScoreRows.
const student = (studentId, name, rows) => [studentId, { studentId, studentName: name, rows }];

const scoreRow = (assessmentId, score, isExcluded = false) => ({
  assessment_id: assessmentId,
  score,
  is_excluded: isExcluded,
});

describe('expandCascade', () => {
  const category = assessment({
    assessment_id: 'cat',
    name: 'Quizzes',
    is_parent: true,
    weight_points: 30,
    max_score: null,
  });
  const kid1 = assessment({ assessment_id: 'kid1', parent_assessment_id: 'cat' });
  const kid2 = assessment({ assessment_id: 'kid2', parent_assessment_id: 'cat' });
  const all = [category, kid1, kid2];

  it('pulls in graded children and leaves ungraded ones alone', () => {
    const scores = new Map([
      student('s1', 'Alice', [scoreRow('kid1', 18), scoreRow('kid2', null)]),
    ]);
    const result = expandCascade([category], all, scores);

    expect(result.finalIds).toEqual(expect.arrayContaining(['cat', 'kid1']));
    expect(result.finalIds).not.toContain('kid2');
    expect(result.cascadedChildIds).toEqual(['kid1']);
    expect(result.skippedUngradedChildIds).toEqual(['kid2']);
  });

  it('treats a child graded for any student in the class as graded', () => {
    const scores = new Map([
      student('s1', 'Alice', [scoreRow('kid1', null)]),
      student('s2', 'Bilal', [scoreRow('kid1', 12)]),
    ]);
    expect(expandCascade([category], all, scores).finalIds).toContain('kid1');
  });

  it('ignores a child whose only score is excluded', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 18, true)])]);
    const result = expandCascade([category], all, scores);
    expect(result.finalIds).not.toContain('kid1');
    expect(result.skippedUngradedChildIds).toContain('kid1');
  });

  it('does not cascade from a standalone assessment', () => {
    const standalone = assessment({ assessment_id: 'solo' });
    const scores = new Map([student('s1', 'Alice', [scoreRow('solo', 5)])]);
    const result = expandCascade([standalone], [standalone], scores);
    expect(result.finalIds).toEqual(['solo']);
    expect(result.cascadedChildIds).toEqual([]);
  });

  it('keeps an explicitly selected child even when its category is not selected', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 18)])]);
    expect(expandCascade([kid1], all, scores).finalIds).toEqual(['kid1']);
  });
});

describe('countUngradedStudents', () => {
  const quiz = assessment({ assessment_id: 'q1' });

  it('counts students with no score and reports the cohort size', () => {
    const scores = new Map([
      student('s1', 'Alice', [scoreRow('q1', 15)]),
      student('s2', 'Bilal', [scoreRow('q1', null)]),
      student('s3', 'Chen', [scoreRow('q1', null)]),
    ]);
    const [warning] = countUngradedStudents([quiz], [quiz], scores);
    expect(warning.ungradedStudentCount).toBe(2);
    expect(warning.totalStudents).toBe(3);
    expect(warning.assessmentName).toBe('Quiz 1');
  });

  it('returns no warning when everyone is graded', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', 15)])]);
    expect(countUngradedStudents([quiz], [quiz], scores)).toEqual([]);
  });

  it('does not warn about an excused student (excused is deliberate, not ungraded)', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', 15, true)])]);
    expect(countUngradedStudents([quiz], [quiz], scores)).toEqual([]);
  });

  it('reports flagged-missing students separately from not-yet-graded ones', () => {
    const scores = new Map([
      student('s1', 'Alice', [{ ...scoreRow('q1', null), status: 'missing' }]),
      student('s2', 'Bilal', [scoreRow('q1', null)]),
    ]);
    const [warning] = countUngradedStudents([quiz], [quiz], scores);
    expect(warning.ungradedStudentCount).toBe(1);
    expect(warning.missingStudentCount).toBe(1);
  });
});

describe('buildEmailTasks', () => {
  const quiz = assessment({ assessment_id: 'q1', name: 'Quiz 1', max_score: 20 });
  const test = assessment({ assessment_id: 't1', name: 'Unit Test', max_score: 50 });

  it('builds one task per student with at least one graded published assessment', () => {
    const scores = new Map([
      student('s1', 'Alice', [scoreRow('q1', 18), scoreRow('t1', 40)]),
      student('s2', 'Bilal', [scoreRow('q1', null), scoreRow('t1', null)]),
    ]);
    const tasks = buildEmailTasks(['q1', 't1'], [quiz, test], scores);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].studentName).toBe('Alice');
    expect(tasks[0].lines).toEqual([
      { name: 'Quiz 1', scoreLabel: '18/20', pctLabel: '(90%)', comment: null },
      { name: 'Unit Test', scoreLabel: '40/50', pctLabel: '(80%)', comment: null },
    ]);
  });

  it('omits assessments the student has no grade for', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', 18), scoreRow('t1', null)])]);
    const tasks = buildEmailTasks(['q1', 't1'], [quiz, test], scores);
    expect(tasks[0].gradedAssessmentIds).toEqual(['q1']);
  });

  it('carries the per-assessment comment into the email line', () => {
    const commented = { ...quiz, parent_comment: 'Great recovery.' };
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', 18)])]);
    const tasks = buildEmailTasks(['q1'], [commented], scores);
    expect(tasks[0].lines[0].comment).toBe('Great recovery.');
  });

  it('reports a category as a rollup with no raw score, and skips its children', () => {
    const category = assessment({
      assessment_id: 'cat',
      name: 'Quizzes',
      is_parent: true,
      weight_points: 30,
      max_score: null,
    });
    const kid1 = assessment({ assessment_id: 'kid1', parent_assessment_id: 'cat', max_score: 10 });
    const kid2 = assessment({ assessment_id: 'kid2', parent_assessment_id: 'cat', max_score: 10 });
    const scores = new Map([
      student('s1', 'Alice', [scoreRow('kid1', 9), scoreRow('kid2', 7)]),
    ]);

    const tasks = buildEmailTasks(['cat', 'kid1', 'kid2'], [category, kid1, kid2], scores);

    // One line for the category only — listing the children too would
    // double-report the same work.
    expect(tasks[0].lines).toEqual([
      { name: 'Quizzes', scoreLabel: '', pctLabel: '(80%)', comment: null },
    ]);
  });

  it('produces no tasks when nothing published is graded', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', null)])]);
    expect(buildEmailTasks(['q1'], [quiz], scores)).toEqual([]);
  });
});

// S2: a Classwork publish of one column under a category emails the
// category's line (main's digest lists top-level assessments only), built
// from what parents can see.
describe('topLevelLines + buildEmailTasks for a column under a category', () => {
  const category = assessment({ assessment_id: 'cat', name: 'Homework', is_parent: true, weight_points: 40, max_score: null });
  const kid1 = assessment({ assessment_id: 'kid1', parent_assessment_id: 'cat', max_score: 10, is_published: true });
  const kid2 = assessment({ assessment_id: 'kid2', parent_assessment_id: 'cat', max_score: 10, is_published: false });
  const solo = assessment({ assessment_id: 'solo', name: 'Unit Test', max_score: 50 });
  const all = [category, kid1, kid2, solo];

  it('maps a child to its category and keeps a top-level column as it is', () => {
    expect(topLevelLines(['kid1', 'solo', 'kid2'], all)).toEqual({
      lineIds: ['cat', 'solo'], alsoListed: new Map([['cat', ['kid1', 'kid2']]]),
    });
    expect(topLevelLines(['gone'], all)).toEqual({ lineIds: [], alsoListed: new Map() });
  });

  it("lists the category from published columns only, and names the child in the audit ids", () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 8), scoreRow('kid2', 2)])]);
    const { lineIds, alsoListed } = topLevelLines(['kid1'], all);
    const [task] = buildEmailTasks(lineIds, all, scores, { visibleLines: true, alsoListed });
    // kid2 has a score but isn't published: it never enters the rollup.
    expect(task.lines).toEqual([{ name: 'Homework', scoreLabel: '', pctLabel: '(80%)', comment: null }]);
    expect(task.gradedAssessmentIds).toEqual(['cat', 'kid1']);
  });
});

// Spec D3: a turn-in column's scores wait as drafts on the submissions until
// Publish copies them into the gradebook. The publish plan reads them as the
// cells they will become, for the columns being published only. Per the
// controller ruling, a turn-in column keeps today's digest (it is not left
// out of the email).
describe('planPublish (classwork drafts)', () => {
  const category = assessment({ assessment_id: 'cat', name: 'Homework', is_parent: true, weight_points: 40, max_score: null });
  const hw = assessment({ assessment_id: 'hw', name: 'Plant cell diagram', parent_assessment_id: 'cat', max_score: 10 });
  const test = assessment({ assessment_id: 't1', name: 'Unit Test', max_score: 50, is_published: true });
  const solo = assessment({ assessment_id: 'solo', name: 'Fair board', max_score: 20 });
  const all = [category, hw, test, solo];
  const draft = (studentId, assessmentId, score, status = 'graded') =>
    ({ student_id: studentId, assessment_id: assessmentId, draft_score: score, draft_status: status });
  const scores = () => new Map([
    student('s1', 'Alice', [scoreRow('hw', null), scoreRow('t1', 40), scoreRow('solo', null)]),
    student('s2', 'Bilal', [scoreRow('hw', null), scoreRow('t1', null), scoreRow('solo', null)]),
  ]);

  it('a column holding only drafts cascades from its category and its drafts reach the digest', () => {
    const plan = planPublish({
      requested: [category], allAssessments: all, scoreRowsByStudent: scores(),
      pendingDrafts: [draft('s1', 'hw', 8), draft('s2', 'hw', null, 'missing')],
    });
    expect(plan.cascade.finalIds).toEqual(expect.arrayContaining(['cat', 'hw']));
    expect(plan.cascade.cascadedChildIds).toEqual(['hw']);

    const tasks = buildEmailTasks(plan.cascade.finalIds, all, plan.scoreRowsByStudent);
    expect(tasks.map((t) => [t.studentName, t.lines])).toEqual([
      ['Alice', [{ name: 'Homework', scoreLabel: '', pctLabel: '(80%)', comment: null }]],
      ['Bilal', [{ name: 'Homework', scoreLabel: '', pctLabel: '(0%)', comment: null }]],
    ]);
  });

  it("drafts of a column outside the selection never enter a figure, the running grade included", () => {
    // Fair board is already published (another student's Publish); Alice's draft there is still pending.
    const withSolo = [category, hw, test, { ...solo, is_published: true }];
    const plan = planPublish({
      requested: [test], allAssessments: withSolo, scoreRowsByStudent: scores(),
      pendingDrafts: [draft('s1', 'solo', 2)],
    });
    expect(plan.cascade.finalIds).toEqual(['t1']);
    const [alice] = buildEmailTasks(plan.cascade.finalIds, withSolo, plan.scoreRowsByStudent);
    expect(alice.lines).toEqual([{ name: 'Unit Test', scoreLabel: '40/50', pctLabel: '(80%)', comment: null }]);
    expect(alice.runningGradeLabel).toMatch(/^80% /); // the 2/20 draft would pull it down
    expect(plan.scoreRowsByStudent.get('s1').rows.find((r) => r.assessment_id === 'solo').score).toBeNull();
  });

  it('with no drafts the plan is exactly the plain-assessment one', () => {
    const rows = scores();
    const plan = planPublish({ requested: [test], allAssessments: all, scoreRowsByStudent: rows, pendingDrafts: [] });
    expect(plan.scoreRowsByStudent).toBe(rows);
    expect(plan.cascade).toEqual(expandCascade([test], all, rows));
  });

  it('overlayDrafts maps missing to no score and excused to excluded, without touching the input', () => {
    const rows = scores();
    const out = overlayDrafts(rows, [draft('s1', 'solo', 15, 'excused'), draft('s2', 'solo', 9, 'missing'), draft('gone', 'solo', 1)]);
    expect(out.get('s1').rows.find((r) => r.assessment_id === 'solo')).toMatchObject({ score: 15, status: 'excused', is_excluded: true });
    expect(out.get('s2').rows.find((r) => r.assessment_id === 'solo')).toMatchObject({ score: null, status: 'missing', is_excluded: false });
    expect(out.has('gone')).toBe(false);
    expect(rows.get('s1').rows.find((r) => r.assessment_id === 'solo').score).toBeNull();
  });
});
