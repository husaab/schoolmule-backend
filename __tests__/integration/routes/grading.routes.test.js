// Grading turned-in work (spec D3, D17): drafts on the submission, Publish per
// student, Mark missing, Excuse, feedback, the gradebook grid's draft/live
// branch, the existing Publish flow on a turn-in column, the grid overlay and
// the To review counts. A draft never reaches student_assessments, so no
// student, parent or report card can see it. Synthetic identities only
// (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const engine = require('../../../services/analyticsEngine');
const { getResend } = require('../../../utils/emailUtils');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const PARENT_A_ID = '550e8400-e29b-41d4-a716-446655440004';
const PARENT_B_ID = '550e8400-e29b-41d4-a716-446655440005';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const BILAL_USER_ID = '550e8400-e29b-41d4-a716-446655440011';
const DALIA_USER_ID = '550e8400-e29b-41d4-a716-446655440012';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office.admin@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asParentA = { userId: PARENT_A_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asParentB = { userId: PARENT_B_ID, username: 'Rania Karim', email: 'rania.karim@example.com', role: 'PARENT' };
const student = (userId, username, email) => ({ userId, username, email, role: 'STUDENT', roles: ['STUDENT'] });
const asAmal = student(AMAL_USER_ID, 'Amal Haddad', 'amal.haddad@example.com');
const asBilal = student(BILAL_USER_ID, 'Bilal Karim', 'bilal.karim@example.com');
const asDalia = student(DALIA_USER_ID, 'Dalia Nassar', 'dalia.nassar@example.com');

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();

describe('Integration: grading and per-student Publish', () => {
  let pool, yearId, termId, sciId, mathId;
  let amalId, bilalId, daliaId, outsiderId, homeworkId, item, itemUrl, columnId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = async (subject, teacherId) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', '5', $1, 'Lead Name', $2, $3, 'Term 1', $4) RETURNING class_id`,
    [subject, teacherId, termId, yearId],
  )).rows[0].class_id;
  const makeStudent = async (name, classId, loginId) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2) RETURNING student_id`,
      [name, yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    if (loginId) {
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [loginId, id, yearId]);
    }
    return id;
  };
  const assessment = async (classId, name, o = {}) => (await pool.query(
    `INSERT INTO assessments (class_id, name, parent_assessment_id, is_parent, weight_points, max_score)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING assessment_id`,
    [classId, name, o.parentId ?? null, o.isParent ?? false, o.weight ?? null, o.max ?? null],
  )).rows[0].assessment_id;

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const get = (url, who = asTeacher, status = 200) => expectStatus(authenticatedRequest('get', url, who), status);
  const post = (url, body, who = asTeacher, status = 200) => expectStatus(authenticatedRequest('post', url, who).send(body), status);
  const patch = (studentId, body, who = asTeacher, status = 200) =>
    expectStatus(authenticatedRequest('patch', `${itemUrl}/submissions/${studentId}`, who).send(body), status);
  const publish = (studentIds, status = 200) => post(`${itemUrl}/publish`, { studentIds }, asTeacher, status);
  const createItem = async (body) => (await post(`/api/classroom/classes/${sciId}/items`, body, asTeacher, 201)).data;
  const turnIn = (itemId, who) => post(`/api/student/items/${itemId}/turn-in`, undefined, who);

  const gradebook = async (assessmentId = columnId) => (await pool.query(
    `SELECT student_id, score::float AS score, status FROM student_assessments WHERE assessment_id = $1 ORDER BY student_id`,
    [assessmentId],
  )).rows;
  const cell = async (studentId, assessmentId = columnId) => (await gradebook(assessmentId)).find((r) => r.student_id === studentId);
  const submission = async (studentId, itemId = item.itemId) => (await pool.query(
    `SELECT draft_score::float AS draft_score, draft_status, feedback, published_at FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`,
    [itemId, studentId],
  )).rows[0];
  const isPublished = async (assessmentId = columnId) => (await pool.query(
    `SELECT is_published FROM assessments WHERE assessment_id = $1`, [assessmentId],
  )).rows[0].is_published;
  // Fresh reads: the grade matrices are cached per school, and a draft must
  // not show even when nothing is cached.
  const studentGrade = async (who, assessmentId = columnId) => {
    engine.invalidateCache();
    const { data } = await get('/api/student/grades', who);
    return data.classes.flatMap((c) => c.items).find((i) => i.assessmentId === assessmentId) ?? null;
  };
  const parentGrades = async (who, studentId) => {
    engine.invalidateCache();
    return (await get(`/api/parent-portal/students/${studentId}/grades`, who)).data;
  };
  const parentScore = (grades, assessmentId = columnId) => (grades.classes || [])
    .flatMap((c) => c.assessmentScores || c.assessments || [])
    .find((a) => a.assessmentId === assessmentId) ?? null;
  const studentItem = async (who, itemId = item.itemId) => (await get(`/api/student/items/${itemId}`, who)).data;
  const sent = () => getResend().emails.send.mock.calls.map(([msg]) => msg);

  beforeEach(async () => {
    supabase._reset();
    getResend().emails.send.mockClear();
    engine.invalidateCache();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;

    await user(ADMIN_ID, 'office.admin@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(PARENT_A_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(PARENT_B_ID, 'rania.karim@example.com', 'Rania', 'Karim', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await user(BILAL_USER_ID, 'bilal.karim@example.com', 'Bilal', 'Karim', 'STUDENT');
    await user(DALIA_USER_ID, 'dalia.nassar@example.com', 'Dalia', 'Nassar', 'STUDENT');
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    sciId = await makeClass('Science', TEACHER_ID);
    mathId = await makeClass('Math', OTHER_TEACHER_ID);
    amalId = await makeStudent('Amal Haddad', sciId, AMAL_USER_ID);
    bilalId = await makeStudent('Bilal Karim', sciId, BILAL_USER_ID);
    daliaId = await makeStudent('Dalia Nassar', sciId, DALIA_USER_ID);
    outsiderId = await makeStudent('Omar Saleh', mathId, null);
    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school) VALUES
       ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY'),
       ($3, $4, 'Rania Karim', 'rania.karim@example.com', 'Mother', 'ALHAADIACADEMY')`,
      [PARENT_A_ID, amalId, PARENT_B_ID, bilalId],
    );

    homeworkId = await assessment(sciId, 'Homework', { isParent: true, weight: 40 });
    item = await createItem({
      kind: 'assignment', title: 'Plant cell diagram', instructions: 'Label six parts.', submissionMode: 'done',
      dueAt: inDays(2), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 },
    });
    itemUrl = `/api/classroom/items/${item.itemId}`;
    columnId = item.gradebook.assessmentId;
    for (const who of [asAmal, asBilal, asDalia]) await turnIn(item.itemId, who);
  });

  it("PATCH draftScore stores a draft; student_assessments has no row; the parent's grades and the student's grades are unchanged", async () => {
    const parentBefore = await parentGrades(asParentA, amalId);
    const studentBefore = (await get('/api/student/grades', asAmal)).data;

    const { data } = await patch(amalId, { draftScore: 8 });
    expect(data.live).toBe(false);
    expect(data.row).toMatchObject({
      studentId: amalId, name: 'Amal Haddad', status: 'turned_in', isLate: false, draftScore: 8, draftStatus: 'graded',
      publishedScore: null, publishedStatus: null, publishedAt: null, feedback: null, needsPublish: true, hasThread: false,
      label: 'Graded · draft',
    });
    expect(data.row.turnedInAt).toEqual(expect.any(String));
    expect(await gradebook()).toEqual([]);
    expect(await submission(amalId)).toMatchObject({ draft_score: 8, draft_status: 'graded', published_at: null });
    expect(await isPublished()).toBe(false);

    expect(await parentGrades(asParentA, amalId)).toEqual(parentBefore);
    engine.invalidateCache();
    expect((await get('/api/student/grades', asAmal)).data).toEqual(studentBefore);
    expect((await studentItem(asAmal)).grade).toBeNull();
    expect((await studentItem(asAmal)).submission.status).toBe('turned_in');

    // The list: counts and labels.
    const list = (await get(`${itemUrl}/submissions`)).data;
    expect(list.item).toMatchObject({ itemId: item.itemId, kind: 'assignment', title: 'Plant cell diagram', maxScore: 10, categoryName: 'Homework' });
    expect(list.isAssessmentPublished).toBe(false);
    expect(list.counts).toEqual({ all: 3, turnedIn: 3, toGrade: 2, missing: 0, drafts: 1, published: 0 });
    expect(list.students.map((s) => [s.name, s.label])).toEqual([
      ['Amal Haddad', 'Graded · draft'], ['Bilal Karim', 'Turned in'], ['Dalia Nassar', 'Turned in'],
    ]);
    const one = (await get(`${itemUrl}/submissions/${bilalId}`)).data;
    expect(one).toMatchObject({ row: { studentId: bilalId, label: 'Turned in' }, textAnswer: null, files: [], quiz: null, thread: null });

    // Validation: out of range, too long, not on the roster, nothing sent.
    await patch(amalId, { draftScore: 11 }, asTeacher, 400);
    await patch(amalId, { draftScore: -1 }, asTeacher, 400);
    await patch(amalId, { draftStatus: 'late' }, asTeacher, 400);
    await patch(amalId, { feedback: 'x'.repeat(5001) }, asTeacher, 400);
    await patch(amalId, {}, asTeacher, 400);
    await patch(outsiderId, { draftScore: 5 }, asTeacher, 404);
    expect(await gradebook()).toEqual([]);
  });

  it("publish [A] writes A's score, flips is_published, and B's draft stays out of student_assessments; B's parent sees nothing", async () => {
    await patch(amalId, { draftScore: 8 });
    await patch(bilalId, { draftScore: 6 });
    const parentBBefore = await parentGrades(asParentB, bilalId);

    const { data } = await publish([amalId]);
    expect(data).toMatchObject({ publishedStudentIds: [amalId], skipped: [], assessmentPublished: true });
    expect(await gradebook()).toEqual([{ student_id: amalId, score: 8, status: 'graded' }]);
    expect(await isPublished()).toBe(true);
    expect((await submission(amalId)).published_at).not.toBeNull();
    expect(await submission(bilalId)).toMatchObject({ draft_score: 6, published_at: null });

    // Amal and her parent see the grade; Bilal and his parent see nothing.
    expect(await studentGrade(asAmal)).toMatchObject({ score: 8, status: 'graded', kind: 'assignment', itemId: item.itemId });
    expect((await studentItem(asAmal)).grade).toMatchObject({ score: 8, maxScore: 10, status: 'graded' });
    expect((await studentItem(asAmal)).submission.status).toBe('graded');
    expect(Number(parentScore(await parentGrades(asParentA, amalId)).score)).toBe(8);
    expect(await studentGrade(asBilal)).toBeNull();
    expect((await studentItem(asBilal)).grade).toBeNull();
    const parentB = await parentGrades(asParentB, bilalId);
    expect(parentScore(parentB)?.score ?? null).toBeNull();
    expect(JSON.stringify(parentB)).not.toContain('"score":6');
    expect(parentBBefore).toBeDefined();

    // The list now: Amal published, Bilal still a draft.
    const list = (await get(`${itemUrl}/submissions`)).data;
    expect(list.isAssessmentPublished).toBe(true);
    expect(list.counts).toMatchObject({ drafts: 1, published: 1, toGrade: 1 });
    const amal = list.students.find((s) => s.studentId === amalId);
    expect(amal).toMatchObject({ label: 'Published', publishedScore: 8, publishedStatus: 'graded', needsPublish: false });
    expect(amal.publishedAt).toEqual(expect.any(String));
  });

  it("after the first publish, PATCH B's draft writes live (live: true)", async () => {
    await patch(amalId, { draftScore: 8 });
    await publish([amalId]);

    const { data } = await patch(bilalId, { draftScore: 7 });
    expect(data.live).toBe(true);
    expect(data.row).toMatchObject({ label: 'Published', publishedScore: 7, needsPublish: false, draftScore: 7 });
    expect(await cell(bilalId)).toEqual({ student_id: bilalId, score: 7, status: 'graded' });
    expect((await submission(bilalId)).published_at).not.toBeNull();
    expect(await studentGrade(asBilal)).toMatchObject({ score: 7 });

    // A status change on the live cell keeps the score the student sees.
    await patch(bilalId, { draftStatus: 'excused' });
    expect(await cell(bilalId)).toEqual({ student_id: bilalId, score: 7, status: 'excused' });
  });

  it('grid upsert on the unpublished column returns drafts and writes no student_assessments row', async () => {
    const testId = await assessment(sciId, 'Unit test', { weight: 60, max: 50 });
    const res = await post(`/api/studentAssessments/classes/${sciId}/scores`, {
      scores: [
        { studentId: amalId, assessmentId: columnId, score: 9 },
        { studentId: bilalId, assessmentId: columnId, score: 4, status: 'missing' },
        { studentId: amalId, assessmentId: testId, score: 40 },
      ],
    });
    expect(res.data).toEqual([{ student_id: amalId, assessment_id: testId, score: '40.00', status: 'graded' }]);
    expect(res.drafts).toEqual([
      { student_id: amalId, assessment_id: columnId, draft_score: '9.00', draft_status: 'graded' },
      { student_id: bilalId, assessment_id: columnId, draft_score: null, draft_status: 'missing' },
    ]);
    expect(await gradebook()).toEqual([]);
    expect(await submission(amalId)).toMatchObject({ draft_score: 9, published_at: null });

    // The grid's status menu takes the same branch; clearing a draft leaves no draft.
    const status = await expectStatus(authenticatedRequest('patch', `/api/studentAssessments/classes/${sciId}/status`, asTeacher)
      .send({ studentId: daliaId, assessmentId: columnId, status: 'excused' }), 200);
    expect(status.data).toEqual([]);
    expect(status.drafts).toEqual([{ student_id: daliaId, assessment_id: columnId, draft_score: null, draft_status: 'excused' }]);
    const cleared = await post(`/api/studentAssessments/classes/${sciId}/scores`, { scores: [{ studentId: amalId, assessmentId: columnId, score: null }] });
    expect(cleared.drafts).toEqual([{ student_id: amalId, assessment_id: columnId, draft_score: null, draft_status: null }]);
    expect(await gradebook()).toEqual([]);

    // The grid's GET still reads the gradebook only.
    const matrix = await get(`/api/studentAssessments/classes/${sciId}/scores`);
    expect(matrix.data.filter((r) => r.assessment_id === columnId).every((r) => r.score === null && r.status === 'graded')).toBe(true);
  });

  it('grid upsert after publish writes student_assessments and syncs the submission', async () => {
    await patch(amalId, { draftScore: 8 });
    await publish([amalId]);

    const res = await post(`/api/studentAssessments/classes/${sciId}/scores`, {
      scores: [{ studentId: daliaId, assessmentId: columnId, score: 5 }, { studentId: amalId, assessmentId: columnId, score: 9 }],
    });
    expect(res.drafts).toEqual([]);
    expect(res.data).toHaveLength(2);
    expect(await cell(daliaId)).toEqual({ student_id: daliaId, score: 5, status: 'graded' });
    expect(await cell(amalId)).toEqual({ student_id: amalId, score: 9, status: 'graded' });
    expect(await submission(daliaId)).toMatchObject({ draft_score: 5, draft_status: 'graded' });
    expect((await submission(daliaId)).published_at).not.toBeNull();
    expect(await submission(amalId)).toMatchObject({ draft_score: 9 });
    expect(await studentGrade(asDalia)).toMatchObject({ score: 5 });

    // The status menu goes live too, and the submission follows.
    const status = await expectStatus(authenticatedRequest('patch', `/api/studentAssessments/classes/${sciId}/status`, asTeacher)
      .send({ studentId: daliaId, assessmentId: columnId, status: 'missing' }), 200);
    expect(status.data).toEqual([{ student_id: daliaId, assessment_id: columnId, score: null, status: 'missing' }]);
    expect(await submission(daliaId)).toMatchObject({ draft_score: null, draft_status: 'missing' });
    const list = (await get(`${itemUrl}/submissions`)).data;
    expect(list.students.find((s) => s.studentId === daliaId)).toMatchObject({ label: 'Missing', needsPublish: false });
  });

  it("mark-missing writes status missing and the student's status reads Missing", async () => {
    await patch(daliaId, { draftScore: 6 });
    const { data } = await post(`${itemUrl}/mark-missing`, { studentIds: [daliaId, outsiderId] });
    expect(data).toMatchObject({
      publishedStudentIds: [daliaId], assessmentPublished: true, updatedStudentIds: [daliaId],
      skipped: [{ studentId: outsiderId, reason: 'not_in_audience' }],
    });
    expect(await gradebook()).toEqual([{ student_id: daliaId, score: null, status: 'missing' }]);
    expect(await submission(daliaId)).toMatchObject({ draft_score: null, draft_status: 'missing' });
    const work = await studentItem(asDalia);
    expect(work.submission.status).toBe('missing');
    expect(work.grade).toMatchObject({ score: null, status: 'missing' });
    expect((await get(`${itemUrl}/submissions`)).data.students.find((s) => s.studentId === daliaId).label).toBe('Missing');

    // An item with no gradebook column can't take a Missing.
    const loose = await createItem({ kind: 'assignment', title: 'Reading log', submissionMode: 'done', dueAt: inDays(3) });
    const refused = await post(`/api/classroom/items/${loose.itemId}/mark-missing`, { studentIds: [daliaId] }, asTeacher, 400);
    expect(refused.message).toBe('Missing needs a gradebook column.');
    await post(`${itemUrl}/mark-missing`, { studentIds: [] }, asTeacher, 400);
    await post(`${itemUrl}/mark-missing`, { studentIds: ['nope'] }, asTeacher, 400);
  });

  it('excuse then un-excuse', async () => {
    await patch(bilalId, { draftScore: 6 });
    let { data } = await post(`${itemUrl}/excuse`, { studentIds: [bilalId], excused: true });
    expect(data).toMatchObject({ publishedStudentIds: [bilalId], assessmentPublished: true, updatedStudentIds: [bilalId] });
    expect(await gradebook()).toEqual([{ student_id: bilalId, score: 6, status: 'excused' }]);
    let work = await studentItem(asBilal);
    expect(work.submission.status).toBe('excused');
    expect(work.grade).toMatchObject({ score: null, status: 'excused' });

    ({ data } = await post(`${itemUrl}/excuse`, { studentIds: [bilalId, daliaId], excused: false }));
    expect(data).toMatchObject({
      publishedStudentIds: [bilalId], updatedStudentIds: [bilalId], skipped: [{ studentId: daliaId, reason: 'no_draft' }],
    });
    expect(await gradebook()).toEqual([{ student_id: bilalId, score: 6, status: 'graded' }]);
    work = await studentItem(asBilal);
    expect(work.grade).toMatchObject({ score: 6, status: 'graded' });

    // On an unpublished column, an un-excuse of a draft excuse stays a draft.
    const quizCol = await createItem({
      kind: 'assignment', title: 'Lab sheet', submissionMode: 'done', dueAt: inDays(4), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 5 },
    });
    await expectStatus(authenticatedRequest('patch', `/api/studentAssessments/classes/${sciId}/status`, asTeacher)
      .send({ studentId: daliaId, assessmentId: quizCol.gradebook.assessmentId, status: 'excused' }), 200);
    ({ data } = await post(`/api/classroom/items/${quizCol.itemId}/excuse`, { studentIds: [daliaId], excused: false }));
    expect(data).toMatchObject({ publishedStudentIds: [], updatedStudentIds: [daliaId], assessmentPublished: false });
    expect(await gradebook(quizCol.gradebook.assessmentId)).toEqual([]);
    expect(await isPublished(quizCol.gradebook.assessmentId)).toBe(false);
    expect(await submission(daliaId, quizCol.itemId)).toMatchObject({ draft_score: null, draft_status: null });
    await post(`${itemUrl}/excuse`, { studentIds: [bilalId] }, asTeacher, 400);
  });

  it("publish 'graded' publishes every student with a draft and skips the rest with no_draft", async () => {
    await patch(amalId, { draftScore: 8 });
    await patch(bilalId, { draftScore: 6, feedback: 'Check your labels.' });
    await patch(daliaId, { feedback: 'Neat work.' }); // feedback alone is not a grade to publish

    const { data } = await publish('graded');
    expect(data.publishedStudentIds.sort()).toEqual([amalId, bilalId].sort());
    expect(data.skipped).toEqual([{ studentId: daliaId, reason: 'no_draft' }]);
    expect(data.assessmentPublished).toBe(true);
    expect(await gradebook()).toEqual(
      [{ student_id: amalId, score: 8, status: 'graded' }, { student_id: bilalId, score: 6, status: 'graded' }]
        .sort((x, y) => x.student_id.localeCompare(y.student_id)),
    );
    // Nothing pending now: a second 'graded' publishes no one.
    const again = (await publish('graded')).data;
    expect(again.publishedStudentIds).toEqual([]);
    expect(again.assessmentPublished).toBe(false);

    // Explicit ids: a student of another class is not in the audience; Amal
    // is already published with nothing changed (fix round 1, M3).
    const explicit = (await publish([amalId, outsiderId])).data;
    expect(explicit.publishedStudentIds).toEqual([]);
    expect(explicit.skipped).toEqual([{ studentId: amalId, reason: 'unchanged' }, { studentId: outsiderId, reason: 'not_in_audience' }]);
    await publish('everyone', 400);
    await publish([], 400);
  });

  it('republishing after a regrade updates the stored score', async () => {
    await patch(amalId, { draftScore: 8 });
    await publish([amalId]);

    // Unpublished in the gradebook, the grading view drafts again, and the
    // graded work needs a Publish to show.
    await post(`/api/assessment-publications/classes/${sciId}/unpublish`, { assessmentIds: [columnId] });
    const unpublishedList = (await get(`${itemUrl}/submissions`)).data;
    expect(unpublishedList.isAssessmentPublished).toBe(false);
    expect(unpublishedList.students.find((s) => s.studentId === amalId)).toMatchObject({
      needsPublish: true, label: 'Graded · draft', publishedAt: null,
    });
    expect(unpublishedList.counts).toMatchObject({ drafts: 1, published: 0 });
    const { data } = await patch(amalId, { draftScore: 9 });
    expect(data.live).toBe(false);
    expect(data.row).toMatchObject({ label: 'Graded · draft', needsPublish: true, draftScore: 9 });
    expect(await cell(amalId)).toEqual({ student_id: amalId, score: 8, status: 'graded' });
    expect(await studentGrade(asAmal)).toBeNull();

    const published = (await publish([amalId])).data;
    expect(published).toMatchObject({ publishedStudentIds: [amalId], assessmentPublished: true });
    expect(await cell(amalId)).toEqual({ student_id: amalId, score: 9, status: 'graded' });
    expect(await studentGrade(asAmal)).toMatchObject({ score: 9 });

    // Clearing the cell while unpublished is an explicit clear on the next Publish.
    await post(`/api/assessment-publications/classes/${sciId}/unpublish`, { assessmentIds: [columnId] });
    await patch(amalId, { draftScore: null });
    expect(await submission(amalId)).toMatchObject({ draft_score: null, draft_status: 'graded', published_at: null });
    await publish('graded');
    expect(await cell(amalId)).toEqual({ student_id: amalId, score: null, status: 'graded' });
  });

  it('feedback is hidden from the student until published, then shown', async () => {
    await patch(amalId, { draftScore: 8, feedback: '  Great labelling.  ' });
    expect(await submission(amalId)).toMatchObject({ feedback: 'Great labelling.' });
    expect((await studentItem(asAmal)).grade).toBeNull();
    expect(await studentGrade(asAmal)).toBeNull();

    await publish([amalId]);
    expect((await studentItem(asAmal)).grade).toMatchObject({ score: 8, feedback: 'Great labelling.' });
    expect(await studentGrade(asAmal)).toMatchObject({ score: 8, feedback: 'Great labelling.' });

    // Bilal's feedback on the now-published column waits for Bilal's own publish.
    await patch(bilalId, { feedback: 'Label the nucleus.' });
    expect((await studentItem(asBilal)).grade).toBeNull();
    await patch(bilalId, { draftScore: 7 }); // live: Bilal is published with this save
    expect((await studentItem(asBilal)).grade).toMatchObject({ score: 7, feedback: 'Label the nucleus.' });

    // An item with no gradebook column: feedback only, published the same way.
    const loose = await createItem({ kind: 'assignment', title: 'Reading log', submissionMode: 'done', dueAt: inDays(3) });
    await turnIn(loose.itemId, asDalia);
    const looseUrl = `/api/classroom/items/${loose.itemId}`;
    await expectStatus(authenticatedRequest('patch', `${looseUrl}/submissions/${daliaId}`, asTeacher).send({ draftScore: 5 }), 400);
    const saved = await expectStatus(authenticatedRequest('patch', `${looseUrl}/submissions/${daliaId}`, asTeacher).send({ feedback: 'Lovely summary.' }), 200);
    expect(saved.data).toMatchObject({ live: false, row: { needsPublish: true, feedback: 'Lovely summary.' } });
    expect((await studentItem(asDalia, loose.itemId)).grade).toBeNull();
    const out = (await post(`${looseUrl}/publish`, { studentIds: 'graded' })).data;
    expect(out).toMatchObject({ publishedStudentIds: [daliaId], assessmentPublished: false });
    expect((await studentItem(asDalia, loose.itemId)).grade).toMatchObject({ score: null, maxScore: null, feedback: 'Lovely summary.' });
    const edited = await expectStatus(authenticatedRequest('patch', `${looseUrl}/submissions/${daliaId}`, asTeacher).send({ feedback: 'Lovely summary!' }), 200);
    expect(edited.data.live).toBe(true);
    expect((await studentItem(asDalia, loose.itemId)).grade.feedback).toBe('Lovely summary!');
  });

  it('the existing publish flow on the turn-in column publishes its drafts and still sends the parent digest, as for a plain assessment', async () => {
    const testId = await assessment(sciId, 'Unit test', { weight: 60, max: 50 });
    await post(`/api/studentAssessments/classes/${sciId}/scores`, { scores: [{ studentId: amalId, assessmentId: testId, score: 40 }] });
    await patch(amalId, { draftScore: 8 });
    await patch(bilalId, { draftScore: 6 });

    // The preview counts the drafts that Publish will copy.
    const preview = (await post(`/api/assessment-publications/classes/${sciId}/preview`, { assessmentIds: [homeworkId, testId] })).data;
    expect(preview.publishAssessmentIds.sort()).toEqual([homeworkId, testId, columnId].sort());
    expect(preview.cascadedChildIds).toEqual([columnId]);
    expect(preview.studentCount).toBe(2);

    const res = await expectStatus(authenticatedRequest('post', `/api/assessment-publications/classes/${sciId}/publish`, asTeacher)
      .send({ assessmentIds: [homeworkId, testId] }), 201);
    expect(res.data.classworkPublished).toEqual([{ assessmentId: columnId, itemId: item.itemId, studentCount: 2 }]);
    expect(await gradebook()).toEqual(
      [{ student_id: amalId, score: 8, status: 'graded' }, { student_id: bilalId, score: 6, status: 'graded' }]
        .sort((x, y) => x.student_id.localeCompare(y.student_id)),
    );
    expect((await submission(amalId)).published_at).not.toBeNull();
    expect(res.data.emailSummary).toMatchObject({ sent: 2, failed: 0 });

    const emails = sent();
    const toAmal = emails.find((m) => m.to.includes('mona.haddad@example.com'));
    const toBilal = emails.find((m) => m.to.includes('rania.karim@example.com'));
    expect(toAmal.subject).toBe('Amal Haddad — New Grades Posted (Science)');
    expect(toAmal.html).toContain('Homework');
    expect(toAmal.html).toContain('80%'); // the published draft, as the Homework rollup
    expect(toAmal.html).toContain('Unit test');
    expect(toBilal.html).toContain('Homework');
    expect(toBilal.html).toContain('60%');
    expect(toBilal.html).not.toContain('Unit test');
    expect(emails).toHaveLength(2);

    // A plain assessment alone still sends today's digest, unchanged.
    getResend().emails.send.mockClear();
    const quizId = await assessment(sciId, 'Pop quiz', { weight: 0, max: 10 });
    await post(`/api/studentAssessments/classes/${sciId}/scores`, { scores: [{ studentId: daliaId, assessmentId: quizId, score: 7 }] });
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_name, parent_email, relation, school) VALUES ($1, 'Lina Nassar', 'lina.nassar@example.com', 'Mother', 'ALHAADIACADEMY')`,
      [daliaId],
    );
    const plain = await expectStatus(authenticatedRequest('post', `/api/assessment-publications/classes/${sciId}/publish`, asTeacher)
      .send({ assessmentIds: [quizId] }), 201);
    expect(plain.data.classworkPublished).toEqual([]);
    expect(sent().map((m) => m.to)).toEqual([['lina.nassar@example.com']]);
  });

  it("a grading-view Publish of a column that counts on its own sends today's digest to the published students' parents only", async () => {
    const solo = await createItem({
      kind: 'assignment', title: 'Science fair board', submissionMode: 'done', dueAt: inDays(5),
      gradebook: { mode: 'existing', assessmentId: await assessment(sciId, 'Science fair board', { weight: 100, max: 20 }) },
    });
    const soloUrl = `/api/classroom/items/${solo.itemId}`;
    await expectStatus(authenticatedRequest('patch', `${soloUrl}/submissions/${amalId}`, asTeacher).send({ draftScore: 18 }), 200);
    await expectStatus(authenticatedRequest('patch', `${soloUrl}/submissions/${bilalId}`, asTeacher).send({ draftScore: 10 }), 200);
    const { data } = await post(`${soloUrl}/publish`, { studentIds: [amalId] });
    expect(data.emailSummary).toMatchObject({ sent: 1 });
    const emails = sent();
    expect(emails.map((m) => m.to)).toEqual([['mona.haddad@example.com']]);
    expect(emails[0].html).toContain('18/20');
    expect(emails[0].html).not.toContain('10/20');
    // The publish is in the class's history.
    const history = (await get(`/api/assessment-publications/classes/${sciId}/history`)).data;
    expect(history[0]).toMatchObject({ action: 'publish', emailSummary: { sent: 1 } });
  });

  it('grid-overlay reports turned_in, draft and missing_derived cells', async () => {
    await patch(amalId, { draftScore: 8 });
    const late = await createItem({
      kind: 'assignment', title: 'Lab sheet', submissionMode: 'done', dueAt: inDays(1), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 5 },
    });
    await pool.query(`UPDATE classwork_items SET due_at = NOW() - INTERVAL '1 day' WHERE item_id = $1`, [late.itemId]);
    await turnIn(late.itemId, asAmal); // late
    const testId = await assessment(sciId, 'Unit test', { weight: 60, max: 50 });

    const { data } = await get(`/api/classroom/classes/${sciId}/grid-overlay`);
    expect(data.items).toEqual([
      { assessmentId: columnId, itemId: item.itemId, kind: 'assignment', submissionMode: 'done' },
      { assessmentId: late.gradebook.assessmentId, itemId: late.itemId, kind: 'assignment', submissionMode: 'done' },
    ]);
    const key = (c) => `${c.studentId}:${c.assessmentId}`;
    const cells = new Map(data.cells.map((c) => [key(c), c]));
    expect(cells.get(`${amalId}:${columnId}`)).toEqual({ studentId: amalId, assessmentId: columnId, state: 'draft', draftScore: 8, draftStatus: 'graded', isLate: false });
    expect(cells.get(`${bilalId}:${columnId}`)).toMatchObject({ state: 'turned_in', draftScore: null, isLate: false });
    expect(cells.get(`${amalId}:${late.gradebook.assessmentId}`)).toMatchObject({ state: 'turned_in', isLate: true });
    expect(cells.get(`${bilalId}:${late.gradebook.assessmentId}`)).toMatchObject({ state: 'missing_derived' });
    expect(cells.get(`${daliaId}:${late.gradebook.assessmentId}`)).toMatchObject({ state: 'missing_derived' });
    expect(data.cells.some((c) => c.assessmentId === testId)).toBe(false);
    expect(data.cells).toHaveLength(6);

    // Once published, a graded student drops out of the overlay.
    await publish([amalId]);
    const after = (await get(`/api/classroom/classes/${sciId}/grid-overlay`)).data;
    expect(after.cells.some((c) => c.studentId === amalId && c.assessmentId === columnId)).toBe(false);
  });

  it('class card toReviewCount and the toReview rail count turned-in, ungraded work', async () => {
    let { data } = await get('/api/classroom/classes');
    expect(data.classes.find((c) => c.classId === sciId).toReviewCount).toBe(3);
    expect(data.toReview).toEqual([{
      itemId: item.itemId, classId: sciId, classLabel: 'Grade 5 Science', iconUrl: '/class-icons/science.svg',
      title: 'Plant cell diagram', turnedInCount: 3,
    }]);

    await patch(amalId, { draftScore: 8 });
    await patch(bilalId, { draftScore: 0 });
    ({ data } = await get('/api/classroom/classes'));
    expect(data.classes.find((c) => c.classId === sciId).toReviewCount).toBe(1);
    expect(data.toReview[0]).toMatchObject({ itemId: item.itemId, turnedInCount: 1 });

    await patch(daliaId, { draftScore: 9 });
    ({ data } = await get('/api/classroom/classes'));
    expect(data.classes.find((c) => c.classId === sciId).toReviewCount).toBe(0);
    expect(data.toReview).toEqual([]);
    // Another teacher's home doesn't carry this class's work.
    expect((await get('/api/classroom/classes', asOtherTeacher)).data.toReview).toEqual([]);
  });

  it('another teacher 403; student token STUDENT_FORBIDDEN', async () => {
    const calls = [
      ['get', `${itemUrl}/submissions`],
      ['get', `${itemUrl}/submissions/${amalId}`],
      ['patch', `${itemUrl}/submissions/${amalId}`, { draftScore: 5 }],
      ['post', `${itemUrl}/publish`, { studentIds: 'graded' }],
      ['post', `${itemUrl}/mark-missing`, { studentIds: [amalId] }],
      ['post', `${itemUrl}/excuse`, { studentIds: [amalId], excused: true }],
      ['get', `/api/classroom/classes/${sciId}/grid-overlay`],
    ];
    for (const [method, url, body] of calls) {
      expect((await authenticatedRequest(method, url, asOtherTeacher).send(body)).status).toBe(403);
      const fenced = await authenticatedRequest(method, url, asAmal).send(body);
      expect(fenced.status).toBe(403);
      expect(fenced.body.code).toBe('STUDENT_FORBIDDEN');
      expect((await authenticatedRequest(method, url, asParentA).send(body)).status).toBe(403);
    }
    // The admin may grade; a material is not graded here; unknown ids are 404.
    expect((await authenticatedRequest('get', `${itemUrl}/submissions`, asAdmin)).status).toBe(200);
    const material = await createItem({ kind: 'material', title: 'Cells reading' });
    expect((await authenticatedRequest('get', `/api/classroom/items/${material.itemId}/submissions`, asTeacher)).status).toBe(400);
    expect((await authenticatedRequest('get', '/api/classroom/items/99999999-9999-4999-8999-999999999999/submissions', asTeacher)).status).toBe(404);
    expect((await authenticatedRequest('get', `${itemUrl}/submissions/nope`, asTeacher)).status).toBe(404);
    expect(await gradebook()).toEqual([]);
  });

  // ── Fix round 1 (task-16-review.md) ────────────────────────────────────
  describe('fix round 1', () => {
    const editItem = (url, body, status) => expectStatus(authenticatedRequest('patch', url, asTeacher).send(body), status);
    const patchOn = (url, studentId, body, status = 200) =>
      expectStatus(authenticatedRequest('patch', `${url}/submissions/${studentId}`, asTeacher).send(body), status);

    it("C1: an assignment filling an unpublished column that has scores takes them as drafts; publish [A] shows A's grade and nothing else", async () => {
      // Today's model: scores typed in the grid on an unpublished plain column.
      const labId = await assessment(sciId, 'Lab two', { weight: 20, max: 20 });
      await post(`/api/studentAssessments/classes/${sciId}/scores`, {
        scores: [
          { studentId: amalId, assessmentId: labId, score: 5 },
          { studentId: bilalId, assessmentId: labId, score: 6 },
          { studentId: daliaId, assessmentId: labId, score: null, status: 'missing' },
        ],
      });
      const lab = await createItem({
        kind: 'assignment', title: 'Lab two', submissionMode: 'done', dueAt: inDays(2), gradebook: { mode: 'existing', assessmentId: labId },
      });
      const labUrl = `/api/classroom/items/${lab.itemId}`;
      expect(await gradebook(labId)).toEqual([]); // the cells are drafts now
      const before = (await get(`${labUrl}/submissions`)).data;
      expect(before.students.map((r) => [r.name, r.label, r.draftScore, r.draftStatus, r.needsPublish])).toEqual([
        ['Amal Haddad', 'Graded · draft', 5, 'graded', true],
        ['Bilal Karim', 'Graded · draft', 6, 'graded', true],
        ['Dalia Nassar', 'Graded · draft', null, 'missing', true],
      ]);

      await patchOn(labUrl, amalId, { draftScore: 17 });
      const { data } = await post(`${labUrl}/publish`, { studentIds: [amalId] });
      expect(data).toMatchObject({ publishedStudentIds: [amalId], assessmentPublished: true });
      expect(await gradebook(labId)).toEqual([{ student_id: amalId, score: 17, status: 'graded' }]);

      // The reviewer's probe: Bilal and Bilal's parent see nothing of 6.
      expect(await studentGrade(asBilal, labId)).toBeNull();
      expect((await studentItem(asBilal, lab.itemId)).grade).toBeNull();
      const parentB = await parentGrades(asParentB, bilalId);
      expect(parentScore(parentB, labId)?.score ?? null).toBeNull();
      expect((await studentItem(asDalia, lab.itemId)).grade).toBeNull();
      expect(await studentGrade(asAmal, labId)).toMatchObject({ score: 17 });

      // A plain assessment turned into an assignment in place takes its cells the same way.
      const quizId = await assessment(sciId, 'Quiz three', { weight: 10, max: 10 });
      await post(`/api/studentAssessments/classes/${sciId}/scores`, { scores: [{ studentId: bilalId, assessmentId: quizId, score: 7 }] });
      const plainItem = (await pool.query(`SELECT item_id FROM classwork_items WHERE assessment_id = $1`, [quizId])).rows[0].item_id;
      await editItem(`/api/classroom/items/${plainItem}`, { kind: 'assignment', submissionMode: 'done', dueAt: inDays(2) }, 200);
      expect(await gradebook(quizId)).toEqual([]);
      expect(await submission(bilalId, plainItem)).toMatchObject({ draft_score: 7, draft_status: 'graded', published_at: null });
    });

    it("C1: a column's first per-student Publish withholds every other cell, and after an unpublish shows only the student published", async () => {
      // A cell that reached the gradebook outside the draft paths (defence in depth).
      await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, 4, 'graded')`, [daliaId, columnId]);
      await patch(amalId, { draftScore: 8, feedback: 'Well labelled.' });
      await publish([amalId]);
      expect(await gradebook()).toEqual([{ student_id: amalId, score: 8, status: 'graded' }]);
      expect(await submission(daliaId)).toMatchObject({ draft_score: 4, draft_status: 'graded', published_at: null });
      expect(await studentGrade(asDalia)).toBeNull();

      // Unpublished in the gradebook, then one student published: only that one shows.
      await patch(bilalId, { draftScore: 6 }); // live
      await post(`/api/assessment-publications/classes/${sciId}/unpublish`, { assessmentIds: [columnId] });
      await publish([bilalId]);
      expect(await gradebook()).toEqual([{ student_id: bilalId, score: 6, status: 'graded' }]);
      expect(await studentGrade(asBilal)).toMatchObject({ score: 6 });
      expect(await studentGrade(asAmal)).toBeNull();
      expect((await studentItem(asAmal)).grade).toBeNull(); // the feedback too
      expect(await submission(amalId)).toMatchObject({ draft_score: 8, published_at: null, feedback: 'Well labelled.' });
      const amal = (await get(`${itemUrl}/submissions`)).data.students.find((r) => r.studentId === amalId);
      expect(amal).toMatchObject({ label: 'Graded · draft', needsPublish: true });
    });

    it("I1: a per-student Publish never gives the published mark away as a class average", async () => {
      await pool.query(`UPDATE classes SET show_class_average = TRUE WHERE class_id = $1`, [sciId]);
      await patch(amalId, { draftScore: 8 });
      await publish([amalId]);
      const parentB = await parentGrades(asParentB, bilalId);
      expect(parentScore(parentB)).toMatchObject({ classAvgPct: null });
      expect(parentB.classes.find((c) => c.classId === sciId).classAvg).toBeNull();
      const parentA = await parentGrades(asParentA, amalId);
      expect(parentScore(parentA)).toMatchObject({ score: 8, classAvgPct: null });
      engine.invalidateCache();
      const own = (await get('/api/student/grades', asBilal)).data.classes.find((c) => c.classId === sciId);
      expect(own?.classAvg ?? null).toBeNull();
    });

    it("I2: an item whose students' work is graded keeps its column (409); with no grades the change is allowed", async () => {
      const spare = await assessment(sciId, 'Spare column', { parentId: homeworkId, weight: 0, max: 10 });
      await patch(amalId, { draftScore: 8 });

      let res = await editItem(itemUrl, { gradebook: { mode: 'none' } }, 409);
      expect(res.code).toBe('GRADED_WORK_EXISTS');
      res = await editItem(itemUrl, { gradebook: { mode: 'existing', assessmentId: spare } }, 409);
      expect(res).toMatchObject({ code: 'GRADED_WORK_EXISTS', message: expect.stringContaining('already graded') });
      res = await editItem(itemUrl, { gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 5 } }, 409);
      expect(res.code).toBe('DRAFT_ABOVE_MAX');
      await editItem(itemUrl, { gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 20 } }, 200);
      expect(await submission(amalId)).toMatchObject({ draft_score: 8 });
      expect((await pool.query(`SELECT assessment_id FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0].assessment_id).toBe(columnId);

      // Cleared, nothing is graded: switching is allowed.
      await patch(amalId, { draftScore: null });
      expect(await submission(amalId)).toMatchObject({ draft_score: null, draft_status: null });
      await editItem(itemUrl, { gradebook: { mode: 'existing', assessmentId: spare } }, 200);
      expect((await pool.query(`SELECT assessment_id FROM classwork_items WHERE item_id = $1`, [item.itemId])).rows[0].assessment_id).toBe(spare);

      // A published grade blocks too, until it is cleared.
      await patch(bilalId, { draftScore: 6 });
      await publish([bilalId]);
      res = await editItem(itemUrl, { gradebook: { mode: 'none' } }, 409);
      expect(res.code).toBe('GRADED_WORK_EXISTS');
    });

    it('M7 and M4: clearing a published cell puts the work back in To review everywhere', async () => {
      await patch(amalId, { draftScore: 8 });
      await publish([amalId]);
      expect((await get(`${itemUrl}/submissions`)).data.counts).toMatchObject({ toGrade: 2, drafts: 0, published: 1 });

      const { data } = await patch(amalId, { draftScore: null }); // live clear
      expect(data.row).toMatchObject({ label: 'Turned in', needsPublish: false, draftScore: null });
      expect(await submission(amalId)).toMatchObject({ draft_score: null, draft_status: null });
      expect((await get(`${itemUrl}/submissions`)).data.counts).toMatchObject({ toGrade: 3, drafts: 0, published: 0 });
      expect((await get(`/api/classroom/items/${item.itemId}`)).data.counts).toMatchObject({ toReview: 3, drafts: 0 });
      expect((await get('/api/classroom/classes')).data.classes.find((c) => c.classId === sciId).toReviewCount).toBe(3);

      // ITEM_COUNTS uses the grading view's rules: a draft counts once, as in "Publish to N".
      await patch(bilalId, { draftScore: 6 }); // live on the published column
      await expectStatus(authenticatedRequest('patch', `/api/studentAssessments/classes/${sciId}/status`, asTeacher)
        .send({ studentId: daliaId, assessmentId: columnId, status: 'excused' }), 200);
      expect((await get(`/api/classroom/items/${item.itemId}`)).data.counts).toMatchObject({ toReview: 1, drafts: 0 });
    });

    it('M3: publishing a student again with nothing changed is skipped (no second email); a regrade publishes again', async () => {
      const solo = await createItem({
        kind: 'assignment', title: 'Science fair board', submissionMode: 'done', dueAt: inDays(5),
        gradebook: { mode: 'existing', assessmentId: await assessment(sciId, 'Science fair board', { weight: 100, max: 20 }) },
      });
      const soloUrl = `/api/classroom/items/${solo.itemId}`;
      await patchOn(soloUrl, amalId, { draftScore: 18 });
      expect((await post(`${soloUrl}/publish`, { studentIds: [amalId] })).data.emailSummary).toMatchObject({ sent: 1 });

      const again = (await post(`${soloUrl}/publish`, { studentIds: [amalId, daliaId] })).data;
      expect(again.publishedStudentIds).toEqual([]);
      expect(again.skipped).toEqual([{ studentId: amalId, reason: 'unchanged' }, { studentId: daliaId, reason: 'no_draft' }]);
      expect(sent()).toHaveLength(1);

      await patchOn(soloUrl, amalId, { draftScore: 19 }); // live regrade
      const regraded = (await post(`${soloUrl}/publish`, { studentIds: [amalId] })).data;
      expect(regraded.publishedStudentIds).toEqual([amalId]);
      expect(sent()).toHaveLength(2);
    });

    // Fix round 2 (controller ruling): the parent portal keeps today's
    // averages; the floor of 5 applies there only while an assessment is
    // partly published. The Classroom surfaces keep the full rule.
    it("the parent portal's averages for a fully published plain assessment are main's numbers, class option off", async () => {
      const testId = await assessment(sciId, 'Unit test', { weight: 60, max: 50 });
      await post(`/api/studentAssessments/classes/${sciId}/scores`, {
        scores: [{ studentId: amalId, assessmentId: testId, score: 40 }, { studentId: bilalId, assessmentId: testId, score: 30 }],
      });
      await expectStatus(authenticatedRequest('post', `/api/assessment-publications/classes/${sciId}/publish`, asTeacher)
        .send({ assessmentIds: [testId] }), 201);

      // Main's calculation, the engine's own per-assessment average and class mean.
      engine.invalidateCache();
      const matrix = await engine.buildAnalyticsMatrix('ALHAADIACADEMY', termId, engine.normalizeEngine(), { publishedOnly: true });
      const cls = matrix.classes.get(sciId);
      const mainAvg = engine.classAveragesByAssessment(cls).get(testId);
      const finals = [...cls.students.values()].map((x) => x.finalPct).filter((p) => p != null);
      const mainClassAvg = Math.round((finals.reduce((t, p) => t + p, 0) / finals.length) * 10) / 10;
      expect(mainAvg).toBe(70); // (80 + 60) / 2, two students

      for (const [who, id] of [[asParentA, amalId], [asParentB, bilalId]]) {
        const grades = await parentGrades(who, id);
        expect(parentScore(grades, testId).classAvgPct).toBe(mainAvg);
        expect(grades.classes.find((c) => c.classId === sciId).classAvg).toBe(mainClassAvg);
      }
      // The Classroom surfaces keep their rule: off, and fewer than 5.
      engine.invalidateCache();
      expect((await get('/api/student/grades', asAmal)).data.classes.find((c) => c.classId === sciId).classAvg).toBeNull();
    });

    it('a partly published assessment with fewer than 5 released scores hides the average in the parent portal, until it is fully published', async () => {
      await patch(amalId, { draftScore: 8 });
      await patch(bilalId, { draftScore: 6 });
      await patch(daliaId, { draftScore: 7 });
      await publish([amalId]);
      for (const [who, id] of [[asParentA, amalId], [asParentB, bilalId]]) {
        const grades = await parentGrades(who, id);
        expect(parentScore(grades)).toMatchObject({ classAvgPct: null });
        expect(grades.classes.find((c) => c.classId === sciId).classAvg).toBeNull();
      }
      expect(parentScore(await parentGrades(asParentA, amalId), homeworkId).classAvgPct).toBeNull(); // the category too

      // Everyone released: back to today's numbers, even with 3 students.
      await publish('graded');
      const grades = await parentGrades(asParentB, bilalId);
      expect(parentScore(grades)).toMatchObject({ score: 6, classAvgPct: 70 }); // (80 + 60 + 70) / 3
      expect(grades.classes.find((c) => c.classId === sciId).classAvg).toBe(70);
      // The student portal still needs the class option and 5 students.
      engine.invalidateCache();
      expect((await get('/api/student/grades', asBilal)).data.classes.find((c) => c.classId === sciId).classAvg).toBeNull();
    });

    // Fix round 3 (controller ruling on N1): a student outside an item's
    // audience is graded like a plain assessment. The score lives in the
    // gradebook, and the column's own Publish releases it as on main. Drafts
    // and per-student Publish are for the item's students only.
    describe('students outside an item audience (fix round 3)', () => {
      const someItem = async (columnName, audience) => {
        const colId = await assessment(sciId, columnName, { weight: 20, max: 10 });
        return { colId, audience };
      };
      const grid = (scores) => post(`/api/studentAssessments/classes/${sciId}/scores`, { scores });
      const trayPublish = (ids) => expectStatus(authenticatedRequest('post', `/api/assessment-publications/classes/${sciId}/publish`, asTeacher)
        .send({ assessmentIds: ids }), 201);

      it('RR-P6: a make-up item for some students over a graded, unpublished column keeps the others\' grades, and the column\'s Publish releases them', async () => {
        const { colId } = await someItem('Column Z');
        await grid([{ studentId: amalId, assessmentId: colId, score: 5 }, { studentId: daliaId, assessmentId: colId, score: 7 }]);
        const makeUp = await createItem({
          kind: 'assignment', title: 'Column Z', submissionMode: 'done', dueAt: inDays(2),
          audience: 'some', studentIds: [amalId, bilalId], gradebook: { mode: 'existing', assessmentId: colId },
        });
        // Amal (in the audience) is a draft now; Dalia (outside) keeps her gradebook cell.
        expect(await gradebook(colId)).toEqual([{ student_id: daliaId, score: 7, status: 'graded' }]);
        expect(await submission(amalId, makeUp.itemId)).toMatchObject({ draft_score: 5, published_at: null });
        expect(await submission(daliaId, makeUp.itemId)).toBeUndefined();

        // The gradebook's own Publish of the column releases both, as on main.
        const res = await trayPublish([colId]);
        expect(res.data.classworkPublished).toEqual([{ assessmentId: colId, itemId: makeUp.itemId, studentCount: 1 }]);
        expect(await gradebook(colId)).toEqual(
          [{ student_id: amalId, score: 5, status: 'graded' }, { student_id: daliaId, score: 7, status: 'graded' }]
            .sort((x, y) => x.student_id.localeCompare(y.student_id)),
        );
        expect(await studentGrade(asDalia, colId)).toMatchObject({ score: 7 });
        expect(await studentGrade(asAmal, colId)).toMatchObject({ score: 5 });
      });

      it("a column's first per-student Publish is refused while it holds grades for students outside the item's audience", async () => {
        const { colId } = await someItem('Lab sheet B');
        await grid([{ studentId: daliaId, assessmentId: colId, score: 7 }]);
        const makeUp = await createItem({
          kind: 'assignment', title: 'Lab sheet B', submissionMode: 'done', dueAt: inDays(2),
          audience: 'some', studentIds: [amalId, bilalId], gradebook: { mode: 'existing', assessmentId: colId },
        });
        const url = `/api/classroom/items/${makeUp.itemId}`;
        await patchOn(url, amalId, { draftScore: 9 });
        for (const [path, body] of [['publish', { studentIds: [amalId] }], ['mark-missing', { studentIds: [bilalId] }], ['excuse', { studentIds: [bilalId], excused: true }]]) {
          const refused = await post(`${url}/${path}`, body, asTeacher, 409);
          expect(refused.code).toBe('OUTSIDE_AUDIENCE_GRADES');
        }
        expect(await isPublished(colId)).toBe(false);
        expect(await gradebook(colId)).toEqual([{ student_id: daliaId, score: 7, status: 'graded' }]);
        expect(await studentGrade(asDalia, colId)).toBeNull();

        // After the column's Publish in Grades, publishing one student works.
        await trayPublish([colId]);
        await patchOn(url, bilalId, { draftScore: 4 }); // live now
        expect(await cell(bilalId, colId)).toEqual({ student_id: bilalId, score: 4, status: 'graded' });
        expect((await post(`${url}/publish`, { studentIds: [amalId] })).data).toMatchObject({ skipped: [{ studentId: amalId, reason: 'unchanged' }] });
      });

      it("grid edits for a student outside the audience write the gradebook (plain), inside the audience they are drafts", async () => {
        const { colId } = await someItem('Quiz C');
        const quiz = await createItem({
          kind: 'assignment', title: 'Quiz C', submissionMode: 'done', dueAt: inDays(2),
          audience: 'some', studentIds: [amalId], gradebook: { mode: 'existing', assessmentId: colId },
        });
        const res = await grid([{ studentId: amalId, assessmentId: colId, score: 8 }, { studentId: daliaId, assessmentId: colId, score: 6 }]);
        expect(res.data).toEqual([{ student_id: daliaId, assessment_id: colId, score: '6.00', status: 'graded' }]);
        expect(res.drafts).toEqual([{ student_id: amalId, assessment_id: colId, draft_score: '8.00', draft_status: 'graded' }]);
        const status = await expectStatus(authenticatedRequest('patch', `/api/studentAssessments/classes/${sciId}/status`, asTeacher)
          .send({ studentId: bilalId, assessmentId: colId, status: 'missing' }), 200);
        expect(status.data).toEqual([{ student_id: bilalId, assessment_id: colId, score: null, status: 'missing' }]);
        expect(status.drafts).toEqual([]);
        expect(await submission(daliaId, quiz.itemId)).toBeUndefined();
      });

      it('changing the audience moves grades between the item (drafts) and the gradebook (plain)', async () => {
        const { colId } = await someItem('Lab D');
        await grid([{ studentId: daliaId, assessmentId: colId, score: 7 }]);
        const lab = await createItem({
          kind: 'assignment', title: 'Lab D', submissionMode: 'done', dueAt: inDays(2),
          audience: 'some', studentIds: [amalId, bilalId], gradebook: { mode: 'existing', assessmentId: colId },
        });
        const url = `/api/classroom/items/${lab.itemId}`;
        await patchOn(url, bilalId, { draftScore: 6 });

        // Bilal leaves the audience, Dalia joins it.
        await editItem(url, { audience: 'some', studentIds: [amalId, daliaId] }, 200);
        expect(await gradebook(colId)).toEqual([{ student_id: bilalId, score: 6, status: 'graded' }]);
        expect(await submission(bilalId, lab.itemId)).toMatchObject({ draft_score: null, draft_status: null });
        expect(await submission(daliaId, lab.itemId)).toMatchObject({ draft_score: 7, published_at: null });
        const list = (await get(`${url}/submissions`)).data;
        expect(list.students.map((r) => [r.name, r.label])).toEqual([['Amal Haddad', 'Not turned in yet'], ['Dalia Nassar', 'Graded · draft']]);
      });
    });

    it('M9: lifting an excuse keeps the score under it, even one only the gradebook holds', async () => {
      await patch(amalId, { draftScore: 8 });
      await publish([amalId]);
      await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, 6, 'excused')`, [daliaId, columnId]);
      const { data } = await post(`${itemUrl}/excuse`, { studentIds: [daliaId], excused: false });
      expect(data.publishedStudentIds).toEqual([daliaId]);
      expect(await cell(daliaId)).toEqual({ student_id: daliaId, score: 6, status: 'graded' });
    });
  });
});
