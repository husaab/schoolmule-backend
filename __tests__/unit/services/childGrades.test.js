// childGrades: the published-only grades a student (and a parent, through
// the lens) reads. The grade math is the shared engine's: buildAnalyticsMatrix
// is mocked to build the matrix from fixed rows with the REAL
// buildMatrixFromRows, so the options the service passes decide what is pruned.

jest.mock('../../../services/analyticsEngine', () => {
  const actual = jest.requireActual('../../../services/analyticsEngine');
  return { ...actual, buildAnalyticsMatrix: jest.fn() };
});

const db = require('../../__mocks__/config/database');
const engine = require('../../../services/analyticsEngine');
const q = require('../../../queries/childClassroom.queries');
const classworkQueries = require('../../../queries/classwork.queries');
const submissionQueries = require('../../../queries/classworkSubmission.queries');
const termQueries = require('../../../queries/term.queries');
const { buildChildGrades, newGradesFor } = require('../../../services/classroom/childGrades');

const actualEngine = jest.requireActual('../../../services/analyticsEngine');

const SCHOOL = 'ALHAADIACADEMY';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const TERM_ID = '11111111-1111-4111-8111-111111111111';
const AMAL = '7c0d1a52-3f7e-4c55-9d2e-0a4b6c8e1f20';
const BILAL = '7c0d1a52-3f7e-4c55-9d2e-0a4b6c8e1f21';
const MATH = 'aaaaaaaa-0000-4000-8000-000000000001';
const QUIZ1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const QUIZ2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const HOMEWORK = 'bbbbbbbb-0000-4000-8000-000000000003';
const SHEET1 = 'bbbbbbbb-0000-4000-8000-000000000004';
const ESSAY = 'bbbbbbbb-0000-4000-8000-000000000005';
const PROJECT = 'bbbbbbbb-0000-4000-8000-000000000006';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

const assessment = (id, name, extra = {}) => ({
  assessment_id: id, assessment_name: name, weight_percent: null, weight_points: 10, max_score: 10,
  is_parent: false, parent_assessment_id: null, assessment_date: '2026-10-01', sort_order: 0,
  is_published: true, parent_comment: null, published_at: daysAgo(2), ...extra,
});

// One analytics-matrix row per (student, assessment), as selectAnalyticsMatrix returns them.
const row = (studentId, a, score, status = 'graded') => ({
  class_id: MATH, class_grade: '5', subject: 'Math', teacher_name: 'Ziad Teacher', term_id: TERM_ID,
  student_id: studentId, student_name: studentId === AMAL ? 'Amal Haddad' : 'Bilal Karim', student_grade: '5',
  homeroom_teacher_id: null, ...a, score, status, is_excluded: status === 'excused',
});

const quiz1 = assessment(QUIZ1, 'Quiz 1', { parent_comment: 'Great work on fractions', published_at: daysAgo(3) });
const quiz2 = assessment(QUIZ2, 'Quiz 2', { is_published: false, published_at: null });

const classRow = (extra = {}) => ({
  class_id: MATH, subject: 'Math', grade: '5', teacher_name: 'Ziad Teacher', show_class_average: false,
  banner_key: null, banner_path: null, icon_key: null, color: null, ...extra,
});

let profile;
let classRows;
let matrixRows;
let itemRows;
let itemQueryArgs;
let missingRows;
let missingQueryArgs;

const req = (query = {}) => ({ query, user: { school: SCHOOL }, schoolYear: { schoolYearId: YEAR_ID } });

