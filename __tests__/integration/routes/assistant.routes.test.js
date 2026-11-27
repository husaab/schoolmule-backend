jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

// This file sends far more turns in a minute than a person would: lift the
// per-minute limit before the app (and its router) is built.
process.env.ASSISTANT_TURNS_PER_MINUTE = '10000';

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { fakeProvider, text, toolCall, usage } = require('../../helpers/fakeProvider');
const provider = require('../../../services/assistant/provider');
const dispatcher = require('../../../services/assistant/tools/dispatcher');
const settings = require('../../../services/assistant/settings');
const { ProviderError } = require('../../../services/assistant/errors');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000'; // authenticatedRequest's default: a full admin
const TEACHER_A = { userId: '550e8400-e29b-41d4-a716-446655440061', role: 'TEACHER', email: 'muley-a@test.com', username: 'Teacher A' };
const TEACHER_B = { userId: '550e8400-e29b-41d4-a716-446655440062', role: 'TEACHER', email: 'muley-b@test.com', username: 'Teacher B' };
const PARENT = { userId: '550e8400-e29b-41d4-a716-446655440063', role: 'PARENT', email: 'muley-p@test.com' };
const OEN = '123456789';

// Muley end to end: a real turn through the real routes and database, with a
// scripted model. What matters most here is what Muley can never do: read
// past the person's own access, be used in a preview, or show the model an
// education number.
describe('Muley: turns, tools and who it answers', () => {
  let pool, classId, otherClassId, studentIds;
  const env = { ...process.env };

  beforeAll(() => {
    getApp();
    pool = getTestPool();
    // Tools reach the backend's own routes: in tests, in-process.
    dispatcher.__setTransportForTests(async ({ method, path, headers }) => {
      const res = await request(getApp())[method.toLowerCase()](path).set(headers);
      return { status: res.status, body: res.body };
    });
  });
  afterAll(() => {
    dispatcher.__setTransportForTests(null);
    provider.__setAdapterForTests(null);
  });

  beforeEach(async () => {
    process.env.ASSISTANT_ENABLED = 'true';
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.AI_USER_DAILY_REQUESTS;
    settings.invalidateAll();

    const user = (u, role, first) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', $4, 'Tester', 'ALHAADIACADEMY', $5, true, true)`,
      [u.userId, u.email, u.email, first, role]);
    await user(TEACHER_A, 'TEACHER', 'Amina');
    await user(TEACHER_B, 'TEACHER', 'Bilal');
    await user(PARENT, 'PARENT', 'Pat');

    const { rows: [year] } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    const cls = async (teacher, subject) => (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '6', $2, 'T', $1, $3) RETURNING class_id`, [teacher.userId, subject, year.school_year_id])).rows[0].class_id;
    classId = await cls(TEACHER_A, 'Math');
    otherClassId = await cls(TEACHER_B, 'Science');

    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, oen, mother_email, mother_number) VALUES
         ('Sara Malik', '6', 'ALHAADIACADEMY', $1, $2, 'mum@example.com', '416-555-0100'),
         ('Yusuf Rahman', '6', 'ALHAADIACADEMY', $1, '987654321', 'r@example.com', NULL),
         ('Yusuf Siddiqui', '6', 'ALHAADIACADEMY', $1, NULL, NULL, NULL)
       RETURNING student_id, name`, [year.school_year_id, OEN]);
    studentIds = Object.fromEntries(rows.map((r) => [r.name, r.student_id]));
    for (const id of Object.values(studentIds)) {
      await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    }
    const { rows: [quiz] } = await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, is_parent, max_score, weight_points) VALUES ($1, 'Fractions quiz', 20, false, 20, 20) RETURNING assessment_id`, [classId]);
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $3, 18, 'graded'), ($2, $3, NULL, 'missing')`,
      [studentIds['Sara Malik'], studentIds['Yusuf Rahman'], quiz.assessment_id]);
    await pool.query(`INSERT INTO class_attendance (class_id, student_id, attendance_date, status) VALUES ($1, $2, '2026-11-26', 'LATE')`,
      [classId, studentIds['Sara Malik']]);
  });

  afterEach(() => {
    for (const key of ['ASSISTANT_ENABLED', 'OPENAI_API_KEY', 'AI_USER_DAILY_REQUESTS', 'PLATFORM_OWNER_EMAILS']) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  });

  const switchOn = (over = {}) => settings.save('ALHAADIACADEMY', { enabled: true, roleTeacher: true, roleAdmin: true, ...over }, null);
  const script = (steps) => {
    const fake = fakeProvider(steps);
    provider.__setAdapterForTests(fake);
    return fake;
  };
  const turn = async (body, token = TEACHER_A) => {
    const res = await authenticatedRequest('post', '/api/assistant/turns', token).send(body);
    const events = res.status === 200 && res.text ? res.text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    return { res, events, of: (t) => events.filter((e) => e.t === t), done: events.find((e) => e.t === 'done') };
  };
  const stored = async () => (await pool.query(`SELECT role, content, tool_calls, tool_name, display FROM assistant_messages ORDER BY seq`)).rows;

  describe('who it answers', () => {
    it('is off until a school is switched on, and says so quietly', async () => {
      const res = await authenticatedRequest('get', '/api/assistant/settings', TEACHER_A);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: false, reason: 'ASSISTANT_DISABLED' });
      expect((await turn({ message: 'hello' })).res.status).toBe(403);
    });

    it('is on for a view only when that view is switched on', async () => {
      await switchOn({ roleAdmin: false });
      expect((await authenticatedRequest('get', '/api/assistant/settings', TEACHER_A)).body.data).toMatchObject({ enabled: true, view: 'TEACHER', capabilities: { writes: false } });
      expect((await authenticatedRequest('get', '/api/assistant/settings')).body.data.enabled).toBe(false);
    });

    it('has a kill switch, on unless it is thrown', async () => {
      await switchOn();
      delete process.env.ASSISTANT_ENABLED;
      expect((await authenticatedRequest('get', '/api/assistant/settings', TEACHER_A)).body.data.enabled).toBe(true);
      process.env.ASSISTANT_ENABLED = 'false';
      expect((await authenticatedRequest('get', '/api/assistant/settings', TEACHER_A)).body.data.enabled).toBe(false);
      expect((await turn({ message: 'hello' })).res.body.code).toBe('ASSISTANT_DISABLED');
    });

    it('never answers in an admin preview, a parent or a student', async () => {
      await switchOn({ roleParent: true });
      const fake = script([[text('hi')]]);
      const preview = { ...TEACHER_A, impersonator: { userId: ADMIN_ID } };

      const asPreview = await turn({ message: 'hello' }, preview);
      expect(asPreview.res.status).toBe(403);
      expect(asPreview.res.body.code).toBe('IMPERSONATION_READ_ONLY');
      const previewList = await authenticatedRequest('get', '/api/assistant/conversations', preview);
      expect(previewList.body.code).toBe('ASSISTANT_OFF_IN_PREVIEW');
      expect((await authenticatedRequest('get', '/api/assistant/settings', preview)).body.data.enabled).toBe(false);

      const asParent = await turn({ message: 'hello' }, PARENT);
      expect(asParent.res.status).toBe(403);
      expect(asParent.res.body.code).toBe('ASSISTANT_NOT_AVAILABLE');

      const asStudent = await turn({ message: 'hello' }, { userId: '550e8400-e29b-41d4-a716-446655440064', role: 'STUDENT' });
      expect(asStudent.res.status).toBe(403);
      expect(asStudent.res.body.code).toBe('STUDENT_FORBIDDEN');
      expect(fake.calls).toHaveLength(0);
    });

    it('lets only the platform owner switch a school on', async () => {
      process.env.PLATFORM_OWNER_EMAILS = 'owner@schoolmule.test';
      const put = (token) => authenticatedRequest('put', '/api/assistant/platform/settings/ALHAADIACADEMY', token).send({ enabled: true, roleTeacher: true });

      expect((await put()).status).toBe(403); // a school's full admin is not the owner
      const saved = await put({ email: 'owner@schoolmule.test' });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toMatchObject({ enabled: true, roleTeacher: true, roleAdmin: false });
      expect((await authenticatedRequest('get', '/api/assistant/settings', TEACHER_A)).body.data.enabled).toBe(true);
      expect((await authenticatedRequest('put', '/api/assistant/platform/settings/NOSUCHSCHOOL', { email: 'owner@schoolmule.test' }).send({ enabled: true })).status).toBe(404);
    });

    it('lists every school with its switches and its last 30 days for the platform owner only', async () => {
      process.env.PLATFORM_OWNER_EMAILS = 'owner@schoolmule.test';
      await switchOn({ allowWrites: true });
      expect((await authenticatedRequest('get', '/api/assistant/platform/settings')).status).toBe(403);

      const res = await authenticatedRequest('get', '/api/assistant/platform/settings', { email: 'owner@schoolmule.test' });
      expect(res.status).toBe(200);
      expect(res.body.killSwitch).toBe(false);
      const bySchool = Object.fromEntries(res.body.data.map((s) => [s.school, s]));
      expect(bySchool.ALHAADIACADEMY).toMatchObject({
        settings: { enabled: true, roleTeacher: true, roleAdmin: true, allowWrites: true },
        lastThirtyDays: { conversations: 0, people: 0, changesSaved: 0 },
      });
      // A school that was never switched on is listed as off.
      const off = res.body.data.find((s) => s.school !== 'ALHAADIACADEMY');
      if (off) expect(off.settings).toMatchObject({ enabled: false, roleTeacher: false });
    });
  });

  describe('a turn', () => {
    beforeEach(() => switchOn());

    it('runs the tools the model asks for, streams what happens, and stores it', async () => {
      const fake = script([
        [toolCall('list_classes', {}, 'call_a')],
        [toolCall('get_class_roster', { class: 'c1' }, 'call_b')],
        [text('Math has three students: '), text('Sara, and two Yusufs.'), usage(900, 40, 600)],
      ]);

      const { res, events, of, done } = await turn({ message: 'Who is in my math class?' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
      expect(events[0]).toMatchObject({ t: 'start', v: 1 });
      expect(of('tool').map((e) => [e.id, e.state, e.label || e.summary])).toEqual([
        // A teacher's class list is the whole school's (names only), as on the Classes page.
        ['call_a', 'started', 'Looking up classes'], ['call_a', 'finished', '2 classes'],
        ['call_b', 'started', 'Reading the class list'], ['call_b', 'finished', '3 students in Math · Grade 6'],
      ]);
      expect(of('text').map((e) => e.d).join('')).toBe('Math has three students: Sara, and two Yusufs.');
      expect(done).toEqual({ t: 'done', reason: 'end' });
      expect(events.at(-1)).toBe(done);

      // The model saw names and refs, and was sent the tools and the static instructions first.
      const last = fake.calls.at(-1);
      expect(last.system[0]).toMatch(/^You are Muley/);
      expect(last.system[1]).toContain('Amina, a teacher');
      expect(last.tools.map((t) => t.name)).toContain('get_gradebook');
      const roster = JSON.parse(last.messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_b').content);
      expect(roster.students).toEqual([{ ref: 's1', name: 'Sara Malik' }, { ref: 's2', name: 'Yusuf Rahman' }, { ref: 's3', name: 'Yusuf Siddiqui' }]);

      // Stored: the person's words, each model step, each tool answer.
      expect((await stored()).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
      const { rows: [conversation] } = await pool.query(`SELECT title, refs, active_turn_id FROM assistant_conversations`);
      expect(conversation.title).toBe('Who is in my math class?');
      expect(conversation.refs.c1).toMatchObject({ kind: 'class', id: classId });
      expect(conversation.active_turn_id).toBeNull();
    });

    it('never shows the model an education number, a contact detail or an id', async () => {
      const fake = script([
        [toolCall('list_classes', {})],
        [toolCall('get_class_roster', { class: 'c1' }), toolCall('get_gradebook', { class: 'c1', assessment: null }), toolCall('get_class_attendance', { class: 'c1', date: '2026-11-26' })],
        [text('Done.')],
      ]);

      const { done } = await turn({ message: `Tell me about my class. Sara's OEN is ${OEN}, phone 416 555 0100.` });

      expect(done.reason).toBe('end');
      const seen = fake.seen();
      expect(seen).not.toContain(OEN);
      expect(seen).not.toContain('987654321');
      expect(seen).not.toContain('mum@example.com');
      expect(seen).not.toContain('416-555-0100');
      for (const id of [classId, ...Object.values(studentIds)]) expect(seen).not.toContain(id);
      // The person's own message is stored and sent with the number taken out.
      expect(seen).toContain("Sara's OEN is [removed]");
      const { rows: [{ leaked }] } = await pool.query(`SELECT count(*)::int AS leaked FROM assistant_messages WHERE content ~ '\\d{9}' OR tool_calls::text ~ '\\d{9}'`);
      expect(leaked).toBe(0);
    });

    it('reads marks and attendance as the app counts them', async () => {
      const fake = script([
        [toolCall('list_classes', {})],
        [toolCall('get_gradebook', { class: 'c1', assessment: null }, 'grades'), toolCall('get_class_attendance', { class: 'c1', date: '2026-11-26' }, 'att')],
        [text('ok')],
      ]);

      const { of } = await turn({ message: 'marks and attendance' });

      const answerOf = (id) => JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === id).content);
      const grades = answerOf('grades');
      expect(grades.assessments).toEqual([{ ref: 'a1', name: 'Fractions quiz', outOf: 20, category: false }]);
      expect(grades.students.map((s) => [s.name, s.marks.a1])).toEqual([['Sara Malik', 18], ['Yusuf Rahman', 'missing'], ['Yusuf Siddiqui', null]]);
      const attendance = answerOf('att');
      expect(attendance.counts).toEqual({ Late: 1, unmarked: 2 });
      expect(of('card')[0].card).toMatchObject({ type: 'table', title: 'Attendance · Math · Grade 6', tier: 'read' });
      expect(of('card')[0].card.rows[0]).toEqual({ name: 'Sara Malik', status: 'Late' });
    });

    it('reads exactly what the person could open themselves, and no more', async () => {
      // Teacher B doesn't teach Math. As in the app, a teacher can see every
      // class's name and roster (the Students permission), but a gradebook
      // only for a class they teach.
      const fake = script([
        [toolCall('list_classes', {}, 'list')],
        [toolCall('get_class_roster', { class: 'c1' }, 'roster'), toolCall('get_gradebook', { class: 'c1', assessment: null }, 'grades'),
          toolCall('get_class_attendance', { class: 'c1', date: '2026-11-26' }, 'att'), toolCall('get_gradebook', { class: classId, assessment: null }, 'raw'),
          toolCall('get_class_roster', { class: 'c7' }, 'guess')],
        [text('I can show you the Math roster, but not its marks.')],
      ]);

      const { done, of } = await turn({ message: 'show me the math class' }, TEACHER_B);

      expect(done.reason).toBe('end');
      const answerOf = (id) => JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === id).content);
      const listed = answerOf('list').classes;
      expect(listed.map((c) => [c.name, c.mine])).toEqual([['Science · Grade 6', true], ['Math · Grade 6', false]]);
      expect(answerOf('roster').students).toHaveLength(3);
      expect(answerOf('grades')).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: "This person's account doesn't have access to that." } });
      expect(answerOf('att').error.code).toBe('FORBIDDEN');
      expect(answerOf('raw').error.code).toBe('UNKNOWN_REF'); // a real id is not a ref
      expect(answerOf('guess').error.code).toBe('UNKNOWN_REF');
      expect(of('tool').filter((e) => e.state === 'finished').map((e) => e.ok)).toEqual([true, true, false, false, false, false]);
      expect(fake.seen()).not.toContain('Fractions quiz');
      expect(of('card')).toEqual([]);

      // The routes say the same to this person's own token: Muley added nothing and hid nothing.
      const direct = (path) => authenticatedRequest('get', path, TEACHER_B).then((r) => r.status);
      expect(await direct(`/api/classes/${classId}/students`)).toBe(200);
      expect(await direct(`/api/studentAssessments/classes/${classId}/scores`)).toBe(403);
      expect(await direct(`/api/attendance/class/${classId}?date=2026-11-26`)).toBe(403);
    });

    it('ignores a page the person cannot open', async () => {
      const fake = script([[text('ok')], [text('ok')], [text('ok')]]);
      await turn({ message: 'hi', pageContext: { classId: '550e8400-e29b-41d4-a716-4466554400ee' } });
      await turn({ message: 'hi', pageContext: { classId: 'not-an-id' } });
      await turn({ message: 'hi', pageContext: 'nonsense' });
      for (const call of fake.calls) expect(call.system[1]).not.toContain('looking at the class');
      const { of } = await (async () => { script([[text('ok')]]); return turn({ message: 'hi', pageContext: { classId: '550e8400-e29b-41d4-a716-4466554400ee' } }); })();
      expect(of('context')).toEqual([{ t: 'context', label: null }]);
    });

    it('knows the class on the page when the person can open it', async () => {
      const fake = script([[toolCall('get_class_roster', { class: 'c1' })], [text('Three.')], [text('Same.')]]);
      await turn({ message: 'how many students in this class?', pageContext: { classId, route: '/gradebook/x' } });
      expect(fake.calls[0].system[1]).toContain('They are looking at the class Math · Grade 6 right now. Its ref is c1.');
      const { of } = await turn({ message: 'and now?', pageContext: { classId } });
      expect(of('context')).toEqual([{ t: 'context', label: 'Math · Grade 6' }]);
      expect(JSON.parse(fake.calls[1].messages.at(-1).content).students).toHaveLength(3);
    });

    it('asks the person to choose, stops, and hears the choice as a ref', async () => {
      const fake = script([
        [toolCall('get_class_roster', { class: 'c1' })],
        [toolCall('ask_user_to_choose', { question: 'Which Yusuf?', options: [{ label: 'Yusuf Rahman', ref: 's2' }, { label: 'Yusuf Siddiqui', ref: 's3' }] }, 'ask')],
        [text('Yusuf Siddiqui it is.')],
      ]);

      const first = await turn({ message: 'how is Yusuf doing?', pageContext: { classId } });
      expect(first.done.reason).toBe('choices');
      expect(first.of('choices')[0]).toMatchObject({ id: 'ask', question: 'Which Yusuf?', options: [{ id: 'o1', label: 'Yusuf Rahman', ref: 's2' }, { id: 'o2', label: 'Yusuf Siddiqui', ref: 's3' }] });
      expect(fake.calls).toHaveLength(2);

      const conversationId = first.events[0].conversationId;
      const second = await turn({ message: 'Yusuf Siddiqui', conversationId, choice: { ref: 's3' } });
      expect(second.done.reason).toBe('end');
      const lastMessages = fake.calls.at(-1).messages;
      expect(lastMessages.at(-1)).toEqual({ role: 'event', content: 'The person chose "Yusuf Siddiqui" (ref s3).' });
      expect(lastMessages.at(-2)).toMatchObject({ role: 'user', content: 'Yusuf Siddiqui' });

      // A choice that was never offered is refused.
      const forged = await turn({ message: 'x', conversationId, choice: { ref: 's99' } });
      expect(forged.of('error')[0].code).toBe('invalid');
    });

    it('points to a page with a button, only for someone who can open it', async () => {
      const ask = async (token) => {
        const fake = script([[toolCall('find_feature', { query: 'report templates', class: null }, 'find')], [text('Here.')]]);
        const result = await turn({ message: 'where are the report templates?' }, token);
        return { ...result, answer: JSON.parse(fake.calls.at(-1).messages.at(-1).content) };
      };

      const teacher = await ask(TEACHER_A);
      expect(teacher.answer.results[0]).toMatchObject({ title: 'Report Templates', canOpen: false, whoCan: expect.stringContaining('administrator') });
      expect(teacher.of('card')).toEqual([]);

      const admin = await ask({}); // the default account: a full administrator
      expect(admin.answer.results[0]).toMatchObject({ title: 'Report Templates', canOpen: true });
      expect(admin.answer.results[0].steps.join(' ')).toContain('Admin Panel');
      expect(admin.of('card')[0].card).toEqual({ type: 'link', label: 'Open Report Templates', href: '/admin-panel/report-templates' });
    });

    it('opens the class\'s own page from the guide, without telling the model the id', async () => {
      const fake = script([[toolCall('find_feature', { query: 'omit a student from the class average', class: 'c1' })], [text('Steps.')]]);
      const { of } = await turn({ message: 'how do I omit a student from class average?', pageContext: { classId } });
      expect(of('card')[0].card).toEqual({ type: 'link', label: 'Open Leave a student out of the class average', href: `/classes/${classId}` });
      expect(fake.seen()).not.toContain(classId);
      expect(JSON.parse(fake.calls.at(-1).messages.at(-1).content).results[0].steps[1]).toContain('Who counts in the class average');
    });

    it('stops after a fixed number of model calls', async () => {
      const fake = script(Array.from({ length: 9 }, () => [toolCall('list_classes', {})]));
      const { done, of } = await turn({ message: 'loop forever' });
      expect(done.reason).toBe('limit');
      expect(of('error')[0]).toMatchObject({ code: 'limit', retryable: false });
      expect(fake.calls).toHaveLength(8);
    });

    it('says so when the model cannot be reached, and keeps the conversation usable', async () => {
      script([new ProviderError('overloaded', 'down', { status: 503, retryable: true }), new ProviderError('overloaded', 'down', { status: 503, retryable: true })]);
      const failedTurn = await turn({ message: 'hello' });
      expect(failedTurn.of('error')[0]).toMatchObject({ code: 'unavailable', retryable: true });
      expect(failedTurn.done.reason).toBe('error');

      script([[text('Back.')]]);
      const retry = await turn({ message: 'hello again', conversationId: failedTurn.events[0].conversationId });
      expect(retry.done.reason).toBe('end');
    });

    it('refuses an empty or oversized message and a second turn while one is running', async () => {
      script([[text('hi')]]);
      expect((await turn({ message: '   ' })).res.body.code).toBe('MESSAGE_REQUIRED');
      expect((await turn({ message: 'x'.repeat(4001) })).res.body.code).toBe('MESSAGE_TOO_LONG');

      const first = await turn({ message: 'hi' });
      const conversationId = first.events[0].conversationId;
      await pool.query(`UPDATE assistant_conversations SET active_turn_id = gen_random_uuid(), active_turn_started_at = NOW() WHERE conversation_id = $1`, [conversationId]);
      const busy = await turn({ message: 'again', conversationId });
      expect(busy.res.status).toBe(409);
      expect(busy.res.body.code).toBe('TURN_IN_PROGRESS');
    });

    it('counts usage and stops at the daily limit before the model is called', async () => {
      process.env.AI_USER_DAILY_REQUESTS = '1';
      const fake = script([[text('one'), usage(500, 30, 200)], [text('two')]]);

      expect((await turn({ message: 'first' })).done.reason).toBe('end');
      const { rows } = await pool.query(`SELECT feature, requests, input_tokens::int, cached_input_tokens::int, output_tokens::int FROM ai_usage_daily WHERE user_id = $1`, [TEACHER_A.userId]);
      expect(rows).toEqual([{ feature: 'assistant', requests: 1, input_tokens: 500, cached_input_tokens: 200, output_tokens: 30 }]);

      const second = await turn({ message: 'second' });
      expect(second.res.status).toBe(429);
      expect(second.res.body.code).toBe('AI_LIMIT_USER_DAILY');
      expect(fake.calls).toHaveLength(1);
    });
  });

  describe('conversations', () => {
    beforeEach(() => switchOn());

    it('are deleted once nobody has added to them for longer than the school keeps them', async () => {
      const { sweepOnce } = require('../../../services/assistant/retentionWorker');
      await settings.save('ALHAADIACADEMY', { transcriptRetentionDays: 30 }, null);
      const make = async (daysAgo) => (await pool.query(
        `INSERT INTO assistant_conversations (school, user_id, view, last_message_at) VALUES ('ALHAADIACADEMY', $1, 'TEACHER', NOW() - ($2 || ' days')::interval) RETURNING conversation_id`,
        [TEACHER_A.userId, daysAgo])).rows[0].conversation_id;
      const fresh = await make(29);
      const stale = await make(31);
      await pool.query(`INSERT INTO assistant_messages (conversation_id, seq, role, content) VALUES ($1, 1, 'user', 'old')`, [stale]);

      expect(await sweepOnce()).toBe(1);
      const { rows } = await pool.query(`SELECT conversation_id FROM assistant_conversations`);
      expect(rows.map((r) => r.conversation_id)).toEqual([fresh]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM assistant_messages`)).rows[0].n).toBe(0);
    });

    it('belong to one person: listed, reopened, renamed and deleted only by them', async () => {
      script([[toolCall('list_classes', {}, 'list')], [text('You teach Math.')]]);
      const { events } = await turn({ message: 'what do I teach?' });
      const id = events[0].conversationId;

      const mine = await authenticatedRequest('get', '/api/assistant/conversations', TEACHER_A);
      expect(mine.body.data).toEqual([expect.objectContaining({ id, title: 'what do I teach?' })]);

      const opened = await authenticatedRequest('get', `/api/assistant/conversations/${id}`, TEACHER_A);
      expect(opened.body.data.messages.map((m) => [m.role, m.text || m.summary])).toEqual([
        ['user', 'what do I teach?'], ['tool', '2 classes'], ['assistant', 'You teach Math.'],
      ]);

      // Someone else, and the same person in another conversation id, get nothing.
      expect((await authenticatedRequest('get', `/api/assistant/conversations/${id}`, TEACHER_B)).status).toBe(404);
      expect((await authenticatedRequest('get', '/api/assistant/conversations', TEACHER_B)).body.data).toEqual([]);
      expect((await authenticatedRequest('delete', `/api/assistant/conversations/${id}`, TEACHER_B)).status).toBe(404);
      script([[text('no')]]);
      expect((await turn({ message: 'continue', conversationId: id }, TEACHER_B)).res.status).toBe(404);
      expect((await authenticatedRequest('get', '/api/assistant/conversations/not-an-id', TEACHER_A)).status).toBe(404);

      const renamed = await authenticatedRequest('patch', `/api/assistant/conversations/${id}`, TEACHER_A).send({ title: 'My classes' });
      expect(renamed.body.data).toEqual({ id, title: 'My classes' });
      expect((await authenticatedRequest('delete', `/api/assistant/conversations/${id}`, TEACHER_A)).status).toBe(200);
      expect((await pool.query(`SELECT count(*)::int AS n FROM assistant_messages`)).rows[0].n).toBe(0);
    });
  });
});
