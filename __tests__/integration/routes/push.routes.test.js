// Push notifications against the real schema: every push query plans, the
// device and preference routes, a message reaching the other parent's phone
// (and not a muted one), and the queue sending through a stubbed Expo.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const q = require('../../../queries/push.queries');
const pushQueue = require('../../../services/push/pushQueue');
const pushEvents = require('../../../services/push/pushEvents');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOM_ID = '550e8400-e29b-41d4-a716-446655440002';
const DAD_ID = '550e8400-e29b-41d4-a716-446655440004';
const asTeacher = { userId: TEACHER_ID, username: 'Teacher One', email: 'teacher@example.test', role: 'TEACHER' };
const asMom = { userId: MOM_ID, username: 'Mom Test', email: 'mom@example.test', role: 'PARENT' };
const asDad = { userId: DAD_ID, username: 'Dad Test', email: 'dad@example.test', role: 'PARENT' };

const MOM_TOKEN = 'ExponentPushToken[mom-device-0001]';
const DAD_TOKEN = 'ExponentPushToken[dad-device-0001]';
const STUDENT_ID = '550e8400-e29b-41d4-a716-446655440010';
const STUDENT_TOKEN = 'ExponentPushToken[student-device-1]';
const ID = '550e8400-e29b-41d4-a716-4466554400ff';
const NOW = new Date().toISOString();

// Parameters that let each statement plan (EXPLAIN never runs it).
const PARAMS = {
  upsertDevice: [MOM_TOKEN, ID, 'ios', '1.0.0'],
  deleteDevice: [ID, MOM_TOKEN],
  deleteTokens: [[MOM_TOKEN]],
  countDevices: [ID],
  pruneStaleDevices: [],
  selectPrefs: [ID],
  upsertPrefs: [ID, true, null, null, null, false],
  insertJobs: ['[]'],
  selectMessageTargets: [ID, [ID]],
  selectLatestMessage: [ID, ID],
  selectAnnouncementTargets: [ID],
  enqueueNewWork: [[ID], NOW, NOW],
  selectItemVisible: [ID, ID, NOW],
  enqueueGraded: [[ID], 'ALHAADIACADEMY', 'graded:key', NOW],
  enqueueGradedColumns: [[ID], 'ALHAADIACADEMY', 'graded:key', NOW],
  enqueueDueReminders: [NOW, '2026-10-26'],
  selectUserByEmail: ['office@example.test', 'ALHAADIACADEMY'],
  claimDue: [10],
  selectTargets: [[ID]],
  finishSent: [[ID]],
  finishSkipped: [[ID], 'no device'],
  retryOrFail: [[ID], 'timeout', 3],
  insertTickets: ['[]'],
  selectDueTickets: [],
  deleteTickets: [['ticket']],
  purgeTickets: [],
  purgeJobs: [],
};

