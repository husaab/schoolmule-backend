// Quizzes (T23): the builder (questions, the column's points, images), one
// attempt per student (start, autosave, a confirmed submit), auto-grading
// with a per-answer teacher override that survives a regrade, and release
// after review (a draft until Publish, D3) or on submit (published at once).
// The answer key never reaches a student before their grade is visible, a
// student reads and writes only their own attempt, and answers can't change
// after submit. Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const engine = require('../../../services/analyticsEngine');
const { getResend } = require('../../../utils/emailUtils');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440004';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const BILAL_USER_ID = '550e8400-e29b-41d4-a716-446655440011';
const OMAR_USER_ID = '550e8400-e29b-41d4-a716-446655440012';

const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const student = (userId, username, email) => ({ userId, username, email, role: 'STUDENT', roles: ['STUDENT'] });
const asAmal = student(AMAL_USER_ID, 'Amal Haddad', 'amal.haddad@example.com');
const asBilal = student(BILAL_USER_ID, 'Bilal Karim', 'bilal.karim@example.com');
const asOmar = student(OMAR_USER_ID, 'Omar Saleh', 'omar.saleh@example.com');

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();

const ON_SUBMIT_MESSAGE = 'Release right after submit only works when every question is auto-graded.';
const TAKEN_MESSAGE = 'Students have already taken this quiz. You can change wording, answers and points, but not remove questions.';

const choices = (...texts) => texts.map((text, i) => ({ id: 'abcdefgh'[i], text }));
const ONE = {
  kind: 'one', prompt: 'Which part of a plant cell makes food using sunlight?',
  options: choices('Nucleus', 'Chloroplast', 'Vacuole', 'Cell wall'), correct: ['b'], points: 2,
};
const MANY = {
  kind: 'many', prompt: "Which parts do plant cells have that animal cells don't?",
  options: choices('Cell wall', 'Chloroplasts', 'Nucleus', 'Cell membrane'), correct: ['a', 'b'], points: 2,
};
const SHORT = { kind: 'short', prompt: 'What is the jelly-like substance that fills a cell called?', accepted: ['cytoplasm'], points: 1 };
const LONG = { kind: 'long', prompt: 'Why do plant cells need a cell wall? Explain in 2 or 3 sentences.', points: 3 };

// Every key anywhere in a payload: the answer key must never be one of them.
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
};
const expectNoKey = (body) => {
  const keys = keysOf(body);
  expect(keys.has('correct')).toBe(false);
  expect(keys.has('accepted')).toBe(false);
  expect(JSON.stringify(body)).not.toContain('cytoplasm');
};

