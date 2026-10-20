// Regrouping gradebook columns from Grades → Assessments & categories: move a
// column into a category, between categories or back out on its own, and turn
// a single assessment into a category. A column keeps its points wherever it
// goes, so the class stays at 100. Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const BASE = '/api/classroom';

describe('Integration: regrouping gradebook columns', () => {
  let pool, yearId, termId, sciId, mathId, amalId;
  let testsId, unit1Id, homeworkId, hw1Id, hw2Id, participatingId, quizzesId, quiz1Id, mathCategoryId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', 'TEACHER', true, true)`,
    [id, email, `${first} ${last}`, first, last],
  );
  const makeClass = async (subject, teacherId) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', '5', $1, 'Lead Name', $2, $3, 'Term 1', $4) RETURNING class_id`,
    [subject, teacherId, termId, yearId],
  )).rows[0].class_id;
  const assessment = async (classId, name, o = {}) => (await pool.query(
    `INSERT INTO assessments (class_id, name, parent_assessment_id, is_parent, weight_points, max_score, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING assessment_id`,
    [classId, name, o.parentId ?? null, o.isParent ?? false, o.weight ?? null, o.max ?? null, o.sort ?? 0],
  )).rows[0].assessment_id;
  const row = async (id) => (await pool.query(
    `SELECT assessment_id, name, parent_assessment_id, is_parent, weight_points::float AS w, max_score::float AS max, sort_order
     FROM assessments WHERE assessment_id = $1`, [id],
  )).rows[0];
  const topLevelTotal = async () => Number((await pool.query(
    `SELECT COALESCE(SUM(weight_points), 0)::float AS t FROM assessments WHERE class_id = $1 AND parent_assessment_id IS NULL`, [sciId],
  )).rows[0].t);
  const itemsOf = async (id) => (await pool.query(`SELECT kind FROM classwork_items WHERE assessment_id = $1`, [id])).rows;
  const scoreOf = async (id) => (await pool.query(
    `SELECT score::float AS score FROM student_assessments WHERE student_id = $1 AND assessment_id = $2`, [amalId, id],
  )).rows[0]?.score;

  const move = (id, categoryId, who = asTeacher, classId = sciId) =>
    authenticatedRequest('post', `${BASE}/classes/${classId}/assessments/${id}/move`, who).send({ categoryId });
  const makeCategory = (id, who = asTeacher) =>
    authenticatedRequest('post', `${BASE}/classes/${sciId}/assessments/${id}/make-category`, who).send({});

  beforeEach(async () => {
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher');
    sciId = await makeClass('Science', TEACHER_ID);
    mathId = await makeClass('Math', OTHER_TEACHER_ID);
    amalId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amal Haddad', '5', 'ALHAADIACADEMY', $1) RETURNING student_id`,
      [yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [sciId, amalId]);

    // Science totals 100: Tests 40 (one column), Homework 20 (two of 10),
    // Participating 10 (on its own), Quizzes 30 (one column).
    testsId = await assessment(sciId, 'Tests', { isParent: true, weight: 40, sort: 1 });
    unit1Id = await assessment(sciId, 'Unit 1 test', { parentId: testsId, weight: 40, max: 30, sort: 1 });
    homeworkId = await assessment(sciId, 'Homework', { isParent: true, weight: 20, sort: 2 });
    hw1Id = await assessment(sciId, 'Homework 1', { parentId: homeworkId, weight: 10, max: 10, sort: 1 });
    hw2Id = await assessment(sciId, 'Homework 2', { parentId: homeworkId, weight: 10, max: 10, sort: 2 });
    participatingId = await assessment(sciId, 'Participating', { weight: 10, max: 10, sort: 3 });
    quizzesId = await assessment(sciId, 'Quizzes', { isParent: true, weight: 30, sort: 4 });
    quiz1Id = await assessment(sciId, 'Quiz 1', { parentId: quizzesId, weight: 30, max: 20, sort: 1 });
    mathCategoryId = await assessment(mathId, 'Math tests', { isParent: true, weight: 100, sort: 1 });
    await pool.query(
      `INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, 8), ($1, $3, 9)`,
      [amalId, participatingId, hw2Id],
    );
  });

  it('moves a single assessment into a category with its points: the category grows by them, the class stays at 100', async () => {
    const res = await move(participatingId, homeworkId);
    expect(res.status).toBe(200);
    expect(await row(participatingId)).toMatchObject({ parent_assessment_id: homeworkId, w: 10, max: 10, sort_order: 3 });
    expect((await row(homeworkId)).w).toBe(30);
    expect(await topLevelTotal()).toBe(100);
    // Its scores and its Classwork row come along (same id).
    expect(await scoreOf(participatingId)).toBe(8);
    expect(await itemsOf(participatingId)).toEqual([{ kind: 'assessment' }]);
    // The answer is the class's whole list, so every screen can redraw from it.
    const moved = res.body.data.assessments.find((a) => a.assessmentId === participatingId);
    expect(moved).toMatchObject({ parentAssessmentId: homeworkId, weightPoints: 10, isParent: false });
    expect(res.body.data.assessments.find((a) => a.assessmentId === homeworkId).weightPoints).toBe(30);
  });

  it('takes an item out of its category: it counts on its own with its points and the category shrinks by them', async () => {
    const res = await move(hw2Id, null);
    expect(res.status).toBe(200);
    expect(await row(hw2Id)).toMatchObject({ parent_assessment_id: null, w: 10 });
    expect((await row(homeworkId)).w).toBe(10);
    expect(await topLevelTotal()).toBe(100);
    expect(await scoreOf(hw2Id)).toBe(9);
  });

  it('removes a category its last item leaves; the item takes its place in the list', async () => {
    const res = await move(unit1Id, null);
    expect(res.status).toBe(200);
    expect(await row(testsId)).toBeUndefined();
    expect(await row(unit1Id)).toMatchObject({ parent_assessment_id: null, w: 40, sort_order: 1 });
    expect(await topLevelTotal()).toBe(100);
    expect(res.body.data.assessments.some((a) => a.assessmentId === testsId)).toBe(false);
  });

  it('moves an item between categories: one gives up its points, the other takes them on', async () => {
    const res = await move(hw1Id, quizzesId);
    expect(res.status).toBe(200);
    expect(await row(hw1Id)).toMatchObject({ parent_assessment_id: quizzesId, w: 10, sort_order: 2 });
    expect((await row(homeworkId)).w).toBe(10);
    expect((await row(quizzesId)).w).toBe(40);
    expect(await topLevelTotal()).toBe(100);
  });

  it('moving an item to where it already is changes nothing', async () => {
    expect((await move(hw1Id, homeworkId)).status).toBe(200);
    expect((await move(participatingId, null)).status).toBe(200);
    expect((await row(homeworkId)).w).toBe(20);
    expect(await row(participatingId)).toMatchObject({ parent_assessment_id: null, w: 10 });
  });

  it('turns a single assessment into a category that holds it: same name, points and place; scores and its Classwork row kept', async () => {
    const res = await makeCategory(participatingId);
    expect(res.status).toBe(200);
    const { categoryId } = res.body.data;
    expect(await row(categoryId)).toMatchObject({ name: 'Participating', is_parent: true, w: 10, max: null, parent_assessment_id: null, sort_order: 3 });
    expect(await row(participatingId)).toMatchObject({ parent_assessment_id: categoryId, w: 10, max: 10, is_parent: false });
    expect(await topLevelTotal()).toBe(100);
    expect(await scoreOf(participatingId)).toBe(8);
    expect(await itemsOf(participatingId)).toEqual([{ kind: 'assessment' }]);
    expect(await itemsOf(categoryId)).toEqual([]);
    expect(res.body.data.assessments.find((a) => a.assessmentId === categoryId)).toMatchObject({ isParent: true, weightPoints: 10 });
  });

  it('refuses a category as the thing moved, a target that is not one of this class\'s categories, and items inside categories becoming one', async () => {
    expect((await move(homeworkId, quizzesId)).status).toBe(400);
    expect((await move(participatingId, unit1Id)).status).toBe(400);
    expect((await move(participatingId, mathCategoryId)).status).toBe(400);
    expect((await move(participatingId, 'not-a-uuid')).status).toBe(400);
    expect((await makeCategory(hw1Id)).status).toBe(400);
    expect((await makeCategory(homeworkId)).status).toBe(400);
    // Nothing changed.
    expect(await topLevelTotal()).toBe(100);
    expect(await row(participatingId)).toMatchObject({ parent_assessment_id: null, w: 10 });
  });

  it("is the class's teachers' to do: another teacher is refused, and a column of another class is not found", async () => {
    expect((await move(participatingId, homeworkId, asOtherTeacher)).status).toBe(403);
    expect((await makeCategory(participatingId, asOtherTeacher)).status).toBe(403);
    expect((await move(mathCategoryId, null)).status).toBe(404);
    expect(await row(participatingId)).toMatchObject({ parent_assessment_id: null });
  });
});