describe('Integration: push notifications', () => {
  let pool;
  let yearId, classId, studentId, assessmentId;

  beforeAll(() => { getApp(); pool = getTestPool(); });
  afterEach(() => { delete global.fetch; pushQueue.resetState(); });

  const user = (id, email, username, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, username, username.split(' ')[0], username.split(' ')[1], role],
  );
  const device = (userId, token) => pool.query(
    "INSERT INTO push_devices (token, user_id, platform) VALUES ($1, $2, 'ios')", [token, userId]);

  beforeEach(async () => {
    const y = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`);
    yearId = y.rows[0].school_year_id;
    await user(TEACHER_ID, 'teacher@example.test', 'Teacher One', 'TEACHER');
    await user(MOM_ID, 'mom@example.test', 'Mom Test', 'PARENT');
    await user(DAD_ID, 'dad@example.test', 'Dad Test', 'PARENT');
    const c = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '6', 'Math', 'Teacher One', $1, $2) RETURNING class_id`, [TEACHER_ID, yearId]);
    classId = c.rows[0].class_id;
    const s = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amina Test', '6', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId]);
    studentId = s.rows[0].student_id;
    await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES
       ($1, $2, 'Mom Test', 'mom@example.test', 'Mother', 'ALHAADIACADEMY'),
       ($1, $3, 'Dad Test', 'dad@example.test', 'Father', 'ALHAADIACADEMY')`, [studentId, MOM_ID, DAD_ID]);
    const a = await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, weight_points, is_published, published_at)
       VALUES ($1, 'Unit 3 Quiz', 20, 10, TRUE, NOW()) RETURNING assessment_id`, [classId]);
    assessmentId = a.rows[0].assessment_id;
  });

  it.each(Object.keys(PARAMS))('plans %s against the real schema', async (name) => {
    await expect(pool.query(`EXPLAIN ${q[name]}`, PARAMS[name])).resolves.toBeTruthy();
  });

  it('lists a statement for every query the module exports', () => {
    const statements = Object.entries(q).filter(([, v]) => typeof v === 'string').map(([k]) => k).sort();
    expect(statements).toEqual(Object.keys(PARAMS).sort());
  });

  describe('devices and preferences', () => {
    it('registers a phone, moves it to whoever signs in next, and only its owner can remove it', async () => {
      const put = await authenticatedRequest('put', '/api/profile/push-device', asMom).send({ token: MOM_TOKEN, platform: 'ios', appVersion: '1.0.0' });
      expect(put.status).toBe(200);
      let { rows } = await pool.query('SELECT user_id FROM push_devices WHERE token = $1', [MOM_TOKEN]);
      expect(rows[0].user_id).toBe(MOM_ID);

      await authenticatedRequest('put', '/api/profile/push-device', asDad).send({ token: MOM_TOKEN, platform: 'ios' });
      ({ rows } = await pool.query('SELECT user_id FROM push_devices WHERE token = $1', [MOM_TOKEN]));
      expect(rows[0].user_id).toBe(DAD_ID);

      // Mom's stale sign-out call from before changes nothing now.
      await authenticatedRequest('post', '/api/profile/push-device/remove', asMom).send({ token: MOM_TOKEN });
      ({ rows } = await pool.query('SELECT 1 FROM push_devices WHERE token = $1', [MOM_TOKEN]));
      expect(rows).toHaveLength(1);

      await authenticatedRequest('post', '/api/profile/push-device/remove', asDad).send({ token: MOM_TOKEN });
      ({ rows } = await pool.query('SELECT 1 FROM push_devices WHERE token = $1', [MOM_TOKEN]));
      expect(rows).toHaveLength(0);
    });

    it('refuses something that is not an Expo push token', async () => {
      const res = await authenticatedRequest('put', '/api/profile/push-device', asMom).send({ token: 'https://evil.example', platform: 'ios' });
      expect(res.status).toBe(400);
    });

    it("shows a parent's categories, all on, and saves a change", async () => {
      const get = await authenticatedRequest('get', '/api/profile/push-preferences', asMom);
      expect(get.status).toBe(200);
      expect(get.body.data.categories.map((c) => c.key)).toEqual(['messages', 'announcements', 'grades', 'reminders']);
      expect(get.body.data.categories.every((c) => c.enabled)).toBe(true);

      const put = await authenticatedRequest('put', '/api/profile/push-preferences', asMom).send({ grades: false });
      expect(put.status).toBe(200);
      expect(put.body.data.categories.find((c) => c.key === 'grades').enabled).toBe(false);
      expect(put.body.data.categories.find((c) => c.key === 'messages').enabled).toBe(true);
    });

    it("refuses a category that isn't the caller's", async () => {
      const res = await authenticatedRequest('put', '/api/profile/push-preferences', asTeacher).send({ classwork: false });
      expect(res.status).toBe(400);
    });
  });

  describe('a message', () => {
    const send = (body = 'Amina did great on her quiz today') =>
      authenticatedRequest('post', '/api/messaging/conversations', asTeacher)
        .field('studentId', studentId).field('classId', classId).field('assessmentId', assessmentId).field('body', body);

    it("reaches each parent's phone at once, opening the thread", async () => {
      await device(MOM_ID, MOM_TOKEN);
      await device(DAD_ID, DAD_TOKEN);

      const res = await send();
      expect(res.status).toBe(201);
      const conversationId = res.body.data.conversationId || res.body.data.conversation?.conversationId;

      const { rows } = await pool.query('SELECT * FROM push_jobs ORDER BY recipient_id');
      expect(rows.map((r) => r.recipient_id).sort()).toEqual([MOM_ID, DAD_ID].sort());
      expect(rows[0]).toMatchObject({
        kind: 'message',
        category: 'messages',
        title: 'Teacher One',
        body: 'Amina did great on her quiz today',
        status: 'pending',
      });
      expect(rows[0].subtitle).toMatch(/^Amina · /);
      expect(rows[0].path).toMatch(/^\/parent\/messages\?thread=/);
      if (conversationId) expect(rows[0].path).toBe(`/parent/messages?thread=${conversationId}`);
    });

    it('skips a parent without the app, and one who muted the thread', async () => {
      await device(MOM_ID, MOM_TOKEN);
      const first = await send('First');
      const { rows: [job] } = await pool.query('SELECT path FROM push_jobs');
      const conversationId = new URLSearchParams(job.path.split('?')[1]).get('thread');
      await pool.query(
        `INSERT INTO conversation_participants (conversation_id, user_id, muted) VALUES ($1, $2, TRUE)
         ON CONFLICT (conversation_id, user_id) DO UPDATE SET muted = TRUE`, [conversationId, MOM_ID]);
      await pool.query('DELETE FROM push_jobs');
      expect(first.status).toBe(201);

      await send('Second');
      const { rows } = await pool.query('SELECT 1 FROM push_jobs');
      expect(rows).toHaveLength(0);
    });
  });

  describe('a student with the app', () => {
    // Amina's own login: classrooms on, consent given, this year's link.
    // student_email_from_grade is off: the app still reaches her.
    beforeEach(async () => {
      await user(STUDENT_ID, 'amina@students.example.test', 'Amina Test', 'STUDENT');
      await pool.query(
        `INSERT INTO school_classroom_settings (school, enabled, login_from_grade, student_email_from_grade)
         VALUES ('ALHAADIACADEMY', TRUE, '1', NULL)
         ON CONFLICT (school) DO UPDATE SET enabled = TRUE, login_from_grade = '1', student_email_from_grade = NULL`);
      await pool.query('INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)', [STUDENT_ID, studentId, yearId]);
      await pool.query("INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())", [STUDENT_ID]);
      await device(STUDENT_ID, STUDENT_TOKEN);
    });

    const jobsFor = async (userId) => (await pool.query('SELECT * FROM push_jobs WHERE recipient_id = $1', [userId])).rows;

    it('hears about new classwork 2 minutes after it is posted', async () => {
      const { rows: [item] } = await pool.query(
        "INSERT INTO classwork_items (class_id, kind, title, status) VALUES ($1, 'assignment', 'Fractions worksheet', 'posted') RETURNING item_id",
        [classId]);
      await pushEvents.onNewWork([item.item_id]);
      const [job] = await jobsFor(STUDENT_ID);
      expect(job).toMatchObject({ kind: 'new_work', category: 'classwork', title: 'New assignment', subtitle: 'Math', body: 'Fractions worksheet', path: `/student/items/${item.item_id}` });
      expect(new Date(job.send_after).getTime()).toBeGreaterThan(Date.now() + 60_000);
    });

    it('gets one notification per 15 minutes of published grades', async () => {
      const now = new Date();
      await pushEvents.onGraded({ school: 'ALHAADIACADEMY', studentIds: [studentId], now });
      await pushEvents.onGraded({ school: 'ALHAADIACADEMY', studentIds: [studentId], now });
      const jobs = await jobsFor(STUDENT_ID);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: 'graded', path: '/student/grades', merged: 2 });
    });

    it('hears about a class announcement on the class page, and its parents on theirs', async () => {
      await device(MOM_ID, MOM_TOKEN);
      const { rows: [ann] } = await pool.query(
        `INSERT INTO announcements (school, scope, class_id, title, body, author_id, author_role)
         VALUES ('ALHAADIACADEMY', 'class', $1, 'Field trip Friday', '<p>Bring a <b>lunch</b>.</p>', $2, 'TEACHER') RETURNING announcement_id`,
        [classId, TEACHER_ID]);
      await pushEvents.onAnnouncement(ann.announcement_id);
      const [student] = await jobsFor(STUDENT_ID);
      const [mom] = await jobsFor(MOM_ID);
      expect(student).toMatchObject({ title: 'Field trip Friday', body: 'Bring a lunch.', path: `/student/classes/${classId}?announcement=${ann.announcement_id}` });
      expect(mom.path).toBe(`/parent/messages?tab=announcements&announcement=${ann.announcement_id}`);
      expect(await jobsFor(TEACHER_ID)).toHaveLength(0);
    });

    it('hears nothing once the school turns student sign-in off', async () => {
      await pool.query("UPDATE school_classroom_settings SET enabled = FALSE WHERE school = 'ALHAADIACADEMY'");
      await pushEvents.onGraded({ school: 'ALHAADIACADEMY', studentIds: [studentId] });
      expect(await jobsFor(STUDENT_ID)).toHaveLength(0);
    });
  });

  describe('sending', () => {
    it('sends due rows to every device, keeps the tickets, and forgets a phone without the app', async () => {
      await device(MOM_ID, MOM_TOKEN);
      await device(MOM_ID, DAD_TOKEN);
      await pushQueue.enqueue([{
        recipientId: MOM_ID, kind: 'message', category: 'messages', dedupeKey: 'msg:1',
        title: 'Teacher One', body: 'Hello', path: '/parent/messages?thread=abc', threadKey: 'conv:abc',
      }]);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] }),
      });

      const claimed = await pushQueue.drainOnce();

      expect(claimed).toBe(1);
      const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ title: 'Teacher One', body: 'Hello', channelId: 'messages', threadId: 'conv:abc', data: { path: '/parent/messages?thread=abc' } });
      const { rows: [job] } = await pool.query('SELECT status FROM push_jobs');
      expect(job.status).toBe('sent');
      const { rows: devices } = await pool.query('SELECT token FROM push_devices');
      expect(devices).toHaveLength(1);
      const { rows: tickets } = await pool.query('SELECT ticket_id FROM push_tickets');
      expect(tickets.map((t) => t.ticket_id)).toEqual(['ticket-1']);
    });

    it('skips a category the person switched off, and never queues a web address', async () => {
      await device(MOM_ID, MOM_TOKEN);
      await pool.query('INSERT INTO push_preferences (user_id, grades) VALUES ($1, FALSE)', [MOM_ID]);
      const queued = await pushQueue.enqueue([
        { recipientId: MOM_ID, kind: 'grades_digest', category: 'grades', dedupeKey: 'g:1', title: 'New grades posted', body: 'Amina has new grades.', path: '/parent/grades' },
        { recipientId: MOM_ID, kind: 'grades_digest', category: 'grades', dedupeKey: 'g:2', title: 'x', body: 'y', path: 'https://evil.example/' },
      ]);
      expect(queued).toBe(1);
      global.fetch = jest.fn();

      await pushQueue.drainOnce();

      expect(global.fetch).not.toHaveBeenCalled();
      const { rows: [job] } = await pool.query('SELECT status, last_error FROM push_jobs');
      expect(job).toEqual({ status: 'skipped', last_error: 'switched off' });
    });

    it('retries when Expo does not answer', async () => {
      await device(MOM_ID, MOM_TOKEN);
      await pushQueue.enqueue([{ recipientId: MOM_ID, kind: 'message', category: 'messages', dedupeKey: 'msg:2', title: 'T', body: 'B', path: '/parent/messages' }]);
      global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up'));

      await pushQueue.drainOnce();

      const { rows: [job] } = await pool.query('SELECT status, attempts, last_error FROM push_jobs');
      expect(job).toMatchObject({ status: 'pending', attempts: 1 });
      expect(job.last_error).toMatch(/socket hang up/);
    });
  });
});
