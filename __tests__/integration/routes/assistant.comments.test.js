jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

process.env.ASSISTANT_TURNS_PER_MINUTE = '10000';

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { fakeProvider, text, toolCall } = require('../../helpers/fakeProvider');
const provider = require('../../../services/assistant/provider');
const dispatcher = require('../../../services/assistant/tools/dispatcher');
const settings = require('../../../services/assistant/settings');

const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440093', role: 'TEACHER', email: 'comments-a@test.com' };
const SARA_NEW = 'Sara listens closely and shares thoughtful ideas in our discussions. Her next step is to explain her thinking in writing with the same care.';
const YUSUF_NEW = 'Yusuf has worked steadily this term and is gaining confidence with fractions. His next step is to check his answers before handing work in.';

// Muley writes report card comments: the teacher reads each one on the card
// and nothing is saved until they press Save, through the same route, word
// limits and lock as the comments page. Learning skills are left alone.
describe('Muley: report card comments', () => {
  let pool, classId, termId, ids;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
    dispatcher.__setTransportForTests(async ({ method, path, headers, body }) => {
      let req = request(getApp())[method.toLowerCase()](path).set(headers);
      if (body !== undefined) req = req.send(body);
      const res = await req;
      return { status: res.status, body: res.body };
    });
  });
  afterAll(() => {
    dispatcher.__setTransportForTests(null);
    provider.__setAdapterForTests(null);
  });

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    settings.invalidateAll();
    await settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true, allowWrites: true }, null);
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Tess', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`, [TEACHER.userId, TEACHER.email, TEACHER.email]);
    const { rows: [year] } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id) VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2027-06-30', TRUE, $1) RETURNING term_id`,
      [year.school_year_id])).rows[0].term_id;
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id) VALUES ('ALHAADIACADEMY', '6', 'Math', 'T', $1, $2, 'Term 1', $3) RETURNING class_id`,
      [TEACHER.userId, termId, year.school_year_id])).rows[0].class_id;
    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, gender, oen) VALUES ('Sara Malik', '6', 'ALHAADIACADEMY', $1, 'female', '123456789'), ('Yusuf Rahman', '6', 'ALHAADIACADEMY', $1, 'male', NULL), ('Omar Haddad', '6', 'ALHAADIACADEMY', $1, NULL, NULL)
       RETURNING student_id, name`, [year.school_year_id]);
    ids = Object.fromEntries(rows.map((r) => [r.name, r.student_id]));
    for (const id of Object.values(ids)) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    await pool.query(
      `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment, comment_details) VALUES
         ($1, $3, 'Term 1', 'G', 'E', 'Old comment for Sara.', '{"picks":{"participation":"strong"},"note":"Loves group work"}'),
         ($2, $3, 'Term 1', 'S', 'G', NULL, NULL)`,
      [ids['Sara Malik'], ids['Yusuf Rahman'], classId]);
    await pool.query(`INSERT INTO report_comment_limits (school, kind, min_words, max_words) VALUES ('ALHAADIACADEMY', 'report_card', 10, 40)`);
  });

  const script = (steps) => {
    const fake = fakeProvider(steps);
    provider.__setAdapterForTests(fake);
    return fake;
  };
  const turn = async (body, token = TEACHER) => {
    const res = await authenticatedRequest('post', '/api/assistant/turns', token).send(body);
    const events = res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { events, of: (t) => events.filter((e) => e.t === t) };
  };
  const answerOf = (fake, id) => JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === id).content);
  const saved = async () => Object.fromEntries((await pool.query(
    `SELECT s.name, f.work_habits, f.behavior, f.comment, f.comment_details FROM report_card_feedback f JOIN students s ON s.student_id = f.student_id WHERE f.class_id = $1`, [classId])).rows
    .map((r) => [r.name, { workHabits: r.work_habits, behavior: r.behavior, comment: r.comment, details: r.comment_details }]));
  const prepare = (entries) => script([
    [toolCall('list_classes', {})],
    [toolCall('get_report_card_comments', { class: 'c1' }, 'read')],
    [toolCall('propose_report_card_comments', { class: 'c1', entries }, 'write')],
    [text('Here are the comments: read them and press Save.')],
  ]);

  it('reads what the comments need: skills, details, pronouns, grades and the school\'s limits', async () => {
    const fake = prepare([{ student: 's2', comment: SARA_NEW }]);
    const { of } = await turn({ message: 'write report card comments for math' });
    const read = answerOf(fake, 'read');
    expect(read).toMatchObject({ class: 'Math · Grade 6', term: 'Term 1', wordLimits: { min: 10, max: 40 }, locked: false });
    const sara = read.students.find((s) => s.name === 'Sara Malik');
    expect(sara).toMatchObject({ pronouns: 'she/her', workHabits: 'Good', behaviour: 'Excellent', comment: 'Old comment for Sara.', commentWords: 4, teacherDetails: { picks: { participation: 'strong' }, note: 'Loves group work' } });
    expect(read.students.find((s) => s.name === 'Omar Haddad')).toMatchObject({ pronouns: 'they/them', comment: null });
    expect(read.writingGuide).toMatch(/third person/);
    expect(of('card').find((c) => c.id === 'read').card).toMatchObject({ type: 'table', subtitle: 'Term 1 · 1 of 3 written · up to 40 words' });
    for (const id of Object.values(ids)) expect(fake.seen()).not.toContain(id);
    expect(fake.seen()).not.toContain('123456789');
  });

  it('prepares comments in full, saves them on Save keeping learning skills and details, and Undo puts back what was there', async () => {
    // Refs follow the roster's name order: Omar s1, Sara s2, Yusuf s3.
    prepare([{ student: 's2', comment: SARA_NEW }, { student: 's3', comment: YUSUF_NEW }]);
    const { of } = await turn({ message: 'write comments for Sara and Yusuf' });
    const [{ action }] = of('action');
    expect(action).toMatchObject({ kind: 'report_card_comment', applyLabel: 'Save 2 comments', topics: [`report-comments:${classId}`] });
    const card = of('card').find((c) => c.id === 'write').card;
    expect(card).toMatchObject({ type: 'comment_change', title: 'Report card comments', subtitle: 'Math · Grade 6 · Term 1', limits: { min: 10, max: 40 } });
    expect(card.items).toEqual([
      { name: 'Sara Malik', now: 'Old comment for Sara.', next: SARA_NEW, words: 24 },
      { name: 'Yusuf Rahman', now: null, next: YUSUF_NEW, words: 24 },
    ]);
    // Nothing is written before Save.
    expect((await saved())['Sara Malik'].comment).toBe('Old comment for Sara.');

    const res = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/apply`, TEACHER).send({ expectedHash: action.hash });
    expect(res.body.data).toMatchObject({ status: 'applied', doneLabel: 'Saved 2 comments' });
    const after = await saved();
    expect(after['Sara Malik']).toEqual({ workHabits: 'G', behavior: 'E', comment: SARA_NEW, details: { picks: { participation: 'strong' }, note: 'Loves group work' } });
    expect(after['Yusuf Rahman']).toMatchObject({ workHabits: 'S', behavior: 'G', comment: YUSUF_NEW });

    const undone = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/undo`, TEACHER).send({});
    expect(undone.body.data.status).toBe('undone');
    const back = await saved();
    expect(back['Sara Malik']).toMatchObject({ workHabits: 'G', behavior: 'E', comment: 'Old comment for Sara.' });
    expect(back['Yusuf Rahman'].comment).toBeNull();
  });

  it('refuses a comment over the school\'s maximum, naming who is over', async () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ');
    const fake = prepare([{ student: 's2', comment: long }]);
    const { of } = await turn({ message: 'write a long comment' });
    expect(of('action')).toEqual([]);
    expect(answerOf(fake, 'write').error).toMatchObject({ code: 'COMMENT_TOO_LONG', message: expect.stringContaining('Sara Malik (45 words)') });
  });

  it('prepares nothing while the school has comments locked, and Save is refused if the lock comes after the preview', async () => {
    prepare([{ student: 's2', comment: SARA_NEW }]);
    const { of } = await turn({ message: 'write a comment for Sara' });
    const [{ action }] = of('action');
    await pool.query(`INSERT INTO report_comment_term_locks (term_id, kind) VALUES ($1, 'report_card')`, [termId]);

    const res = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/apply`, TEACHER).send({ expectedHash: action.hash });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMMENTS_LOCKED');
    expect((await saved())['Sara Malik'].comment).toBe('Old comment for Sara.');

    const fake = prepare([{ student: 's2', comment: SARA_NEW }]);
    const locked = await turn({ message: 'write a comment for Sara again' });
    expect(locked.of('action')).toEqual([]);
    expect(answerOf(fake, 'write').error.code).toBe('COMMENTS_LOCKED');
  });

  it('leaves JK and SK comments to the kindergarten pages', async () => {
    await pool.query(`UPDATE classes SET grade = 'SK' WHERE class_id = $1`, [classId]);
    const fake = script([[toolCall('list_classes', {})], [toolCall('get_report_card_comments', { class: 'c1' }, 'read')], [text('Kindergarten pages.')]]);
    await turn({ message: 'comments for SK' });
    expect(answerOf(fake, 'read').error.code).toBe('KINDERGARTEN');
  });
});
