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

const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440083', role: 'TEACHER', email: 'absent-a@test.com' };
const OTHER = { userId: '550e8400-e29b-41d4-a716-446655440084', role: 'TEACHER', email: 'absent-b@test.com' };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// "Who was absent this week?": the range routes, and Muley's summary of them.
describe('attendance over a period', () => {
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
    await settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true }, null);
    for (const u of [TEACHER, OTHER]) {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, 'x', 'Tess', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`, [u.userId, u.email, u.email]);
    }
    const { rows: [year] } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id) VALUES ('ALHAADIACADEMY', '6', 'Math', 'T', $1, $2) RETURNING class_id`,
      [TEACHER.userId, year.school_year_id])).rows[0].class_id;
    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Sara Malik', '6', 'ALHAADIACADEMY', $1), ('Yusuf Rahman', '6', 'ALHAADIACADEMY', $1), ('Omar Haddad', '6', 'ALHAADIACADEMY', $1)
       RETURNING student_id, name`, [year.school_year_id]);
    ids = Object.fromEntries(rows.map((r) => [r.name, r.student_id]));
    for (const id of Object.values(ids)) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    const mark = (name, day, status) => pool.query(`INSERT INTO class_attendance (class_id, student_id, attendance_date, status) VALUES ($1, $2, $3, $4)`, [classId, ids[name], day, status]);
    await mark('Yusuf Rahman', '2026-11-02', 'ABSENT');
    await mark('Yusuf Rahman', '2026-11-04', 'ABSENT');
    await mark('Sara Malik', '2026-11-03', 'LATE');
    await mark('Omar Haddad', '2026-11-03', 'PRESENT');
    await mark('Yusuf Rahman', '2026-10-30', 'ABSENT'); // the week before
    const daily = (name, day, status) => pool.query(`INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, $2, $3, 'ALHAADIACADEMY')`, [ids[name], day, status]);
    await daily('Omar Haddad', TODAY, 'ABSENT');
    await daily('Sara Malik', TODAY, 'PRESENT');
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

  it('lists a class\'s marks over a range for its teacher only, and checks the range', async () => {
    const range = (q, token = TEACHER) => authenticatedRequest('get', `/api/attendance/class/${classId}/range?${q}`, token);
    const res = await range('from=2026-11-02&to=2026-11-06');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(4);
    expect(res.body.data[0]).toEqual({ studentId: ids['Yusuf Rahman'], date: '2026-11-02', status: 'ABSENT' });
    expect((await range('from=2026-11-06&to=2026-11-02')).status).toBe(400);
    expect((await range('from=2026-01-01&to=2026-11-06')).status).toBe(400); // over 92 days
    expect((await range('from=nope&to=2026-11-06')).status).toBe(400);
    expect((await range('from=2026-11-02&to=2026-11-06', OTHER)).status).toBe(403);
  });

  it('says who was absent or late in a class over a period', async () => {
    const fake = script([
      [toolCall('list_classes', {})],
      [toolCall('get_attendance_summary', { class: 'c1', period: 'custom', from: '2026-11-02', to: '2026-11-06' }, 'week')],
      [text('Yusuf was absent twice.')],
    ]);
    const { of } = await turn({ message: 'who was absent that week?' });
    const answer = answerOf(fake, 'week');
    expect(answer.daysWithAttendance).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(answer.students.map(({ ref, ...s }) => s)).toEqual([
      { name: 'Yusuf Rahman', absent: 2, late: 0, excused: 0, absentOn: ['2026-11-02', '2026-11-04'], lateOn: [] },
      { name: 'Sara Malik', absent: 0, late: 1, excused: 0, absentOn: [], lateOn: ['2026-11-03'] },
    ]);
    const card = of('card').find((c) => c.id === 'week').card;
    expect(card).toMatchObject({ type: 'table', subtitle: '2026-11-02 to 2026-11-06 · 3 days taken' });
    expect(card.rows).toEqual([{ name: 'Yusuf Rahman', absent: 2, late: 0 }, { name: 'Sara Malik', absent: 0, late: 1 }]);
    for (const id of Object.values(ids)) expect(fake.seen()).not.toContain(id);
  });

  it('reads the school\'s daily attendance when no class is named', async () => {
    const fake = script([[toolCall('get_attendance_summary', { class: null, period: 'today', from: null, to: null }, 'day')], [text('Omar.')]]);
    await turn({ message: 'who is absent today?' });
    const answer = answerOf(fake, 'day');
    expect(answer.scope).toBe('Daily attendance');
    expect(answer.students.map((s) => [s.name, s.absent])).toEqual([['Omar Haddad', 1]]);
  });

  it('says so when no attendance was taken, rather than calling everyone present', async () => {
    const fake = script([[toolCall('get_attendance_summary', { class: null, period: 'custom', from: '2026-08-03', to: '2026-08-07' }, 'none')], [text('None taken.')]]);
    await turn({ message: 'absences in August?' });
    expect(answerOf(fake, 'none')).toMatchObject({ daysWithAttendance: [], students: [], note: expect.stringContaining('No attendance was taken') });
  });
});