beforeEach(() => {
  profile = { student_id: AMAL, name: 'Amal Haddad', grade: '5', school: SCHOOL, school_year_id: YEAR_ID, is_archived: false };
  classRows = [classRow()];
  matrixRows = [row(AMAL, quiz1, 8), row(AMAL, quiz2, 3), row(BILAL, quiz1, 6), row(BILAL, quiz2, 10)];
  itemRows = [];
  itemQueryArgs = null;
  missingRows = [];
  missingQueryArgs = null;

  db.query.mockImplementation(async (sql, params) => {
    if (sql === q.selectChildProfile) return { rows: [profile] };
    if (sql === q.selectGradeClasses) return { rows: classRows };
    if (sql === classworkQueries.selectItemsForAssessments) { itemQueryArgs = params; return { rows: itemRows }; }
    if (sql === submissionQueries.selectMissingByClass) { missingQueryArgs = params; return { rows: missingRows }; }
    if (sql === termQueries.selectTermsBySchool) {
      return { rows: [{ term_id: TERM_ID, name: 'Term 1', is_active: true, start_date: '2026-09-01', end_date: '2026-12-20', school: SCHOOL }] };
    }
    throw new Error(`unexpected query: ${String(sql).slice(0, 80)}`);
  });
  engine.buildAnalyticsMatrix.mockImplementation(async (school, termId, eng, opts) =>
    actualEngine.buildMatrixFromRows(matrixRows, termId, eng, opts));
});

