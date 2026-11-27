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

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440085';
const MONA = { userId: '550e8400-e29b-41d4-a716-446655440086', role: 'PARENT', email: 'mona.muley@example.com', username: 'Mona Haddad' };
const OMAR = { userId: '550e8400-e29b-41d4-a716-446655440087', role: 'PARENT', email: 'omar.muley@example.com', username: 'Omar Saleh' };

// Muley for a parent: their own children only, through the parent portal's
// own routes, with the parent API gate enforcing.
describe('Muley for parents', () => {
  let pool, amal, rami;
  const gate = process.env.RBAC_PARENT_GATE;

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
    if (gate === undefined) delete process.env.RBAC_PARENT_GATE;
    else process.env.RBAC_PARENT_GATE = gate;
  });

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.RBAC_PARENT_GATE = 'enforce';
    settings.invalidateAll();
    await settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true, roleParent: true, allowWrites: true }, null);
    const user = (id, email, first, last, role) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', $4, $5, 'ALHAADIACADEMY', $6, true, true)`, [id, email, `${first} ${last}`, first, last, role]);
    await user(TEACHER_ID, 'ziad.muley@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MONA.userId, MONA.email, 'Mona', 'Haddad', 'PARENT');
    await user(OMAR.userId, OMAR.email, 'Omar', 'Saleh', 'PARENT');
    const yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`)).rows[0].school_year_id;
    const termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id) VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2027-06-30', TRUE, $1) RETURNING term_id`, [yearId])).rows[0].term_id;
    const classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id) VALUES ('ALHAADIACADEMY', '5', 'Math', 'Ziad Teacher', $1, $2, 'Term 1', $3) RETURNING class_id`,
      [TEACHER_ID, termId, yearId])).rows[0].class_id;
    const student = async (name) => (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, oen) VALUES ($1, '5', 'ALHAADIACADEMY', $2, '123456789') RETURNING student_id`, [name, yearId])).rows[0].student_id;
    amal = await student('Amal Haddad');
    rami = await student('Rami Saleh'); // Omar's child, never Mona's
    for (const id of [amal, rami]) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    await pool.query(`INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES ($1, $2, 'Mona Haddad', $3, 'Mother', 'ALHAADIACADEMY')`, [amal, MONA.userId, MONA.email]);
    await pool.query(`INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES ($1, $2, 'Omar Saleh', $3, 'Father', 'ALHAADIACADEMY')`, [rami, OMAR.userId, OMAR.email]);
    const quiz = (await pool.query(
      `INSERT INTO assessments (class_id, name, weight_points, max_score, is_parent, date, is_published, published_at) VALUES ($1, 'Fractions quiz', 10, 10, FALSE, DATE '2026-10-01', TRUE, NOW()) RETURNING assessment_id`, [classId])).rows[0].assessment_id;
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $3, 8), ($2, $3, 4)`, [amal, rami, quiz]);
    await pool.query(`INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES ($1, '2026-11-03', 'ABSENT', 'ALHAADIACADEMY'), ($1, '2026-11-04', 'LATE', 'ALHAADIACADEMY'), ($1, '2026-11-05', 'PRESENT', 'ALHAADIACADEMY')`, [amal]);
  });

  const script = (steps) => {
    const fake = fakeProvider(steps);
    provider.__setAdapterForTests(fake);
    return fake;
  };
  const turn = async (body, token = MONA) => {
    const res = await authenticatedRequest('post', '/api/assistant/turns', token).send(body);
    const events = res.status === 200 ? res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { res, events, of: (t) => events.filter((e) => e.t === t) };
  };
  const answerOf = (fake, id) => JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === id).content);

  it('is off for parents until the school switches parents on, and never offers changes', async () => {
    await settings.save('ALHAADIACADEMY', { roleParent: false }, null);
    expect((await authenticatedRequest('get', '/api/assistant/settings', MONA)).body.data.enabled).toBe(false);
    await settings.save('ALHAADIACADEMY', { roleParent: true }, null);
    const on = await authenticatedRequest('get', '/api/assistant/settings', MONA);
    expect(on.body.data).toMatchObject({ enabled: true, view: 'PARENT', capabilities: { writes: false } });
    expect((await authenticatedRequest('post', '/api/assistant/attachments', MONA).attach('file', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' })).body.code).toBe('WRITES_OFF');
  });

  it('answers from the parent\'s own children with the family tools only, through the enforcing gate', async () => {
    const fake = script([
      [toolCall('list_my_children', {}, 'kids')],
      [toolCall('get_child_grades', { child: 's1' }, 'grades')],
      [toolCall('get_child_attendance', { child: 's1', period: 'custom', from: '2026-11-02', to: '2026-11-06' }, 'days')],
      [text('Amal has 80% in Math; she was absent once and late once that week.')],
    ]);
    const { of } = await turn({ message: 'how is my daughter doing?' });

    const names = fake.calls[0].tools.map((t) => t.name);
    expect(names).toContain('list_my_children');
    expect(names).not.toContain('get_gradebook');
    expect(names).not.toContain('propose_scores');
    expect(fake.calls[0].system[0]).toContain('parent or guardian');

    expect(answerOf(fake, 'kids').children).toEqual([expect.objectContaining({ ref: 's1', name: 'Amal Haddad', grade: '5' })]);
    expect(answerOf(fake, 'grades').classes).toEqual([expect.objectContaining({ class: 'Math', grade: 80, missing: 0 })]);
    expect(answerOf(fake, 'days')).toMatchObject({ absent: 1, late: 1, absentOn: ['2026-11-03'], lateOn: ['2026-11-04'] });
    expect(of('card').find((c) => c.id === 'grades').card).toMatchObject({ type: 'table', title: 'Amal Haddad · this term' });

    // Nothing about another family's child, and no ids or education numbers.
    expect(fake.seen()).not.toContain('Rami');
    for (const id of [amal, rami]) expect(fake.seen()).not.toContain(id);
    expect(fake.seen()).not.toContain('123456789');
  });

  it('cannot name another family\'s child, even with a ref from elsewhere', async () => {
    const fake = script([[toolCall('get_child_grades', { child: 's1' }, 'nope')], [text('I need to look up your children first.')]]);
    await turn({ message: 'grades for s1' }, OMAR);
    expect(answerOf(fake, 'nope').error.code).toBe('UNKNOWN_REF');
  });

  it('shows a parent the parent portal\'s pages in the guide, and staff never do', async () => {
    const fake = script([[toolCall('find_feature', { query: 'message the teacher', class: null }, 'where')], [text('Messages.')]]);
    const { of } = await turn({ message: 'how do I message the teacher?' });
    expect(answerOf(fake, 'where').results[0]).toMatchObject({ title: 'Messages', canOpen: true });
    expect(of('card')[0].card).toEqual({ type: 'link', label: 'Open Messages', href: '/parent/messages' });

    const staff = script([[toolCall('find_feature', { query: 'parent teacher meeting book a time', class: null }, 'staffWhere')], [text('Meetings.')]]);
    await turn({ message: 'meetings?' }, { userId: TEACHER_ID, role: 'TEACHER', email: 'ziad.muley@example.com' });
    expect(answerOf(staff, 'staffWhere').results.map((r) => r.title)).not.toContain('Meetings');
  });
});
