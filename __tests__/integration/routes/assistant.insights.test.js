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

const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440081', role: 'TEACHER', email: 'insights-a@test.com' };

// Muley reads the Analytics page's numbers: a class's term so far, one
// student across their classes, and who needs attention. Read-only, so these
// work where changes are switched off too.
describe('Muley: how a class and a student are doing', () => {
  let pool, classId, ids;

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
    await settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true, allowWrites: false }, null);
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Tess', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`, [TEACHER.userId, TEACHER.email, TEACHER.email]);
    const { rows: [year] } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    const { rows: [term] } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2026-06-30', '2025-2026', true) RETURNING term_id`);
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id) VALUES ('ALHAADIACADEMY', '6', 'Math', 'Tess Teacher', $1, $2, 'Term 1', $3) RETURNING class_id`,
      [TEACHER.userId, term.term_id, year.school_year_id])).rows[0].class_id;
    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school, oen, school_year_id) VALUES ('Sara Malik', '6', 'ALHAADIACADEMY', '123456789', $1), ('Yusuf Rahman', '6', 'ALHAADIACADEMY', '987654321', $1), ('Omar Haddad', '6', 'ALHAADIACADEMY', NULL, $1)
       RETURNING student_id, name`, [year.school_year_id]);
    ids = Object.fromEntries(rows.map((r) => [r.name, r.student_id]));
    for (const id of Object.values(ids)) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    const quiz = async (name) => (await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, is_parent, max_score, weight_points) VALUES ($1, $2, 50, false, 20, 50) RETURNING assessment_id`, [classId, name])).rows[0].assessment_id;
    const q1 = await quiz('Fractions quiz');
    const q2 = await quiz('Decimals quiz');
    const mark = (student, assessment, score, status = 'graded') => pool.query(
      `INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, $3, $4)`, [ids[student], assessment, score, status]);
    await mark('Sara Malik', q1, 18);
    await mark('Sara Malik', q2, 16);
    await mark('Yusuf Rahman', q1, 8);
    await mark('Yusuf Rahman', q2, null, 'missing');
    await mark('Omar Haddad', q1, 14);
  });

  const script = (steps) => {
    const fake = fakeProvider(steps);
    provider.__setAdapterForTests(fake);
    return fake;
  };
  const turn = async (body) => {
    const res = await authenticatedRequest('post', '/api/assistant/turns', TEACHER).send(body);
    const events = res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { events, of: (t) => events.filter((e) => e.t === t) };
  };
  const answerOf = (fake, id) => JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === id).content);

  it('says how a class is doing this term, as the Analytics page counts it', async () => {
    const fake = script([[toolCall('list_classes', {})], [toolCall('get_class_insights', { class: 'c1' }, 'ins')], [text('Yusuf needs attention.')]]);
    const { of } = await turn({ message: 'how is my math class doing?' });

    const answer = answerOf(fake, 'ins');
    expect(answer.class).toBe('Math · Grade 6');
    expect(answer.classAverage).toEqual(expect.any(Number));
    const byName = Object.fromEntries(answer.students.map((s) => [s.name, s]));
    expect(byName['Sara Malik'].grade).toBe(85);
    expect(byName['Yusuf Rahman']).toMatchObject({ grade: 20, missing: 1 });
    expect(byName['Omar Haddad']).toMatchObject({ grade: 70, notYetGraded: 1 });
    expect(answer.students[0]).not.toHaveProperty('rank');
    expect(answer.assessments.map((a) => a.name).sort()).toEqual(['Decimals quiz', 'Fractions quiz']);

    const card = of('card').find((c) => c.id === 'ins').card;
    expect(card).toMatchObject({ type: 'table', title: 'Math · Grade 6 · this term' });
    expect(card.rows).toEqual(expect.arrayContaining([{ name: 'Yusuf Rahman', grade: '20%', missing: 1 }]));
    // Nothing the model saw carries an id or an education number.
    for (const id of [classId, ...Object.values(ids)]) expect(fake.seen()).not.toContain(id);
    expect(fake.seen()).not.toMatch(/123456789|987654321/);
  });

  it('finds a student by name and says how they are doing across their classes', async () => {
    const fake = script([
      [toolCall('find_student', { name: 'yusuf' }, 'find')],
      [toolCall('get_student_insights', { student: 's1' }, 'stu')],
      [text('Yusuf is behind in Math.')],
    ]);
    const { of } = await turn({ message: 'how is Yusuf doing?' });

    expect(answerOf(fake, 'find')).toMatchObject({ students: [{ ref: 's1', name: 'Yusuf Rahman', grade: '6' }], more: 0 });
    const student = answerOf(fake, 'stu');
    expect(student).toMatchObject({ student: 'Yusuf Rahman', term: 'Term 1', overallAverage: 20 });
    expect(student.classes).toEqual([expect.objectContaining({ class: 'Math', grade: 20, missing: 1 })]);
    expect(of('card').find((c) => c.id === 'stu').card).toMatchObject({ type: 'table', title: 'Yusuf Rahman · Term 1' });
    expect(fake.seen()).not.toContain(ids['Yusuf Rahman']);
  });

  it('lists who needs attention, with the reasons', async () => {
    const fake = script([[toolCall('get_students_needing_attention', { grade: null }, 'risk')], [text('Yusuf.')]]);
    await turn({ message: 'who is struggling this term?' });
    const answer = answerOf(fake, 'risk');
    expect(answer.students.map((s) => s.name)).toEqual(['Yusuf Rahman']);
    expect(answer.students[0].why).toEqual(['overall 20%']);
    expect(answer.rule).toMatch(/under 60%/);
  });

  it('ranks the top students in a grade by their overall average', async () => {
    const fake = script([[toolCall('get_top_students', { grade: '6', subject: null, order: 'highest', limit: 10 }, 'top')], [text('Sara is first.')]]);
    const { of } = await turn({ message: 'who is the number one student in grade 6?' });
    const answer = answerOf(fake, 'top');
    expect(answer).toMatchObject({ scope: 'Grade 6', order: 'highest', outOf: 3 });
    expect(answer.ranked.map((r) => [r.place, r.name, r.grade])).toEqual([[1, 'Sara Malik', 85], [2, 'Omar Haddad', 70], [3, 'Yusuf Rahman', 20]]);
    expect(answer.basis).toMatch(/overall average/);
    const card = of('card').find((c) => c.id === 'top').card;
    expect(card).toMatchObject({ type: 'table', title: 'Top students · Grade 6' });
    expect(card.rows[0]).toEqual({ place: 1, name: 'Sara Malik', where: 'Grade 6', grade: '85%' });
    for (const id of Object.values(ids)) expect(fake.seen()).not.toContain(id);
  });

  it('ranks one subject across all its classes, lowest first when asked', async () => {
    const fake = script([
      [toolCall('get_top_students', { grade: null, subject: 'math', order: 'highest', limit: 2 }, 'math')],
      [toolCall('get_top_students', { grade: null, subject: 'Math', order: 'lowest', limit: 1 }, 'low')],
      [toolCall('get_top_students', { grade: null, subject: 'Science', order: 'highest', limit: 5 }, 'sci')],
      [text('Done.')],
    ]);
    await turn({ message: 'who is best in math, in all the classes?' });
    const math = answerOf(fake, 'math');
    expect(math.ranked.map((r) => [r.name, r.class])).toEqual([['Sara Malik', 'Math · Grade 6'], ['Omar Haddad', 'Math · Grade 6']]);
    expect(math.ranked[0].gradedWork).toBe('2 of 2');
    expect(math.outOf).toBe(3);
    expect(answerOf(fake, 'low').ranked.map((r) => r.name)).toEqual(['Yusuf Rahman']);
    expect(answerOf(fake, 'sci')).toMatchObject({ error: expect.objectContaining({ code: 'NO_CLASSES' }) });
  });

  it('says plainly when nobody matches the name', async () => {
    const fake = script([[toolCall('find_student', { name: 'zzz nobody' }, 'none')], [text('No one by that name.')]]);
    const { of } = await turn({ message: 'how is zzz doing?' });
    expect(answerOf(fake, 'none').students).toEqual([]);
    expect(of('tool').find((e) => e.id === 'none' && e.state === 'finished').summary).toBe('No student by that name');
  });
});