describe('buildChildGrades', () => {
  it('asks the engine for the published-only matrix, so an unpublished assessment never appears or counts', async () => {
    const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });

    expect(engine.buildAnalyticsMatrix).toHaveBeenCalledWith(SCHOOL, TERM_ID, 'graded_only', { publishedOnly: true });
    expect(grades).toMatchObject({ studentId: AMAL, usesMarks: true, termId: TERM_ID, terms: [{ termId: TERM_ID, name: 'Term 1', isActive: true }] });
    const [math] = grades.classes;
    expect(math.items.map((i) => i.title)).toEqual(['Quiz 1']);
    expect(math.finalPct).toBe(80); // 8/10 on the published quiz only; the unpublished 3/10 does not count
    expect(math.items[0]).toEqual({
      assessmentId: QUIZ1, itemId: null, classId: MATH, subject: 'Math', teacherName: 'Ziad Teacher',
      title: 'Quiz 1', kind: 'assessment', categoryName: null, score: 8, maxScore: 10, status: 'graded',
      publishedAt: quiz1.published_at.toISOString(), feedback: null, parentComment: 'Great work on fractions',
    });
    expect(math).toMatchObject({ gradedCount: 1, missingCount: 0, latestPublishedAt: quiz1.published_at.toISOString() });
    expect(JSON.stringify(grades)).not.toContain(BILAL);
  });

  it("takes each grade's kind from its classwork item, and its itemId only when the child may open the item", async () => {
    matrixRows = [row(AMAL, quiz1, 8), row(AMAL, assessment(QUIZ2, 'Quiz 2'), 6)];
    itemRows = [
      { assessment_id: QUIZ1, item_id: 'item-1', kind: 'quiz', visible: true },
      { assessment_id: QUIZ2, item_id: 'item-2', kind: 'assignment', visible: false },
    ];
    const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });
    const byId = Object.fromEntries(grades.classes[0].items.map((i) => [i.assessmentId, i]));
    expect([byId[QUIZ1].kind, byId[QUIZ1].itemId]).toEqual(['quiz', 'item-1']);
    expect([byId[QUIZ2].kind, byId[QUIZ2].itemId]).toEqual(['assignment', null]);
    expect(itemQueryArgs).toEqual([expect.arrayContaining([QUIZ1, QUIZ2]), AMAL]);
  });

  it('classAvg is null unless the class shows the class average', async () => {
    let grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });
    expect(grades.classes[0].classAvg).toBeNull();

    classRows = [classRow({ show_class_average: true })];
    grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });
    expect(grades.classes[0].classAvg).toBe(70); // (80 + 60) / 2, published work only
  });

  it('a JK or SK student does not use marks: no classes, and the engine is never asked', async () => {
    for (const grade of ['JK', 'SK']) {
      profile = { ...profile, grade };
      const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });
      expect(grades).toMatchObject({ studentId: AMAL, usesMarks: false, classes: [] });
    }
    expect(engine.buildAnalyticsMatrix).not.toHaveBeenCalled();
  });

  it("categoryName is the parent assessment's name; the category itself is not an item", async () => {
    const homework = assessment(HOMEWORK, 'Homework', { is_parent: true, max_score: null, published_at: null, is_published: false });
    const sheet = assessment(SHEET1, 'Worksheet 1', { parent_assessment_id: HOMEWORK, published_at: daysAgo(1) });
    matrixRows = [row(AMAL, homework, null), row(AMAL, sheet, 9), row(AMAL, quiz1, 8)];

    const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });

    const items = grades.classes[0].items;
    expect(items.map((i) => [i.title, i.categoryName])).toEqual([['Worksheet 1', 'Homework'], ['Quiz 1', null]]);
  });

  it('missing and excused items carry their status and no score; blank cells are not items', async () => {
    const essay = assessment(ESSAY, 'Essay', { published_at: daysAgo(4) });
    const project = assessment(PROJECT, 'Project', { published_at: daysAgo(5) });
    const blank = assessment(SHEET1, 'Worksheet 1', { published_at: daysAgo(6) });
    matrixRows = [row(AMAL, quiz1, 8), row(AMAL, essay, 7, 'missing'), row(AMAL, project, 9, 'excused'), row(AMAL, blank, null)];
    missingRows = [{ class_id: MATH, n: 1 }]; // the essay, by the work-status rule

    const [math] = (await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() })).classes;

    expect(math.items.map((i) => [i.title, i.status, i.score])).toEqual([
      ['Quiz 1', 'graded', 8], ['Essay', 'missing', null], ['Project', 'excused', null],
    ]);
    expect(math).toMatchObject({ gradedCount: 1, missingCount: 1 });
  });

  it('missingCount is the work-status count for the student (derived + confirmed), not just published missing cells', async () => {
    missingRows = [{ class_id: MATH, n: 3 }];

    const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });

    expect(grades.classes[0]).toMatchObject({ classId: MATH, missingCount: 3, gradedCount: 1 });
    expect(missingQueryArgs).toEqual([AMAL, SCHOOL, [MATH]]);
  });

  it("lists the student's classes with nothing graded yet, and drops a class the class list does not have (archived)", async () => {
    const SCIENCE = 'aaaaaaaa-0000-4000-8000-000000000002';
    classRows = [classRow(), classRow({ class_id: SCIENCE, subject: 'Science', teacher_name: 'Dina Teacher' })];
    matrixRows = [row(AMAL, quiz1, 8), { ...row(AMAL, quiz2, 5), class_id: 'aaaaaaaa-0000-4000-8000-00000000dead', subject: 'Old', is_published: true }];

    const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });

    expect(grades.classes.map((c) => [c.subject, c.finalPct, c.items.length])).toEqual([['Math', 80, 1], ['Science', null, 0]]);
    expect(grades.classes[1].identity.family).toBe('science');
  });

  it('no term: no classes and no engine call', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql === q.selectChildProfile) return { rows: [profile] };
      if (sql === termQueries.selectTermsBySchool) return { rows: [] };
      throw new Error('unexpected query');
    });
    const grades = await buildChildGrades({ studentId: AMAL, school: SCHOOL, req: req() });
    expect(grades).toEqual({ studentId: AMAL, usesMarks: true, termId: null, terms: [], classes: [] });
    expect(engine.buildAnalyticsMatrix).not.toHaveBeenCalled();
  });
});

describe('newGradesFor', () => {
  it('keeps grades published within sinceDays, newest first, at most limit', async () => {
    const recent = assessment(ESSAY, 'Essay', { published_at: daysAgo(1) });
    const old = assessment(PROJECT, 'Project', { published_at: daysAgo(20) });
    matrixRows = [row(AMAL, quiz1, 8), row(AMAL, recent, 7), row(AMAL, old, 9)];

    const items = await newGradesFor({ studentId: AMAL, school: SCHOOL, req: req() });
    expect(items.map((i) => i.title)).toEqual(['Essay', 'Quiz 1']);

    const one = await newGradesFor({ studentId: AMAL, school: SCHOOL, req: req(), limit: 1 });
    expect(one.map((i) => i.title)).toEqual(['Essay']);

    const twoDays = await newGradesFor({ studentId: AMAL, school: SCHOOL, req: req(), sinceDays: 2 });
    expect(twoDays.map((i) => i.title)).toEqual(['Essay']);
  });
});
