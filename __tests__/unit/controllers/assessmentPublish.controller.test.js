const {
  expandCascade,
  countUngradedStudents,
  buildEmailTasks,
  topLevelLines,
  overlayDrafts,
  planPublish,
  publishDigestTasks,
  recipientAccess,
  recipientButtons,
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

// One row of the parent email: a released column with its own score; a column
// inside a category carries the category's name as `group`.
const line = (assessmentId, name, scoreLabel, pctLabel, extra = {}) => ({
  assessmentId, name, group: null, dateLabel: null, scoreLabel, pctLabel, isMissing: false, comment: null, ...extra,
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
      line('q1', 'Quiz 1', '18/20', '90%'),
      line('t1', 'Unit Test', '40/50', '80%'),
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

  it("labels each line with its assessment date, and leaves it out when the teacher set none", () => {
    const dated = { ...quiz, date: '2026-10-13' };
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', 18), scoreRow('t1', 40)])]);
    const [task] = buildEmailTasks(['q1', 't1'], [dated, test], scores);
    expect(task.lines.map((l) => l.dateLabel)).toEqual(['Tue, Oct 13', null]);
  });

  it('marks work flagged missing as Missing, at 0%', () => {
    const scores = new Map([student('s1', 'Alice', [{ ...scoreRow('q1', null), status: 'missing' }])]);
    const [task] = buildEmailTasks(['q1'], [quiz], scores);
    expect(task.lines).toEqual([line('q1', 'Quiz 1', 'Missing', '0%', { isMissing: true })]);
  });

  describe('a category', () => {
    const category = assessment({
      assessment_id: 'cat',
      name: 'Quizzes',
      is_parent: true,
      weight_points: 30,
      max_score: null,
    });
    const kid1 = assessment({ assessment_id: 'kid1', name: 'Quiz A', parent_assessment_id: 'cat', max_score: 10 });
    const kid2 = assessment({ assessment_id: 'kid2', name: 'Quiz B', parent_assessment_id: 'cat', max_score: 10 });

    it('lists each released column with its own score, labelled with the category', () => {
      const scores = new Map([
        student('s1', 'Alice', [scoreRow('kid1', 9.5), scoreRow('kid2', 7)]),
      ]);

      const [task] = buildEmailTasks(['cat', 'kid1', 'kid2'], [category, kid1, kid2], scores);

      // The scores parents asked about, not the category's running average (82.5%).
      expect(task.lines).toEqual([
        line('kid1', 'Quiz A', '9.5/10', '95%', { group: 'Quizzes' }),
        line('kid2', 'Quiz B', '7/10', '70%', { group: 'Quizzes' }),
      ]);
      // The audit still names the category alone (the 4 pm Missing alert reads it).
      expect(task.gradedAssessmentIds).toEqual(['cat']);
    });

    it("opens the category's first row with the category's own note", () => {
      const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 9), scoreRow('kid2', 7)])]);
      const all = [{ ...category, parent_comment: 'Retakes on Friday.' }, { ...kid1, parent_comment: 'Neat work.' }, kid2];
      const [task] = buildEmailTasks(['cat', 'kid1', 'kid2'], all, scores);
      expect(task.lines.map((l) => l.comment)).toEqual(['Retakes on Friday.\nNeat work.', null]);
    });

    it('lists only the released columns, never an older sibling', () => {
      const published = { ...kid1, is_published: true };
      const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 9), scoreRow('kid2', 7)])]);
      const [task] = buildEmailTasks(['cat'], [category, published, kid2], scores, { alsoListed: new Map([['cat', ['kid2']]]) });
      expect(task.lines).toEqual([line('kid2', 'Quiz B', '7/10', '70%', { group: 'Quizzes' })]);
      expect(task.gradedAssessmentIds).toEqual(['cat', 'kid2']);
    });

    it('sends nothing when the released column is blank for the student, even if an older sibling is graded', () => {
      const published = { ...kid1, is_published: true };
      const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 9), scoreRow('kid2', null)])]);
      expect(buildEmailTasks(['cat'], [category, published, kid2], scores, { alsoListed: new Map([['cat', ['kid2']]]) })).toEqual([]);
    });
  });

  it('produces no tasks when nothing published is graded', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('q1', null)])]);
    expect(buildEmailTasks(['q1'], [quiz], scores)).toEqual([]);
  });
});