describe('Integration: quizzes', () => {
  let pool, yearId, termId, sciId, mathId, homeworkId;
  let amalId, bilalId, omarId;

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
    await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [loginId, id, yearId]);
    await pool.query(`INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())`, [loginId]);
    return id;
  };

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const call = (method, url, who, body) => expectStatus.bind(null, authenticatedRequest(method, url, who).send(body));
  const get = (url, who = asTeacher, status = 200) => call('get', url, who)(status);
  const post = (url, body, who = asTeacher, status = 200) => call('post', url, who, body)(status);
  const put = (url, body, who = asTeacher, status = 200) => call('put', url, who, body)(status);
  const patch = (url, body, who = asTeacher, status = 200) => call('patch', url, who, body)(status);

  const createQuiz = async (extra = {}) => (await post(`/api/classroom/classes/${sciId}/items`, {
    kind: 'quiz', title: 'Cells quiz', dueAt: inDays(2), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 }, ...extra,
  }, asTeacher, 201)).data;
  const putQuestions = (itemId, questions, status = 200, who = asTeacher) => put(`/api/classroom/items/${itemId}/questions`, { questions }, who, status);
  const quizUrl = (itemId) => `/api/student/items/${itemId}`;
  const studentQuiz = async (itemId, who = asAmal) => (await get(`${quizUrl(itemId)}/quiz`, who)).data;
  const start = async (itemId, who = asAmal) => (await post(`${quizUrl(itemId)}/quiz/start`, undefined, who)).data;
  const answer = (itemId, answers, who = asAmal, status = 200) => put(`${quizUrl(itemId)}/quiz-answers`, { answers }, who, status);
  const submit = (itemId, who = asAmal, status = 200) => post(`${quizUrl(itemId)}/quiz-submit`, undefined, who, status);
  const detail = async (itemId, studentId) => (await get(`/api/classroom/items/${itemId}/submissions/${studentId}`)).data;
  const override = (answerId, body, who = asTeacher, status = 200) => patch(`/api/classroom/quiz-answers/${answerId}`, body, who, status);

  const submission = async (itemId, studentId) => (await pool.query(
    `SELECT draft_score::float AS draft_score, draft_status, published_at, turned_in_at, is_late
     FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`, [itemId, studentId],
  )).rows[0];
  const cell = async (assessmentId, studentId) => (await pool.query(
    `SELECT score::float AS score, status FROM student_assessments WHERE assessment_id = $1 AND student_id = $2`, [assessmentId, studentId],
  )).rows[0];
  const isPublished = async (assessmentId) => (await pool.query(
    `SELECT is_published FROM assessments WHERE assessment_id = $1`, [assessmentId],
  )).rows[0].is_published;
  const idsOf = (questions) => questions.map((q) => q.questionId);
  // A third student of the class, signed in.
  const DALIA_USER_ID = '550e8400-e29b-41d4-a716-446655440013';
  const makeStudentWithLogin = async () => {
    await user(DALIA_USER_ID, 'dalia.nassar@example.com', 'Dalia', 'Nassar', 'STUDENT');
    const studentId = await makeStudent('Dalia Nassar', sciId, DALIA_USER_ID);
    return { studentId, who: student(DALIA_USER_ID, 'Dalia Nassar', 'dalia.nassar@example.com') };
  };
  const sent = () => getResend().emails.send.mock.calls.map(([msg]) => msg);

  /** A quiz with these questions, posted; returns { item, questions } (the builder's view). */
  const quizWith = async (questions, extra = {}) => {
    const item = await createQuiz(extra);
    const built = (await putQuestions(item.itemId, questions)).data;
    return { item, questions: built.questions };
  };

  beforeEach(async () => {
    supabase._reset();
    engine.invalidateCache();
    getResend().emails.send.mockClear();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;
    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(PARENT_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await user(BILAL_USER_ID, 'bilal.karim@example.com', 'Bilal', 'Karim', 'STUDENT');
    await user(OMAR_USER_ID, 'omar.saleh@example.com', 'Omar', 'Saleh', 'STUDENT');
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);
    sciId = await makeClass('Science', TEACHER_ID);
    mathId = await makeClass('Math', OTHER_TEACHER_ID);
    amalId = await makeStudent('Amal Haddad', sciId, AMAL_USER_ID);
    bilalId = await makeStudent('Bilal Karim', sciId, BILAL_USER_ID);
    omarId = await makeStudent('Omar Saleh', mathId, OMAR_USER_ID);
    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school)
       VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY')`, [PARENT_ID, amalId],
    );
    homeworkId = (await pool.query(
      `INSERT INTO assessments (class_id, name, is_parent, weight_points) VALUES ($1, 'Quizzes', TRUE, 40) RETURNING assessment_id`, [sciId],
    )).rows[0].assessment_id;
  });

  it("PUT questions validates and sets the column's max score", async () => {
    const item = await createQuiz();
    expect(item.quiz).toEqual({ release: 'after_review', shuffle: false, showAnswers: false });
    const url = `/api/classroom/items/${item.itemId}/questions`;
    expect((await get(url)).data).toEqual({
      questions: [], settings: { release: 'after_review', shuffle: false, showAnswers: false }, hasSubmissions: false, totalPoints: 0,
    });

    // Validation: every rule answers 400 and writes nothing.
    for (const bad of [[], [{ ...ONE, correct: [] }], [{ ...MANY, correct: [] }], [{ ...SHORT, accepted: [] }], [{ ...ONE, points: 101 }],
      [{ ...ONE, partialCredit: true }], [{ ...ONE, options: choices('Only one') }], [{ ...LONG, prompt: '' }]]) {
      await putQuestions(item.itemId, bad, 400);
    }
    await put(url, { questions: 'nope' }, asTeacher, 400);
    await putQuestions(item.itemId, [{ ...ONE, imagePath: `PLAYGROUND/classwork/${item.itemId}/questions/x.png` }], 400);
    expect((await get(url)).data.questions).toEqual([]);

    const { data } = await putQuestions(item.itemId, [ONE, { ...MANY, partialCredit: true }, SHORT, LONG]);
    expect(data.totalPoints).toBe(8);
    expect(data.hasSubmissions).toBe(false);
    expect(data.questions.map((q) => [q.kind, q.points, q.sortOrder])).toEqual([['one', 2, 0], ['many', 2, 1], ['short', 1, 2], ['long', 3, 3]]);
    expect(data.questions[0]).toMatchObject({
      prompt: ONE.prompt, options: ONE.options, correct: ['b'], accepted: [], partialCredit: false, imagePath: null, imageUrl: null,
    });
    expect(data.questions[1]).toMatchObject({ correct: ['a', 'b'], partialCredit: true });
    expect(data.questions[2]).toMatchObject({ accepted: ['cytoplasm'], options: [] });
    expect(data.questions[0].questionId).toEqual(expect.any(String));
    // The column is out of the quiz's points.
    const column = (await pool.query(`SELECT max_score::float AS max FROM assessments WHERE assessment_id = $1`, [item.gradebook.assessmentId])).rows[0];
    expect(column.max).toBe(8);
    expect((await get(`/api/classroom/items/${item.itemId}`)).data.gradebook.maxScore).toBe(8);

    // Upsert by id: reorder, edit one, add one, drop one (nobody has taken it).
    const [q1, q2, q3, q4] = data.questions;
    const next = (await putQuestions(item.itemId, [
      { ...LONG, questionId: q4.questionId, prompt: 'Explain the wall.' },
      { ...ONE, questionId: q1.questionId, points: 4 },
      { ...SHORT, questionId: q3.questionId },
      { kind: 'short', prompt: 'Name the green pigment.', accepted: ['chlorophyll'], points: 1 },
    ])).data;
    expect(next.questions.map((q) => q.questionId).slice(0, 3)).toEqual([q4.questionId, q1.questionId, q3.questionId]);
    expect(next.questions[0].prompt).toBe('Explain the wall.');
    expect(next.questions.some((q) => q.questionId === q2.questionId)).toBe(false);
    expect(next.totalPoints).toBe(9);
    // An id from another quiz is not this quiz's.
    const other = await quizWith([ONE]);
    await putQuestions(item.itemId, [{ ...ONE, questionId: other.questions[0].questionId }], 400);

    // An image: uploaded under the quiz's folder, then referenced.
    const upload = await expectStatus(authenticatedRequest('post', `/api/classroom/items/${item.itemId}/question-images`, asTeacher)
      .attach('image', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]), { filename: 'cell.png', contentType: 'image/png' }), 201);
    expect(upload.data.imagePath).toMatch(new RegExp(`^ALHAADIACADEMY/classwork/${item.itemId}/questions/[0-9a-f-]+\\.png$`));
    const withImage = (await putQuestions(item.itemId, [{ ...ONE, questionId: q1.questionId, imagePath: upload.data.imagePath }])).data;
    expect(withImage.questions[0].imageUrl).toEqual(expect.stringContaining(upload.data.imagePath));
    // Removing it (and the other questions) removes the stored image.
    supabase._mockStorage.remove.mockClear();
    await putQuestions(item.itemId, [{ ...ONE, questionId: q1.questionId }]);
    expect(supabase._mockStorage.remove).toHaveBeenCalledWith([upload.data.imagePath]);

    // Guards: not a quiz, another teacher, a student.
    const assignment = (await post(`/api/classroom/classes/${sciId}/items`, { kind: 'assignment', title: 'Lab', submissionMode: 'done' }, asTeacher, 201)).data;
    expect((await get(`/api/classroom/items/${assignment.itemId}/questions`, asTeacher, 400)).message).toBe('Only a quiz has questions.');
    await get(url, asOtherTeacher, 403);
    await putQuestions(item.itemId, [ONE], 403, asOtherTeacher);
    expect((await get(url, asAmal, 403)).code).toBe('STUDENT_FORBIDDEN');
  });

  it('student GET never contains correct or accepted', async () => {
    const { item, questions } = await quizWith([ONE, MANY, SHORT, LONG]);
    const before = await studentQuiz(item.itemId);
    expectNoKey(before);
    expect(before.quiz).toMatchObject({
      itemId: item.itemId, title: 'Cells quiz', subject: 'Science', totalPoints: 8, questionCount: 4, dueAt: item.dueAt,
      release: 'after_review', attemptsAllowed: 1, teacher: { userId: TEACHER_ID, name: 'Ziad Teacher' },
    });
    expect(before.attempt).toBeNull();
    expect(before.results).toBeNull();
    expect(before.questions.map((q) => [q.kind, q.points, q.hint])).toEqual([
      ['one', 2, null], ['many', 2, 'Pick all that apply.'], ['short', 1, null], ['long', 3, 'Your teacher grades this one.'],
    ]);
    expect(before.questions[0]).toEqual({
      questionId: questions[0].questionId, kind: 'one', prompt: ONE.prompt, imageUrl: null, options: ONE.options, points: 2, hint: null,
    });

    // Through start, autosave, submit: no key in any reply, and none in the errors.
    expectNoKey(await start(item.itemId));
    expectNoKey(await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'a' } }]));
    expectNoKey(await answer(item.itemId, [{ questionId: questions[1].questionId, answer: { choices: ['z'] } }], asAmal, 400));
    expectNoKey(await answer(item.itemId, [{ questionId: questions[2].questionId, answer: { text: 'cell jelly' } }]));
    expectNoKey(await submit(item.itemId));
    expectNoKey(await studentQuiz(item.itemId));
    expectNoKey(await submit(item.itemId, asAmal, 409));
    // The item page and the To-do say how many questions it has, and no key either.
    const page = (await get(quizUrl(item.itemId), asAmal)).data;
    expectNoKey(page);
    const todo = (await get('/api/student/todo?tab=done', asAmal)).data;
    expect(todo.groups.flatMap((g) => g.items).find((i) => i.itemId === item.itemId)).toMatchObject({ kind: 'quiz', questionCount: 4 });

    // Published without "show right answers": results, but still no key.
    const long = (await detail(item.itemId, amalId)).quiz.answers.find((a) => a.kind === 'long');
    await override(long.answerId, { teacherPoints: 1 });
    await post(`/api/classroom/items/${item.itemId}/publish`, { studentIds: [amalId] });
    const graded = await studentQuiz(item.itemId);
    expect(graded.results).toMatchObject({ earned: 1, possible: 8 });
    expectNoKey(graded);
  });

  it('start stores a shuffled order when shuffle is on (same order on reload)', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...SHORT, prompt: `Question ${i + 1}`, accepted: [`answer ${i + 1}`] }));
    const { item, questions } = await quizWith(many);
    await patch(`/api/classroom/items/${item.itemId}`, { quizShuffle: true });
    expect((await get(`/api/classroom/items/${item.itemId}`)).data.quiz).toEqual({ release: 'after_review', shuffle: true, showAnswers: false });

    const first = await start(item.itemId);
    const stored = (await pool.query(`SELECT question_order FROM quiz_attempts WHERE item_id = $1 AND student_id = $2`, [item.itemId, amalId])).rows[0];
    expect([...stored.question_order].sort()).toEqual(idsOf(questions).sort());
    expect(idsOf(first.questions)).toEqual(stored.question_order);
    // Reload and a second start keep the order and the attempt.
    expect(idsOf((await studentQuiz(item.itemId)).questions)).toEqual(stored.question_order);
    const again = await start(item.itemId);
    expect(again.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(idsOf(again.questions)).toEqual(stored.question_order);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE item_id = $1`, [item.itemId])).rows[0].n).toBe(1);
    // Starting opened the submission.
    expect((await pool.query(`SELECT opened_at FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`, [item.itemId, amalId])).rows[0].opened_at)
      .not.toBeNull();
    // The teacher sees the same order in the grading detail.
    expect((await detail(item.itemId, amalId)).quiz.answers.map((a) => a.questionId)).toEqual(stored.question_order);

    // Shuffle off: no stored order, the quiz's own order.
    await patch(`/api/classroom/items/${item.itemId}`, { quizShuffle: false });
    const bilal = await start(item.itemId, asBilal);
    expect(idsOf(bilal.questions)).toEqual(idsOf(questions));
    expect((await pool.query(`SELECT question_order FROM quiz_attempts WHERE student_id = $1`, [bilalId])).rows[0].question_order).toEqual([]);
  });

  it('answers autosave then submit; second submit 409', async () => {
    const { item, questions } = await quizWith([ONE, MANY, SHORT, LONG]);
    const [one, many, short, long] = questions;

    // An answer before start starts the attempt; a later save replaces it.
    const saved = await answer(item.itemId, [{ questionId: one.questionId, answer: { choice: 'a' } }]);
    expect(saved.data.savedAt).toEqual(expect.any(String));
    await answer(item.itemId, [
      { questionId: one.questionId, answer: { choice: 'b' } },
      { questionId: many.questionId, answer: { choices: ['b', 'a'] } },
      { questionId: short.questionId, answer: { text: '  Cytoplasm ' } },
    ]);
    let quiz = await studentQuiz(item.itemId);
    expect(quiz.attempt.submittedAt).toBeNull();
    expect(quiz.attempt.answers).toEqual({
      [one.questionId]: { choice: 'b' }, [many.questionId]: { choices: ['a', 'b'] }, [short.questionId]: { text: '  Cytoplasm ' },
    });
    // A cleared answer.
    await answer(item.itemId, [{ questionId: short.questionId, answer: null }]);
    expect((await studentQuiz(item.itemId)).attempt.answers[short.questionId]).toBeUndefined();
    await answer(item.itemId, [{ questionId: short.questionId, answer: { text: '  Cytoplasm ' } }]);

    // Shapes are checked per type.
    for (const bad of [
      [{ questionId: one.questionId, answer: { choice: 'h' } }],
      [{ questionId: one.questionId, answer: 'b' }],
      [{ questionId: many.questionId, answer: { choices: ['a', 'a'] } }],
      [{ questionId: short.questionId, answer: { text: 'x'.repeat(301) } }],
      [{ questionId: long.questionId, answer: { text: 'x'.repeat(20001) } }],
      [{ questionId: '00000000-0000-4000-8000-000000000000', answer: { text: 'x' } }],
      [{ questionId: one.questionId, answer: { choice: 'a' } }, { questionId: one.questionId, answer: { choice: 'b' } }],
    ]) await answer(item.itemId, bad, asAmal, 400);
    await put(`${quizUrl(item.itemId)}/quiz-answers`, { answers: [] }, asAmal, 400);

    // The item page: a quiz has no Turn in or Unsubmit of its own.
    expect((await post(`${quizUrl(item.itemId)}/turn-in`, undefined, asAmal, 400)).message).toBe('Answer the quiz to turn it in.');

    const { data } = await submit(item.itemId);
    expect(data.attempt.submittedAt).toEqual(expect.any(String));
    expect(data.results).toBeNull(); // after review: a draft, nothing visible yet
    const rows = (await pool.query(
      `SELECT qq.kind, qa.auto_points::float AS auto, qa.answer FROM quiz_answers qa JOIN quiz_questions qq ON qq.question_id = qa.question_id
       WHERE qa.attempt_id = $1 ORDER BY qq.sort_order`, [data.attempt.attemptId],
    )).rows;
    expect(rows.map((r) => [r.kind, r.auto])).toEqual([['one', 2], ['many', 2], ['short', 1], ['long', null]]);
    expect(rows[3].answer).toBeNull(); // the skipped written answer has a row to grade
    expect((await pool.query(`SELECT auto_score::float AS s FROM quiz_attempts WHERE attempt_id = $1`, [data.attempt.attemptId])).rows[0].s).toBe(5);
    expect(await submission(item.itemId, amalId)).toMatchObject({ is_late: false, draft_score: null, published_at: null });
    expect((await submission(item.itemId, amalId)).turned_in_at).not.toBeNull();
    expect((await get(quizUrl(item.itemId), asAmal)).data.submission).toMatchObject({ status: 'turned_in', canUnsubmit: false });

    // Answers can't change after submit; a second submit is refused.
    expect((await submit(item.itemId, asAmal, 409)).code).toBe('ALREADY_SUBMITTED');
    expect((await answer(item.itemId, [{ questionId: one.questionId, answer: { choice: 'a' } }], asAmal, 409)).code).toBe('ALREADY_SUBMITTED');
    expect((await post(`${quizUrl(item.itemId)}/unsubmit`, undefined, asAmal, 409)).message).toBe("A quiz can't be unsubmitted.");
    quiz = await studentQuiz(item.itemId);
    expect(quiz.attempt.answers[one.questionId]).toEqual({ choice: 'b' });

    // Past due in a class that takes no late work: closed, for answers and submit alike.
    await pool.query(`UPDATE classes SET accept_late = FALSE WHERE class_id = $1`, [sciId]);
    await pool.query(`UPDATE classwork_items SET due_at = NOW() - interval '1 hour' WHERE item_id = $1`, [item.itemId]);
    expect((await answer(item.itemId, [{ questionId: one.questionId, answer: { choice: 'a' } }], asBilal, 409)).code).toBe('ITEM_CLOSED');
    expect((await submit(item.itemId, asBilal, 409)).code).toBe('ITEM_CLOSED');
    // Late work allowed: turned in late.
    await pool.query(`UPDATE classes SET accept_late = TRUE WHERE class_id = $1`, [sciId]);
    await submit(item.itemId, asBilal);
    expect(await submission(item.itemId, bilalId)).toMatchObject({ is_late: true });
  });

  it('on_submit release publishes the grade at once (student sees results)', async () => {
    // A column that counts on its own, so the parents' publish digest has a line for it.
    const solo = (await pool.query(
      `INSERT INTO assessments (class_id, name, weight_points, max_score) VALUES ($1, 'Cells quiz', 100, 20) RETURNING assessment_id`, [sciId],
    )).rows[0].assessment_id;
    const { item, questions } = await quizWith([ONE, MANY, SHORT], { gradebook: { mode: 'existing', assessmentId: solo } });
    const column = item.gradebook.assessmentId;
    expect(column).toBe(solo);
    const settings = await patch(`/api/classroom/items/${item.itemId}`, { quizRelease: 'on_submit' });
    expect(settings.data.quiz).toEqual({ release: 'on_submit', shuffle: false, showAnswers: false });

    await answer(item.itemId, [
      { questionId: questions[0].questionId, answer: { choice: 'b' } },
      { questionId: questions[1].questionId, answer: { choices: ['a'] } },
      { questionId: questions[2].questionId, answer: { text: 'Cytoplasm' } },
    ]);
    const { data } = await submit(item.itemId);
    expect(data.results).toEqual({
      earned: 3, possible: 5,
      perQuestion: [
        { questionId: questions[0].questionId, points: 2, note: null },
        { questionId: questions[1].questionId, points: 0, note: null },
        { questionId: questions[2].questionId, points: 1, note: null },
      ],
    });
    // In the gradebook, published for Amal only (D3: the first per-student Publish).
    expect(await cell(column, amalId)).toEqual({ score: 3, status: 'graded' });
    expect(await isPublished(column)).toBe(true);
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: 3, draft_status: 'graded' });
    expect((await submission(item.itemId, amalId)).published_at).not.toBeNull();
    expect(await cell(column, bilalId)).toBeUndefined();
    engine.invalidateCache();
    const grade = (await get('/api/student/grades', asAmal)).data.classes.flatMap((c) => c.items).find((i) => i.assessmentId === column);
    expect(grade).toMatchObject({ score: 3, maxScore: 5 });
    expect((await get(quizUrl(item.itemId), asAmal)).data.submission.status).toBe('graded');
    // Like any Publish: a batch in the history, the parents' digest, the student's graded email queued.
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM assessment_publication_batches WHERE class_id = $1`, [sciId])).rows[0].n).toBe(1);
    const digest = sent().filter((m) => m.to.includes('mona.haddad@example.com'));
    expect(digest).toHaveLength(1);
    expect(digest[0].html).toContain('3/5');
    expect((await pool.query(`SELECT recipient_email FROM classroom_email_jobs WHERE kind = 'graded'`)).rows)
      .toEqual([{ recipient_email: 'amal.haddad@example.com' }]);

    // "Show right answers once published": the key comes with the results, never before.
    await patch(`/api/classroom/items/${item.itemId}`, { quizShowAnswers: true });
    const shown = await studentQuiz(item.itemId);
    expect(shown.results.perQuestion.map((p) => p.correct)).toEqual([['b'], ['a', 'b'], ['cytoplasm']]);
    expect(shown.questions.every((q) => !('correct' in q))).toBe(true);
    expectNoKey(await studentQuiz(item.itemId, asBilal)); // Bilal hasn't taken it

    // A second student's submit publishes theirs too, and a second batch.
    await submit(item.itemId, asBilal);
    expect(await cell(column, bilalId)).toEqual({ score: 0, status: 'graded' });
    expect((await studentQuiz(item.itemId, asBilal)).results).toMatchObject({ earned: 0, possible: 5 });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM assessment_publication_batches WHERE class_id = $1`, [sciId])).rows[0].n).toBe(2);
  });

  it('after_review leaves a draft; with a written answer the draft is null until the teacher grades it', async () => {
    // All auto-graded: the draft is the score, waiting for Publish.
    const auto = await quizWith([ONE, SHORT]);
    await answer(auto.item.itemId, [{ questionId: auto.questions[0].questionId, answer: { choice: 'b' } }]);
    await submit(auto.item.itemId);
    expect(await submission(auto.item.itemId, amalId)).toMatchObject({ draft_score: 2, draft_status: 'graded', published_at: null });
    expect(await cell(auto.item.gradebook.assessmentId, amalId)).toBeUndefined();
    expect((await studentQuiz(auto.item.itemId)).results).toBeNull();
    const list = (await get(`/api/classroom/items/${auto.item.itemId}/submissions`)).data;
    expect(list.students.find((s) => s.studentId === amalId)).toMatchObject({ draftScore: 2, label: 'Graded · draft', needsPublish: true });

    // With a written answer: no draft until the teacher grades it.
    const { item, questions } = await quizWith([ONE, LONG]);
    await answer(item.itemId, [
      { questionId: questions[0].questionId, answer: { choice: 'b' } },
      { questionId: questions[1].questionId, answer: { text: 'It keeps the cell firm.' } },
    ]);
    await submit(item.itemId);
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: null, draft_status: null });
    let quiz = (await detail(item.itemId, amalId)).quiz;
    expect(quiz).toMatchObject({ earned: 2, possible: 5, needsReview: true, submittedAt: expect.any(String) });
    const written = quiz.answers.find((a) => a.kind === 'long');
    expect(written).toMatchObject({
      questionId: questions[1].questionId, prompt: LONG.prompt, points: 3, answer: { text: 'It keeps the cell firm.' },
      autoPoints: null, teacherPoints: null, teacherNote: null, correct: [], accepted: [],
    });
    expect(quiz.answers[0]).toMatchObject({ kind: 'one', autoPoints: 2, correct: ['b'], answer: { choice: 'b' } });
    expect((await get(`/api/classroom/items/${item.itemId}/submissions`)).data.students.find((s) => s.studentId === amalId).label).toBe('Turned in');

    // The teacher grades it: the draft is the total; still hidden until Publish.
    await override(written.answerId, { teacherPoints: 4 }, asTeacher, 400); // above the question's 3 points
    await override(written.answerId, { teacherPoints: -1 }, asTeacher, 400);
    const graded = await override(written.answerId, { teacherPoints: 2.5, teacherNote: 'Good: rigid. Add: protection.' });
    expect(graded.data).toEqual({
      answer: expect.objectContaining({ answerId: written.answerId, teacherPoints: 2.5, teacherNote: 'Good: rigid. Add: protection.', autoPoints: null }),
      totals: { earned: 4.5, possible: 5, needsReview: false },
    });
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: 4.5, draft_status: 'graded', published_at: null });
    expect((await studentQuiz(item.itemId)).results).toBeNull();
    // Publish (D3): the student sees the results, the teacher's note with them.
    await post(`/api/classroom/items/${item.itemId}/publish`, { studentIds: [amalId] });
    quiz = await studentQuiz(item.itemId);
    expect(quiz.results).toEqual({
      earned: 4.5, possible: 5,
      perQuestion: [
        { questionId: questions[0].questionId, points: 2, note: null },
        { questionId: questions[1].questionId, points: 2.5, note: 'Good: rigid. Add: protection.' },
      ],
    });
    expect(await cell(item.gradebook.assessmentId, amalId)).toEqual({ score: 4.5, status: 'graded' });

    // A visible grade in the published column that Bilal's attempt hasn't
    // been published over (a cell written outside the quiz) doesn't release
    // the attempt's results: they wait for the work to be published.
    await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'b' } }], asBilal);
    await submit(item.itemId, asBilal);
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, 1, 'graded')`,
      [bilalId, item.gradebook.assessmentId]);
    expect((await get(quizUrl(item.itemId), asBilal)).data.grade).toMatchObject({ score: 1 });
    expect((await studentQuiz(item.itemId, asBilal)).results).toBeNull();
    const bilalLong = (await detail(item.itemId, bilalId)).quiz.answers.find((a) => a.kind === 'long');
    await override(bilalLong.answerId, { teacherPoints: 0 }); // published column: live (D17)
    expect((await studentQuiz(item.itemId, asBilal)).results).toMatchObject({ earned: 2, possible: 5 });
    expect(await cell(item.gradebook.assessmentId, bilalId)).toEqual({ score: 2, status: 'graded' });

    // The column is published now (D17): another override goes live as it saves.
    await override(written.answerId, { teacherPoints: 3 });
    expect(await cell(item.gradebook.assessmentId, amalId)).toEqual({ score: 5, status: 'graded' });
    expect((await studentQuiz(item.itemId)).results.earned).toBe(5);
    // Overrides are for turned-in work only.
    const dalia = await makeStudentWithLogin();
    await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'a' } }], dalia.who);
    const daliaAnswer = (await detail(item.itemId, dalia.studentId)).quiz.answers[0];
    expect((await override(daliaAnswer.answerId, { teacherPoints: 1 }, asTeacher, 409)).message).toBe("This quiz isn't turned in yet.");
    await override(daliaAnswer.answerId, { teacherPoints: 1 }, asOtherTeacher, 403);
    await override(daliaAnswer.answerId, {}, asTeacher, 400);
  });

  it('teacher override updates the draft score; a later answer-key change regrades auto points but keeps the override', async () => {
    const { item, questions } = await quizWith([ONE, { ...MANY, partialCredit: true }, SHORT]);
    const [one, many, short] = questions;
    await answer(item.itemId, [
      { questionId: one.questionId, answer: { choice: 'b' } },
      { questionId: many.questionId, answer: { choices: ['a', 'c'] } },
      { questionId: short.questionId, answer: { text: 'cytosol' } },
    ]);
    await submit(item.itemId);
    // one 2 + many (1 - 1) / 2 x 2 = 0 + short 0
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: 2 });

    const answers = (await detail(item.itemId, amalId)).quiz.answers;
    // A 0 override beats the machine's 2.
    let res = await override(answers[0].answerId, { teacherPoints: 0 });
    expect(res.data.totals).toEqual({ earned: 0, possible: 5, needsReview: false });
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: 0 });
    // Marked right by hand on the short answer.
    res = await override(answers[2].answerId, { teacherPoints: 1, teacherNote: 'Close enough.' });
    expect(res.data.totals.earned).toBe(1);

    // The key changes: "cytosol" accepted, c is right on the many question too.
    // Auto points are re-run; both overrides stay, and the draft follows.
    await putQuestions(item.itemId, [
      { ...ONE, questionId: one.questionId },
      { ...MANY, questionId: many.questionId, correct: ['a', 'c'], partialCredit: true },
      { ...SHORT, questionId: short.questionId, accepted: ['cytoplasm', 'cytosol'] },
    ]);
    const after = (await detail(item.itemId, amalId)).quiz;
    expect(after.answers.map((a) => [a.autoPoints, a.teacherPoints])).toEqual([[2, 0], [2, null], [1, 1]]);
    expect(after.answers[2].teacherNote).toBe('Close enough.');
    expect(after).toMatchObject({ earned: 3, possible: 5, needsReview: false });
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: 3, published_at: null });
    // Clearing an override goes back to the machine's points.
    res = await override(answers[0].answerId, { teacherPoints: null });
    expect(res.data).toMatchObject({ answer: { teacherPoints: null, autoPoints: 2 }, totals: { earned: 5 } });

    // Regrading is idempotent: the same key again changes nothing.
    const stamp = (await pool.query(`SELECT updated_at FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`, [item.itemId, amalId])).rows[0];
    await putQuestions(item.itemId, [
      { ...ONE, questionId: one.questionId },
      { ...MANY, questionId: many.questionId, correct: ['a', 'c'], partialCredit: true },
      { ...SHORT, questionId: short.questionId, accepted: ['cytoplasm', 'cytosol'] },
    ]);
    expect((await pool.query(`SELECT updated_at FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`, [item.itemId, amalId])).rows[0])
      .toEqual(stamp);
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: 5 });

    // A points cut below an override is refused until the override changes.
    await override(answers[2].answerId, { teacherPoints: 1 });
    const cut = await putQuestions(item.itemId, [
      { ...ONE, questionId: one.questionId },
      { ...MANY, questionId: many.questionId, correct: ['a', 'c'], partialCredit: true },
      { ...SHORT, questionId: short.questionId, accepted: ['cytoplasm', 'cytosol'], points: 0.5 },
    ], 409);
    expect(cut.code).toBe('OVERRIDE_ABOVE_POINTS');

    // Published (Publish), then the key changes again: the grade follows live.
    await post(`/api/classroom/items/${item.itemId}/publish`, { studentIds: [amalId] });
    expect(await cell(item.gradebook.assessmentId, amalId)).toEqual({ score: 5, status: 'graded' });
    await putQuestions(item.itemId, [
      { ...ONE, questionId: one.questionId, correct: ['a'] },
      { ...MANY, questionId: many.questionId, correct: ['a', 'c'], partialCredit: true },
      { ...SHORT, questionId: short.questionId, accepted: ['cytoplasm', 'cytosol'] },
    ]);
    expect(await cell(item.gradebook.assessmentId, amalId)).toEqual({ score: 3, status: 'graded' });
    expect((await studentQuiz(item.itemId)).results.earned).toBe(3);
  });

  it('removing a question after a submission is 409', async () => {
    const { item, questions } = await quizWith([ONE, SHORT]);
    const keep = questions.map((q, i) => ({ ...[ONE, SHORT][i], questionId: q.questionId }));
    await answer(item.itemId, [{ questionId: questions[1].questionId, answer: { text: 'cytoplasm' } }], asBilal); // started only
    await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'b' } }]);
    await submit(item.itemId);

    const res = await putQuestions(item.itemId, [keep[0]], 409);
    expect(res).toMatchObject({ code: 'QUIZ_TAKEN', message: TAKEN_MESSAGE });
    expect((await get(`/api/classroom/items/${item.itemId}/questions`)).data).toMatchObject({ hasSubmissions: true, totalPoints: 3 });
    // A type change on an answered question is refused too.
    expect((await putQuestions(item.itemId, [{ ...LONG, questionId: questions[0].questionId }, keep[1]], 409)).code).toBe('QUIZ_TAKEN');
    // Wording can change, and a question can be added: everyone who turned
    // it in gets a blank answer for it (0 for an auto-graded one).
    const added = (await putQuestions(item.itemId, [{ ...keep[0], prompt: 'Which part makes food from light?' }, keep[1],
      { kind: 'one', prompt: 'Is a cell wall rigid?', options: choices('Yes', 'No'), correct: ['a'], points: 1 }])).data;
    expect(added.totalPoints).toBe(4);
    const after = (await detail(item.itemId, amalId)).quiz;
    expect(after.answers).toHaveLength(3);
    expect(after.answers[2]).toMatchObject({ answer: null, autoPoints: 0 });
    expect(after).toMatchObject({ earned: 2, possible: 4, needsReview: false });
  });

  it('on_submit with a written question is 400', async () => {
    const { item, questions } = await quizWith([ONE, LONG]);
    const res = await patch(`/api/classroom/items/${item.itemId}`, { quizRelease: 'on_submit' }, asTeacher, 400);
    expect(res.message).toBe(ON_SUBMIT_MESSAGE);
    expect((await get(`/api/classroom/items/${item.itemId}`)).data.quiz.release).toBe('after_review');
    await patch(`/api/classroom/items/${item.itemId}`, { quizRelease: 'whenever' }, asTeacher, 400);
    await patch(`/api/classroom/items/${item.itemId}`, { quizShuffle: 'yes' }, asTeacher, 400);

    // Released on submit, the builder refuses a written question.
    await putQuestions(item.itemId, [{ ...ONE, questionId: questions[0].questionId }]);
    await patch(`/api/classroom/items/${item.itemId}`, { quizRelease: 'on_submit' });
    expect((await putQuestions(item.itemId, [{ ...ONE, questionId: questions[0].questionId }, LONG], 400)).message).toBe(ON_SUBMIT_MESSAGE);
    // A new quiz can be created with its settings.
    const created = await createQuiz({ title: 'Quick check', quizRelease: 'on_submit', quizShuffle: true, quizShowAnswers: true });
    expect(created.quiz).toEqual({ release: 'on_submit', shuffle: true, showAnswers: true });
  });

  it('another student cannot read or answer this attempt', async () => {
    const { item, questions } = await quizWith([ONE, SHORT]);
    await answer(item.itemId, [{ questionId: questions[1].questionId, answer: { text: 'Amal wrote this' } }]);
    await submit(item.itemId);

    // Bilal (same class) sees only his own attempt: none yet.
    const bilal = await studentQuiz(item.itemId, asBilal);
    expect(bilal.attempt).toBeNull();
    expect(JSON.stringify(bilal)).not.toContain('Amal wrote this');
    // His answers make his own attempt; Amal's stays as it was.
    await answer(item.itemId, [{ questionId: questions[1].questionId, answer: { text: 'Bilal wrote this' } }], asBilal);
    expect((await studentQuiz(item.itemId, asBilal)).attempt.answers).toEqual({ [questions[1].questionId]: { text: 'Bilal wrote this' } });
    expect((await studentQuiz(item.itemId)).attempt.answers[questions[1].questionId]).toEqual({ text: 'Amal wrote this' });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE item_id = $1`, [item.itemId])).rows[0].n).toBe(2);

    // A student outside the class gets 404 on every quiz route.
    await get(`${quizUrl(item.itemId)}/quiz`, asOmar, 404);
    await post(`${quizUrl(item.itemId)}/quiz/start`, undefined, asOmar, 404);
    await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'b' } }], asOmar, 404);
    await submit(item.itemId, asOmar, 404);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE student_id = $1`, [omarId])).rows[0].n).toBe(0);
    // An item for some students only: 404 for the others.
    const some = await quizWith([ONE], { title: 'Retake', audience: 'some', studentIds: [amalId] });
    await get(`${quizUrl(some.item.itemId)}/quiz`, asBilal, 404);
    await submit(some.item.itemId, asBilal, 404);
    // Students never reach a teacher's quiz routes (the fence).
    const amalAnswer = (await detail(item.itemId, amalId)).quiz.answers[0];
    expect((await override(amalAnswer.answerId, { teacherPoints: 0 }, asBilal, 403)).code).toBe('STUDENT_FORBIDDEN');
    expect((await get(`/api/classroom/items/${item.itemId}/submissions/${amalId}`, asBilal, 403)).code).toBe('STUDENT_FORBIDDEN');
    // A draft or not-yet-posted quiz is 404 too.
    const draft = await createQuiz({ title: 'Next week', status: 'draft' });
    await putQuestions(draft.itemId, [ONE]);
    await get(`${quizUrl(draft.itemId)}/quiz`, asAmal, 404);
    // A quiz with no questions can't be started.
    const empty = await createQuiz({ title: 'Empty' });
    expect((await post(`${quizUrl(empty.itemId)}/quiz/start`, undefined, asAmal, 409)).message).toBe('This quiz has no questions yet. Ask your teacher.');
    // Not a quiz.
    const lab = (await post(`/api/classroom/classes/${sciId}/items`, { kind: 'assignment', title: 'Lab', submissionMode: 'done' }, asTeacher, 201)).data;
    await get(`${quizUrl(lab.itemId)}/quiz`, asAmal, 400);
  });

  it('a quiz with no gradebook column releases its results by Publish (or on submit), with no score anywhere else', async () => {
    const { item, questions } = await quizWith([ONE, SHORT], { gradebook: { mode: 'none' } });
    await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'b' } }]);
    await submit(item.itemId);
    expect(await submission(item.itemId, amalId)).toMatchObject({ draft_score: null, published_at: null });
    expect((await studentQuiz(item.itemId)).results).toBeNull();
    // The teacher's list counts it to publish; Publish releases the results.
    const list = (await get(`/api/classroom/items/${item.itemId}/submissions`)).data;
    expect(list.counts.drafts).toBe(1);
    expect(list.students.find((s) => s.studentId === amalId)).toMatchObject({ needsPublish: true, label: 'Turned in' });
    const pub = await post(`/api/classroom/items/${item.itemId}/publish`, { studentIds: 'graded' });
    expect(pub.data.publishedStudentIds).toEqual([amalId]);
    expect((await studentQuiz(item.itemId)).results).toMatchObject({ earned: 2, possible: 3 });
    expect((await get(`/api/classroom/items/${item.itemId}/submissions`)).data.students.find((s) => s.studentId === amalId).label).toBe('Published');

    // On submit: released as the student turns it in.
    await patch(`/api/classroom/items/${item.itemId}`, { quizRelease: 'on_submit' });
    await submit(item.itemId, asBilal);
    expect((await studentQuiz(item.itemId, asBilal)).results).toMatchObject({ earned: 0, possible: 3 });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM student_assessments WHERE student_id = ANY($1::uuid[])`, [[amalId, bilalId]])).rows[0].n).toBe(0);
  });

  it('a Grades publish of the column releases a quiz draft like any turn-in draft', async () => {
    const { item, questions } = await quizWith([ONE]);
    await answer(item.itemId, [{ questionId: questions[0].questionId, answer: { choice: 'b' } }]);
    await submit(item.itemId);
    expect((await studentQuiz(item.itemId)).results).toBeNull();
    await post(`/api/assessment-publications/classes/${sciId}/publish`, { assessmentIds: [item.gradebook.assessmentId] }, asTeacher, 201);
    expect(await cell(item.gradebook.assessmentId, amalId)).toEqual({ score: 2, status: 'graded' });
    expect((await studentQuiz(item.itemId)).results).toMatchObject({ earned: 2, possible: 2 });
  });
});
