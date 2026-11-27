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

const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440094', role: 'TEACHER', email: 'daily-a@test.com' };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Daily (general) attendance through Muley: what most schools mean by
// "attendance". A teacher's "my students" is their homeroom.
describe('Muley: daily attendance', () => {
  let pool, ids;

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
    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES
         ('Sara Malik', '6', 'ALHAADIACADEMY', $1, $2), ('Yusuf Rahman', '6', 'ALHAADIACADEMY', $1, $2), ('Omar Haddad', '7', 'ALHAADIACADEMY', $1, NULL)
       RETURNING student_id, name`, [year.school_year_id, TEACHER.userId]);
    ids = Object.fromEntries(rows.map((r) => [r.name, r.student_id]));
    await pool.query(`INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, $2, 'LATE', 'ALHAADIACADEMY')`, [ids['Sara Malik'], TODAY]);
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
  const daily = async () => Object.fromEntries((await pool.query(
    `SELECT s.name, g.status FROM general_attendance g JOIN students s ON s.student_id = g.student_id WHERE g.attendance_date = $1`, [TODAY])).rows.map((r) => [r.name, r.status]));

  it('marks the teacher\'s homeroom present except the one named, saves on Save, and Undo puts it back', async () => {
    const fake = script([
      [toolCall('get_daily_attendance', { date: 'today', who: 'homeroom', grade: null }, 'read')],
      [toolCall('propose_general_attendance', { date: 'today', who: 'homeroom', grade: null, marks: [{ student: 's2', status: 'ABSENT' }], everyone_else: 'PRESENT', overwrite: false }, 'prep')],
      [text('Here is today\'s attendance: press Save.')],
    ]);
    const { of } = await turn({ message: 'mark everyone present, Yusuf is away', pageContext: { route: '/attendance/general', classId: null } });

    // On the General Attendance page Muley is told which attendance "attendance" means, and the panel says so.
    expect(fake.calls[0].system[1]).toContain('General Attendance page');
    expect(of('context')[0].label).toBe('Daily attendance');
    expect(answerOf(fake, 'read')).toMatchObject({ attendance: 'daily', scope: 'Your homeroom', counts: { Late: 1, unmarked: 1 } });
    expect(answerOf(fake, 'read').students.map((s) => s.name)).toEqual(['Sara Malik', 'Yusuf Rahman']);

    const [{ action }] = of('action');
    expect(action).toMatchObject({ kind: 'general_attendance', applyLabel: 'Save 1 mark', topics: [`attendance:general:${TODAY}`] });
    const card = of('card').find((c) => c.id === 'prep').card;
    expect(card).toMatchObject({ title: 'Daily attendance · Your homeroom', rows: [{ name: 'Yusuf Rahman', now: 'unmarked', next: 'Absent' }], note: '1 student keeps their mark.' });
    expect(await daily()).toEqual({ 'Sara Malik': 'LATE' });

    const saved = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/apply`, TEACHER).send({ expectedHash: action.hash });
    expect(saved.body.data.status).toBe('applied');
    expect(await daily()).toEqual({ 'Sara Malik': 'LATE', 'Yusuf Rahman': 'ABSENT' });
    await authenticatedRequest('post', `/api/assistant/actions/${action.id}/undo`, TEACHER).send({});
    expect(await daily()).toEqual({ 'Sara Malik': 'LATE' });
  });

  it('takes a whole grade, and refuses a student outside the scope', async () => {
    const fake = script([
      [toolCall('find_student', { name: 'Omar' }, 'find')],
      [toolCall('propose_general_attendance', { date: 'today', who: 'grade', grade: '6', marks: [{ student: 's1', status: 'ABSENT' }], everyone_else: null, overwrite: false }, 'wrong')],
      [toolCall('propose_general_attendance', { date: 'today', who: 'grade', grade: '7', marks: [{ student: 's1', status: 'ABSENT' }], everyone_else: null, overwrite: false }, 'right')],
      [text('Omar is marked absent.')],
    ]);
    const { of } = await turn({ message: 'Omar is absent today' });
    expect(answerOf(fake, 'wrong').error).toMatchObject({ code: 'NOT_IN_SCOPE' });
    expect(of('action')).toHaveLength(1);
    expect(of('card').find((c) => c.id === 'right').card.title).toBe('Daily attendance · Grade 7');
  });

  it('says so when the teacher has no homeroom, so Muley can ask which grade', async () => {
    await pool.query(`UPDATE students SET homeroom_teacher_id = NULL`);
    const fake = script([[toolCall('propose_general_attendance', { date: 'today', who: 'homeroom', grade: null, marks: [], everyone_else: 'PRESENT', overwrite: false }, 'none')], [text('Which grade?')]]);
    await turn({ message: 'mark my students present' });
    expect(answerOf(fake, 'none').error.code).toBe('NO_HOMEROOM');
  });

  it('prepares one card per class for "all my classes"', async () => {
    const { rows: [year] } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    for (const subject of ['Math', 'Science']) {
      const { rows: [c] } = await pool.query(`INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id) VALUES ('ALHAADIACADEMY', '6', $1, 'T', $2, $3) RETURNING class_id`, [subject, TEACHER.userId, year.school_year_id]);
      for (const id of [ids['Sara Malik'], ids['Yusuf Rahman']]) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [c.class_id, id]);
    }
    const fake = script([
      [toolCall('list_classes', {})],
      [
        toolCall('propose_class_attendance', { class: 'c1', date: 'today', marks: [], everyone_else: 'PRESENT', overwrite: false }, 'one'),
        toolCall('propose_class_attendance', { class: 'c2', date: 'today', marks: [], everyone_else: 'PRESENT', overwrite: false }, 'two'),
      ],
      [text('Two cards are ready.')],
    ]);
    const { of } = await turn({ message: 'mark everyone present in all my classes' });
    expect(of('action')).toHaveLength(2);
    expect(fake.calls[0].tools.find((t) => t.name === 'propose_class_attendance').description).toMatch(/once for each class/);
  });

  it('shows no guide button when two pages fit as well as each other', async () => {
    const fake = script([[toolCall('find_feature', { query: 'take attendance', class: null }, 'where')], [text('Two places.')]]);
    const { of } = await turn({ message: 'where do I take attendance?' });
    expect(answerOf(fake, 'where').results.map((r) => r.title)).toEqual(expect.arrayContaining(['Class Attendance', 'General Attendance']));
    expect(of('card').filter((c) => c.card.type === 'link')).toEqual([]);

    // "All my classes" goes to Class Attendance, never to All Messages.
    const classes = script([[toolCall('find_feature', { query: 'mark attendance for all my classes', class: null }, 'classes')], [text('Class Attendance.')]]);
    const second = await turn({ message: 'mark attendance for all my classes' });
    expect(answerOf(classes, 'classes').results.map((r) => r.title)).not.toContain('All Messages');
    expect(second.of('card').find((c) => c.card.type === 'link').card.label).toBe('Open Class Attendance');
  });
});