// S2: a Classwork publish of one column under a category emails that column,
// labelled with its category, and the running grade counts what parents can see.
describe('topLevelLines + buildEmailTasks for a column under a category', () => {
  const category = assessment({ assessment_id: 'cat', name: 'Homework', is_parent: true, weight_points: 40, max_score: null });
  const kid1 = assessment({ assessment_id: 'kid1', name: 'Reading log 1', parent_assessment_id: 'cat', max_score: 10, is_published: true });
  const kid2 = assessment({ assessment_id: 'kid2', name: 'Reading log 2', parent_assessment_id: 'cat', max_score: 10, is_published: false });
  const solo = assessment({ assessment_id: 'solo', name: 'Unit Test', max_score: 50 });
  const all = [category, kid1, kid2, solo];

  it('maps a child to its category and keeps a top-level column as it is', () => {
    expect(topLevelLines(['kid1', 'solo', 'kid2'], all)).toEqual({
      lineIds: ['cat', 'solo'], alsoListed: new Map([['cat', ['kid1', 'kid2']]]),
    });
    expect(topLevelLines(['gone'], all)).toEqual({ lineIds: [], alsoListed: new Map() });
  });

  it('lists the released child with its own score, and names it in the audit ids', () => {
    const scores = new Map([student('s1', 'Alice', [scoreRow('kid1', 8), scoreRow('kid2', 2)])]);
    const { lineIds, alsoListed } = topLevelLines(['kid1'], all);
    const [task] = buildEmailTasks(lineIds, all, scores, { alsoListed });
    expect(task.lines).toEqual([line('kid1', 'Reading log 1', '8/10', '80%', { group: 'Homework' })]);
    expect(task.gradedAssessmentIds).toEqual(['cat', 'kid1']);
    // kid2 has a score but isn't published: it never enters the running grade.
    expect(task.runningGradeLabel).toMatch(/^80% /);
  });
});

