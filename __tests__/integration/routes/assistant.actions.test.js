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

const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440071', role: 'TEACHER', email: 'acts-a@test.com' };
const OTHER = { userId: '550e8400-e29b-41d4-a716-446655440072', role: 'TEACHER', email: 'acts-b@test.com' };
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Muley prepares a change; the person applies it, and can undo it. Nothing
// is written before Apply, Apply re-checks the data and the person's own
// access, and Undo puts back exactly what was there.
describe('Muley: preparing, applying and undoing changes', () => {
  let pool, classId, quizId, ids;

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
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Sara Malik', '6', 'ALHAADIACADEMY', $1), ('Yusuf Rahman', '6', 'ALHAADIACADEMY', $1), ('Yusuf Siddiqui', '6', 'ALHAADIACADEMY', $1)
       RETURNING student_id, name`, [year.school_year_id]);
    ids = Object.fromEntries(rows.map((r) => [r.name, r.student_id]));
    for (const id of Object.values(ids)) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    quizId = (await pool.query(
      `INSERT INTO assessments (class_id, name, weight_percent, is_parent, max_score, weight_points) VALUES ($1, 'Fractions quiz', 20, false, 20, 20) RETURNING assessment_id`, [classId])).rows[0].assessment_id;
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $3, 18, 'graded'), ($2, $3, NULL, 'missing')`,
      [ids['Sara Malik'], ids['Yusuf Rahman'], quizId]);
    await pool.query(`INSERT INTO class_attendance (class_id, student_id, attendance_date, status) VALUES ($1, $2, $3, 'LATE')`, [classId, ids['Sara Malik'], TODAY]);
  });

  const script = (steps) => {
    const fake = fakeProvider(steps);
    provider.__setAdapterForTests(fake);
    return fake;
  };
  const turn = async (body, token = TEACHER) => {
    const res = await authenticatedRequest('post', '/api/assistant/turns', token).send(body);
    const events = res.status === 200 ? res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { res, events, of: (t) => events.filter((e) => e.t === t) };
  };
  const attendance = async () => Object.fromEntries((await pool.query(
    `SELECT s.name, ca.status FROM class_attendance ca JOIN students s ON s.student_id = ca.student_id WHERE ca.class_id = $1 AND ca.attendance_date = $2`, [classId, TODAY])).rows.map((r) => [r.name, r.status]));
  const marks = async () => Object.fromEntries((await pool.query(
    `SELECT s.name, sa.score, sa.status FROM student_assessments sa JOIN students s ON s.student_id = sa.student_id WHERE sa.assessment_id = $1`, [quizId])).rows.map((r) => [r.name, `${r.score === null ? '-' : Number(r.score)}/${r.status}`]));
  const apply = (action, token = TEACHER, key) => {
    const req = authenticatedRequest('post', `/api/assistant/actions/${action.id}/apply`, token);
    if (key) req.set('Idempotency-Key', key);
    return req.send({ expectedHash: action.hash });
  };
  const undo = (action, token = TEACHER) => authenticatedRequest('post', `/api/assistant/actions/${action.id}/undo`, token).send({});

  const prepareAttendance = async () => {
    script([
      [toolCall('list_classes', {})],
      [toolCall('get_class_roster', { class: 'c1' })],
      [toolCall('propose_class_attendance', { class: 'c1', date: 'today', marks: [{ student: 's2', status: 'ABSENT' }], everyone_else: 'PRESENT', overwrite: false }, 'prop')],
      [text('Here is the change: press Save to keep it.')],
    ]);
    return turn({ message: 'everyone is here except Yusuf Rahman' });
  };

  it('lets a browser send the Idempotency-Key that Save and Undo carry', async () => {
    const res = await request(getApp())
      .options('/api/assistant/actions/any/apply')
      .set('Origin', process.env.CROSS_ORIGIN_URL)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization,idempotency-key');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('idempotency-key');
  });

  it('prepares attendance without writing it, and saves it only on Apply', async () => {
    const { of } = await prepareAttendance();

    const [{ action }] = of('action');
    expect(action).toMatchObject({ kind: 'class_attendance', status: 'pending', applyLabel: 'Save 2 marks', topics: [`attendance:class:${classId}:${TODAY}`] });
    const card = of('card').find((e) => e.card.type === 'change').card;
    expect(card).toMatchObject({ type: 'change', actionId: action.id, title: 'Class attendance · Math · Grade 6', subtitle: TODAY, note: '1 student keeps their mark.' });
    expect(card.rows).toEqual([{ name: 'Yusuf Rahman', now: 'unmarked', next: 'Absent' }, { name: 'Yusuf Siddiqui', now: 'unmarked', next: 'Present' }]);
    expect(card.tally).toEqual(expect.arrayContaining([{ label: 'Late', count: 1 }, { label: 'Absent', count: 1 }, { label: 'Present', count: 1 }]));
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE' }); // nothing written yet

    const applied = await apply(action);
    expect(applied.status).toBe(200);
    expect(applied.body.data).toMatchObject({ status: 'applied', doneLabel: 'Saved 2 marks', canUndo: true });
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE', 'Yusuf Rahman': 'ABSENT', 'Yusuf Siddiqui': 'PRESENT' });

    const { rows: [log] } = await pool.query(`SELECT source, action, summary, changes FROM audit_log WHERE assistant_action_id = $1`, [action.id]);
    expect(log).toMatchObject({ source: 'assistant', action: 'assistant.class_attendance.apply', summary: `Class attendance · Math · Grade 6 · ${TODAY}` });
    expect(log.changes.map((c) => [c.label, c.before, c.after])).toEqual(expect.arrayContaining([['Yusuf Rahman', null, 'ABSENT'], ['Yusuf Siddiqui', null, 'PRESENT']]));
    const { rows: events } = await pool.query(`SELECT content FROM assistant_messages WHERE role = 'event'`);
    expect(events.map((e) => e.content)).toEqual([expect.stringContaining('pressed Save')]);

    const undone = await undo(action);
    expect(undone.status).toBe(200);
    expect(undone.body.data.status).toBe('undone');
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE' }); // the two new marks are gone again
  });

  it('applies once, whatever the clicks', async () => {
    const { of } = await prepareAttendance();
    const [{ action }] = of('action');
    expect((await apply(action, TEACHER, 'key-1')).status).toBe(200);
    expect((await apply(action, TEACHER, 'key-1')).status).toBe(200);
    expect((await apply(action, TEACHER, 'key-2')).body.code).toBe('ALREADY_APPLIED');
    expect((await apply({ ...action, hash: 'tampered' })).status).toBe(409);
  });

  it('saves nothing when a mark changed after the preview, and says which', async () => {
    const { of } = await prepareAttendance();
    const [{ action }] = of('action');
    await pool.query(`INSERT INTO class_attendance (class_id, student_id, attendance_date, status) VALUES ($1, $2, $3, 'LATE')`, [classId, ids['Yusuf Siddiqui'], TODAY]);

    const res = await apply(action);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'STALE', data: { conflicts: [{ name: 'Yusuf Siddiqui', was: 'unmarked', now: 'Late' }] } });
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE', 'Yusuf Siddiqui': 'LATE' });
    const { rows: [row] } = await pool.query(`SELECT status FROM assistant_actions WHERE action_id = $1`, [action.id]);
    expect(row.status).toBe('pending');
  });

  it('leaves a mark changed again after the save alone when undoing', async () => {
    const { of } = await prepareAttendance();
    const [{ action }] = of('action');
    await apply(action);
    await pool.query(`UPDATE class_attendance SET status = 'LATE' WHERE class_id = $1 AND student_id = $2 AND attendance_date = $3`, [classId, ids['Yusuf Rahman'], TODAY]);

    const res = await undo(action);
    expect(res.status).toBe(409);
    expect(res.body.data.conflicts).toEqual([{ name: 'Yusuf Rahman', was: 'Absent', now: 'Late' }]);
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE', 'Yusuf Rahman': 'LATE', 'Yusuf Siddiqui': 'PRESENT' });
  });

  it('is applied only by the person it was shown to, with their access at that moment, and never in a preview', async () => {
    const { of } = await prepareAttendance();
    const [{ action }] = of('action');

    expect((await apply(action, OTHER)).status).toBe(404);
    expect((await apply(action, { ...TEACHER, impersonator: { userId: OTHER.userId } })).body.code).toBe('IMPERSONATION_READ_ONLY');

    // The class is handed to someone else before Apply: the route refuses, nothing is written.
    await pool.query(`UPDATE classes SET teacher_id = $2 WHERE class_id = $1`, [classId, OTHER.userId]);
    const refused = await apply(action);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE' });
    const { rows: [row] } = await pool.query(`SELECT status, error_code FROM assistant_actions WHERE action_id = $1`, [action.id]);
    expect(row).toEqual({ status: 'pending', error_code: 'FORBIDDEN' });
  });

  it('can be dismissed, and then not applied; an old preview expires', async () => {
    const first = await prepareAttendance();
    const [{ action }] = first.of('action');
    const dismissed = await authenticatedRequest('post', `/api/assistant/actions/${action.id}/dismiss`, TEACHER).send({});
    expect(dismissed.body.data.status).toBe('rejected');
    expect((await apply(action)).body.code).toBe('NOT_PENDING');

    const second = await prepareAttendance();
    const [{ action: later }] = second.of('action');
    await pool.query(`UPDATE assistant_actions SET expires_at = NOW() - INTERVAL '1 minute' WHERE action_id = $1`, [later.id]);
    expect((await apply(later)).status).toBe(410);
    expect(await attendance()).toEqual({ 'Sara Malik': 'LATE' });
  });

  it('enters marks: a score, excused and blank, then puts them back exactly', async () => {
    script([
      [toolCall('list_classes', {})],
      [toolCall('get_gradebook', { class: 'c1', assessment: null })],
      [toolCall('propose_scores', { class: 'c1', assessment: 'a1', entries: [
        { student: 's1', score: 19, status: 'graded' },
        { student: 's2', score: null, status: 'excused' },
        { student: 's3', score: 15.5, status: 'graded' },
      ] }, 'prop')],
      [text('Ready.')],
    ]);
    const { of } = await turn({ message: 'quiz: Sara 19, Yusuf S 15.5, excuse Yusuf R' });
    const [{ action }] = of('action');
    const card = of('card').find((e) => e.card.type === 'change').card;
    expect(card.title).toBe('Fractions quiz · out of 20');
    expect(card.rows).toEqual([
      { name: 'Sara Malik', now: '18 / 20', next: '19 / 20' },
      { name: 'Yusuf Rahman', now: 'Missing', next: 'Excused' },
      { name: 'Yusuf Siddiqui', now: 'blank', next: '15.5 / 20' },
    ]);
    expect(card.note).toMatch(/Not published yet/);
    expect(await marks()).toEqual({ 'Sara Malik': '18/graded', 'Yusuf Rahman': '-/missing' });

    expect((await apply(action)).body.data.status).toBe('applied');
    expect(await marks()).toEqual({ 'Sara Malik': '19/graded', 'Yusuf Rahman': '-/excused', 'Yusuf Siddiqui': '15.5/graded' });

    expect((await undo(action)).body.data.status).toBe('undone');
    expect(await marks()).toEqual({ 'Sara Malik': '18/graded', 'Yusuf Rahman': '-/missing', 'Yusuf Siddiqui': '-/graded' });
  });

  it('refuses a mark the assessment cannot take, a future day and a student of another class, preparing nothing', async () => {
    const fake = script([
      [toolCall('list_classes', {})],
      [toolCall('get_gradebook', { class: 'c1', assessment: null }), toolCall('get_class_roster', { class: 'c1' })],
      [toolCall('propose_scores', { class: 'c1', assessment: 'a1', entries: [{ student: 's1', score: 25, status: 'graded' }] }, 'high'),
        toolCall('propose_class_attendance', { class: 'c1', date: '2999-01-01', marks: [], everyone_else: 'PRESENT', overwrite: false }, 'future')],
      [text('Sorry.')],
    ]);
    await turn({ message: 'try bad things' });
    const answerOf = (id) => JSON.parse(fake.calls.at(-1).messages.find((m) => m.toolCallId === id).content);
    expect(answerOf('high').error).toMatchObject({ code: 'INVALID_SCORE', message: expect.stringContaining('out of 20') });
    expect(answerOf('future').error.code).toBe('FUTURE_DATE');
    expect((await pool.query(`SELECT count(*)::int AS n FROM assistant_actions`)).rows[0].n).toBe(0);
  });

  it('offers no change tools, and refuses Apply, where the school has not switched changes on', async () => {
    const { of } = await prepareAttendance();
    const [{ action }] = of('action');
    await settings.save('ALHAADIACADEMY', { allowWrites: false }, null);

    const fake = script([[text('I can only read here.')]]);
    await turn({ message: 'mark everyone present' });
    expect(fake.calls[0].tools.map((t) => t.name)).not.toContain('propose_class_attendance');
    expect(fake.calls[0].system[1]).toContain('has not switched on preparing changes');
    expect((await apply(action)).body.code).toBe('WRITES_OFF');
    expect((await authenticatedRequest('get', '/api/assistant/settings', TEACHER)).body.data.capabilities).toEqual({ writes: false });
  });

  it('brings a conversation back with its changes and where each stands', async () => {
    const { events, of } = await prepareAttendance();
    const [{ action }] = of('action');
    await apply(action);
    const opened = await authenticatedRequest('get', `/api/assistant/conversations/${events[0].conversationId}`, TEACHER);
    expect(opened.body.data.actions).toEqual([expect.objectContaining({ id: action.id, status: 'applied' })]);
    const tool = opened.body.data.messages.find((m) => m.role === 'tool' && m.card && m.card.type === 'change');
    expect(tool.card.actionId).toBe(action.id);
  });

  describe('who counts in the class average', () => {
    const exclusions = async () => Object.fromEntries((await pool.query(
      `SELECT s.name, array_agg(COALESCE(e.assessment_id::text, 'class') ORDER BY e.assessment_id) AS what, max(e.note) AS note
       FROM class_stats_exclusions e JOIN students s ON s.student_id = e.student_id WHERE e.class_id = $1 GROUP BY s.name`, [classId])).rows
      .map((r) => [r.name, { what: r.what, note: r.note }]));

    beforeEach(async () => {
      // Yusuf Rahman is already left out of the quiz's class average, with a note.
      await pool.query(`INSERT INTO class_stats_exclusions (class_id, student_id, assessment_id, note, created_by) VALUES ($1, $2, $3, 'IEP', $4)`,
        [classId, ids['Yusuf Rahman'], quizId, TEACHER.userId]);
    });

    const prepare = async (entries, note = null) => {
      script([
        [toolCall('list_classes', {})],
        [toolCall('get_class_roster', { class: 'c1' })],
        [toolCall('get_gradebook', { class: 'c1', assessment: null })],
        [toolCall('propose_class_average_exclusion', { class: 'c1', entries, note }, 'avg')],
        [text('Ready: press Save.')],
      ]);
      return turn({ message: 'leave Sara out of the class average' });
    };

    it('prepares leaving a student out, saves it on Save, and Undo puts back exactly what was there', async () => {
      // Refs from the roster: Sara is s1, Yusuf Rahman s2; the quiz is a1.
      const { of } = await prepare([{ student: 's1', counted: false, assessment: null }, { student: 's2', counted: false, assessment: null }], 'Joined late');
      const [{ action }] = of('action');
      expect(action).toMatchObject({ kind: 'stats_exclusion', applyLabel: 'Save 2 changes', topics: [`stats-exclusions:${classId}`] });
      const card = of('card').find((c) => c.card.type === 'change').card;
      expect(card.rows).toEqual([
        { name: 'Sara Malik', now: 'Counted', next: 'Left out' },
        { name: 'Yusuf Rahman', now: 'Left out of 1 assessment', next: 'Left out' },
      ]);
      // Nothing is written before Save.
      expect(await exclusions()).toEqual({ 'Yusuf Rahman': { what: [quizId], note: 'IEP' } });

      const saved = await apply(action);
      expect(saved.status).toBe(200);
      expect(saved.body.data).toMatchObject({ status: 'applied', doneLabel: 'Saved 2 changes' });
      expect(await exclusions()).toEqual({
        'Sara Malik': { what: ['class'], note: 'Joined late' },
        'Yusuf Rahman': { what: ['class'], note: 'Joined late' },
      });

      const undone = await undo(action);
      expect(undone.body.data).toMatchObject({ status: 'undone', undoneLabel: 'Undone. 2 changes put back as they were.' });
      expect(await exclusions()).toEqual({ 'Yusuf Rahman': { what: [quizId], note: 'IEP' } });
    });

    it('counts a student again for one assessment, which counts them everywhere when it was the only one', async () => {
      const { of } = await prepare([{ student: 's2', counted: true, assessment: 'a1' }]);
      const [{ action }] = of('action');
      expect(of('card').find((c) => c.card.type === 'change').card.rows).toEqual([{ name: 'Yusuf Rahman', now: 'Left out of 1 assessment', next: 'Counted' }]);
      expect((await apply(action)).body.data.doneLabel).toBe('Saved 1 change');
      expect(await exclusions()).toEqual({});
      expect((await undo(action)).body.data.undoneLabel).toBe('Undone. 1 change put back as it was.');
      expect(await exclusions()).toEqual({ 'Yusuf Rahman': { what: [quizId], note: 'IEP' } });
    });

    it('prepares nothing when everyone already counts as asked', async () => {
      const { of } = await prepare([{ student: 's1', counted: true, assessment: null }]);
      expect(of('action')).toEqual([]);
      expect(of('tool').find((e) => e.id === 'avg' && e.state === 'finished')).toMatchObject({ ok: true, summary: 'Nothing to change' });
      expect((await pool.query(`SELECT count(*)::int AS n FROM assistant_actions`)).rows[0].n).toBe(0);
    });

    it('says in the guide that Muley can do it, where the school allows changes', async () => {
      const fake = script([[toolCall('find_feature', { query: 'omit a student from the class average', class: null })], [text('Steps.')]]);
      await turn({ message: 'how do I omit a student from class average?' });
      expect(JSON.parse(fake.calls.at(-1).messages.at(-1).content).results[0].muleyCanHelpWith).toBe('propose_class_average_exclusion');

      await settings.save('ALHAADIACADEMY', { allowWrites: false }, null);
      const readOnly = script([[toolCall('find_feature', { query: 'omit a student from the class average', class: null })], [text('Steps.')]]);
      await turn({ message: 'how do I omit a student from class average?' });
      expect(JSON.parse(readOnly.calls.at(-1).messages.at(-1).content).results[0].muleyCanHelpWith).toBeNull();
    });
  });
});
