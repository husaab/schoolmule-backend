const {
  expandCascade,
  countUngradedStudents,
  buildEmailTasks,
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

  it('treats an excluded student as ungraded for warning purposes', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', 15, true)])]);
    expect(countUngradedStudents([quiz], [quiz], scores)[0].ungradedStudentCount).toBe(1);
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