// The gradebook's Publish (preview, send and the preview email): every column
// it releases is a row with its own score. A column inside a category
// published on its own, from the category window, used to produce no email at
// all ("notify 0 parents"), then only the category's running average.
describe('publishDigestTasks', () => {
  const category = assessment({ assessment_id: 'cat', name: 'Tests', is_parent: true, weight_points: 30, max_score: null });
  const unit1 = assessment({ assessment_id: 'u1', name: 'Unit Test 1', parent_assessment_id: 'cat', max_score: 10, is_published: true });
  const unit2 = assessment({ assessment_id: 'u2', name: 'Unit Test 2', parent_assessment_id: 'cat', max_score: 10 });
  const unit3 = assessment({ assessment_id: 'u3', name: 'Unit Test 3', parent_assessment_id: 'cat', max_score: 10 });
  const solo = assessment({ assessment_id: 'solo', name: 'Project', max_score: 50 });
  const all = [category, unit1, unit2, unit3, solo];
  const scores = new Map([
    student('s1', 'Alice', [scoreRow('u1', 8), scoreRow('u2', 6), scoreRow('u3', 0), scoreRow('solo', 40)]),
    student('s2', 'Bilal', [scoreRow('u1', 10), scoreRow('u2', 9)]),
  ]);

  it('emails a child published on its own with its own score, for every graded student', () => {
    const tasks = publishDigestTasks(['u2'], all, scores);
    expect(tasks.map((t) => t.studentName)).toEqual(['Alice', 'Bilal']);
    expect(tasks[0].lines).toEqual([line('u2', 'Unit Test 2', '6/10', '60%', { group: 'Tests' })]);
    expect(tasks[1].lines).toEqual([line('u2', 'Unit Test 2', '9/10', '90%', { group: 'Tests' })]);
    expect(tasks[0].gradedAssessmentIds).toEqual(['cat', 'u2']);
    // Unit Test 1 (published) and Unit Test 2 (being published) count; Unit Test 3 is graded but unpublished.
    expect(tasks[0].runningGradeLabel).toMatch(/^70% /);
  });

  it('lists the columns a category publishes with it, and a column on its own as itself', () => {
    const [alice] = publishDigestTasks(['cat', 'u2', 'u3', 'solo'], all, scores);
    // The audit names the category alone, as before (the 4 pm Missing alert reads it).
    expect(alice.gradedAssessmentIds).toEqual(['cat', 'solo']);
    // Unit Test 1 was published before: it is not new, so it is not listed.
    expect(alice.lines).toEqual([
      line('u2', 'Unit Test 2', '6/10', '60%', { group: 'Tests' }),
      line('u3', 'Unit Test 3', '0/10', '0%', { group: 'Tests' }),
      line('solo', 'Project', '40/50', '80%'),
    ]);
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
      ['Alice', [line('hw', 'Plant cell diagram', '8/10', '80%', { group: 'Homework' })]],
      ['Bilal', [line('hw', 'Plant cell diagram', 'Missing', '0%', { group: 'Homework', isMissing: true })]],
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
    expect(alice.lines).toEqual([line('t1', 'Unit Test', '40/50', '80%')]);
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

// Each guardian address gets its own email and its own buttons.
describe('recipientAccess + recipientButtons', () => {
  const env = { secret: process.env.JWT_SECRET, url: process.env.FRONTEND_URL };
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.FRONTEND_URL = 'https://schoolmule.test';
  });
  afterAll(() => {
    process.env.JWT_SECRET = env.secret;
    process.env.FRONTEND_URL = env.url;
  });

  const account = (email, extra = {}) => ({ email, user_id: `u-${email}`, role: 'PARENT', is_archived: false, linked: true, ...extra });
  const speak = { label: 'Speak to Sara Clarke about this', path: '/parent/messages?tab=conversations&ask=s1&askClass=c1' };

  it('signs a linked parent in on one tap, from both buttons', () => {
    const access = recipientAccess('sam@example.test', [account('sam@example.test')]);
    expect(access).toEqual({ kind: 'signIn', userId: 'u-sam@example.test' });
    const { portalUrl, speak: button } = recipientButtons({ access, address: 'sam@example.test', studentId: 's1', school: 'ALHAADIACADEMY', speak });
    const portal = new URL(portalUrl);
    expect(portal.pathname).toBe('/email-login');
    expect(portal.searchParams.get('next')).toBe('/parent/grades');
    expect(portal.hash.length).toBeGreaterThan(20);
    expect(new URL(button.url).searchParams.get('next')).toBe(speak.path);
    expect(button.label).toBe(speak.label);
  });

  it('asks an address with no account to create one, with the address filled in, and "Speak to" goes there too', () => {
    const access = recipientAccess('new.parent@example.test', [account('sam@example.test')]);
    expect(access).toEqual({ kind: 'signup' });
    const setupUrl = 'https://schoolmule.test/signup/alhaadiacademy/parent?email=new.parent%40example.test';
    expect(recipientButtons({ access, address: 'new.parent@example.test', studentId: 's1', school: 'ALHAADIACADEMY', speak })).toEqual({
      setupUrl,
      speak: { label: speak.label, url: setupUrl },
    });
    expect(recipientButtons({ access, address: 'new.parent@example.test', studentId: 's1', school: 'ALHAADIACADEMY', speak: null })).toEqual({ setupUrl, speak: null });
  });

  it('gives plain links to staff, archived, unlinked and ambiguous accounts', () => {
    const cases = [
      [account('t@example.test', { role: 'TEACHER' })],
      [account('t@example.test', { is_archived: true })],
      [account('t@example.test', { linked: false })],
      [account('t@example.test'), account('t@example.test', { user_id: 'u-other' })],
    ];
    for (const accounts of cases) expect(recipientAccess('t@example.test', accounts)).toEqual({ kind: 'plain' });
    const plain = recipientButtons({ access: { kind: 'plain' }, address: 't@example.test', studentId: 's1', school: 'ALHAADIACADEMY', speak });
    expect(plain).toEqual({
      portalUrl: 'https://schoolmule.test/parent/grades',
      speak: { label: speak.label, url: `https://schoolmule.test${speak.path}` },
    });
  });
});
