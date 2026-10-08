jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })) }));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const notifier = require('../../../services/messageNotifier');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOM_ID = '550e8400-e29b-41d4-a716-446655440002';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const DAD_ID = '550e8400-e29b-41d4-a716-446655440004';
const STRANGER_ID = '550e8400-e29b-41d4-a716-446655440005';
const HOMEROOM_ID = '550e8400-e29b-41d4-a716-446655440006';
const PENDING_ID = '550e8400-e29b-41d4-a716-446655440007';

const asAdmin = { userId: ADMIN_ID, username: 'Admin User', email: 'admin@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Teacher One', email: 'teacher@example.com', role: 'TEACHER' };
const asCo = { userId: CO_TEACHER_ID, username: 'Teacher Two', email: 'co@example.com', role: 'TEACHER' };
const asMom = { userId: MOM_ID, username: 'Mom Test', email: 'mom@example.com', role: 'PARENT' };
const asStranger = { userId: STRANGER_ID, username: 'Other Parent', email: 'other@example.com', role: 'PARENT' };
const asHomeroom = { userId: HOMEROOM_ID, username: 'Sana Rahman', email: 'homeroom@example.com', role: 'TEACHER' };

describe('Integration: Announcements', () => {
  let pool;
  let yearId, classId, aminaId, bilalId, otherGradeId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, username, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, username, password, username.split(' ')[0], username.split(' ')[1], role],
  );

  beforeEach(async () => {
    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`)).rows[0].school_year_id;
    await user(ADMIN_ID, 'admin@example.com', 'Admin User', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Teacher One', 'TEACHER');
    await user(CO_TEACHER_ID, 'co@example.com', 'Teacher Two', 'TEACHER');
    await user(MOM_ID, 'mom@example.com', 'Mom Test', 'PARENT');
    await user(DAD_ID, 'dad@example.com', 'Dad Test', 'PARENT');
    await user(STRANGER_ID, 'other@example.com', 'Other Parent', 'PARENT');
    await user(HOMEROOM_ID, 'homeroom@example.com', 'Sana Rahman', 'TEACHER');
    await user(PENDING_ID, 'pending@example.com', 'Pending Parent', 'PARENT', '!');

    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '6', 'Math', 'Teacher One', $1, $2) RETURNING class_id`, [TEACHER_ID, yearId])).rows[0].class_id;
    await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [classId, CO_TEACHER_ID]);
    const st = (name, grade, hr) => pool
      .query(`INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4) RETURNING student_id`, [name, grade, yearId, hr])
      .then((r) => r.rows[0].student_id);
    aminaId = await st('Amina Test', '6', HOMEROOM_ID);
    bilalId = await st('Bilal Test', '6', HOMEROOM_ID);
    otherGradeId = await st('Yusuf Test', '3', null);
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2), ($1, $3)`, [classId, aminaId, bilalId]);
    const link = (sid, pid, name, email, rel) => pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES ($1, $2, $3, $4, $5, 'ALHAADIACADEMY')`,
      [sid, pid, name, email, rel],
    );
    await link(aminaId, MOM_ID, 'Mom Test', 'mom@example.com', 'Mother');
    await link(aminaId, DAD_ID, 'Dad Test', 'dad@example.com', 'Father');
    await link(bilalId, MOM_ID, 'Mom Test', 'mom@example.com', 'Mother'); // same guardian, two children
    await link(bilalId, null, 'Noor Test', 'noor@example.com', 'Mother'); // email only, no account
    await link(bilalId, PENDING_ID, 'Pending Parent', 'pending@example.com', 'Father');
    await link(otherGradeId, STRANGER_ID, 'Other Parent', 'other@example.com', 'Mother');
  });

  const postClass = (who) => authenticatedRequest('post', '/api/announcements', who)
    .field('scope', 'class').field('classId', classId).field('title', 'Forms due Friday').field('body', 'Please return the form.');
  const postSchool = (title) => authenticatedRequest('post', '/api/announcements', asAdmin)
    .field('scope', 'school').field('title', title).field('body', 'b');

  it('teacher posts to a class: guardians see it, one job per email with the right kind, author excluded', async () => {
    const res = await postClass(asTeacher);
    expect(res.status).toBe(201);
    const id = res.body.data.announcementId;

    const jobs = (await pool.query(`SELECT recipient_email, kind, recipient_id FROM announcement_email_jobs WHERE announcement_id = $1 ORDER BY recipient_email`, [id])).rows;
    expect(jobs).toEqual([
      { recipient_email: 'dad@example.com', kind: 'account', recipient_id: DAD_ID },
      { recipient_email: 'mom@example.com', kind: 'account', recipient_id: MOM_ID },
      { recipient_email: 'noor@example.com', kind: 'signup', recipient_id: null },
      { recipient_email: 'pending@example.com', kind: 'invite', recipient_id: PENDING_ID },
    ]);

    const mom = await authenticatedRequest('get', '/api/announcements', asMom);
    expect(mom.body.data).toHaveLength(1);
    expect(mom.body.data[0].children.map((c) => c.name).sort()).toEqual(['Amina Test', 'Bilal Test']);
    expect(mom.body.data[0].read).toBe(false);
    expect((await authenticatedRequest('get', '/api/announcements', asStranger)).body.data).toHaveLength(0);
    expect((await authenticatedRequest('get', `/api/announcements/${id}`, asStranger)).status).toBe(403);
    expect((await authenticatedRequest('get', '/api/announcements', asCo)).body.data).toHaveLength(1);

    const staff = await authenticatedRequest('get', `/api/announcements/${id}`, asTeacher);
    expect(staff.body.data.audienceCount).toBe(2); // mom + dad; pending and email-only do not count
    expect(staff.body.data.seenCount).toBe(0);
    expect(staff.body.data.emails).toMatchObject({ pending: 4, signup: 1, invite: 1 });
  });

  it('read marks, unread counts and the badge', async () => {
    const id = (await postClass(asTeacher)).body.data.announcementId;
    let badge = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', asMom);
    expect(badge.body.data.unreadAnnouncements).toBe(1);
    expect((await authenticatedRequest('get', '/api/messaging/conversations/unread-count', asTeacher)).body.data.unreadAnnouncements).toBe(0); // own post
    await authenticatedRequest('post', `/api/announcements/${id}/read`, asMom);
    badge = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', asMom);
    expect(badge.body.data.unreadAnnouncements).toBe(0);
    const staff = await authenticatedRequest('get', `/api/announcements/${id}`, asTeacher);
    expect(staff.body.data.seenCount).toBe(1);
    expect(staff.body.data.receipts.seen[0].name).toBe('Mom Test');
    expect(staff.body.data.receipts.seen[0].studentNames).toEqual(['Amina Test', 'Bilal Test']);
  });

  it('grade scope: homeroom teacher may post, another teacher may not; only that grade’s guardians see it', async () => {
    expect((await authenticatedRequest('post', '/api/announcements', asTeacher).field('scope', 'grade').field('grade', '6').field('title', 't').field('body', 'b')).status).toBe(403);
    const res = await authenticatedRequest('post', '/api/announcements', asHomeroom).field('scope', 'grade').field('grade', '6').field('title', 'Picture day').field('body', 'Tuesday');
    expect(res.status).toBe(201);
    expect((await authenticatedRequest('get', '/api/announcements', asMom)).body.data).toHaveLength(1);
    expect((await authenticatedRequest('get', '/api/announcements', asStranger)).body.data).toHaveLength(0);
    expect((await authenticatedRequest('get', '/api/announcements', asTeacher)).body.data).toHaveLength(1); // teaches a grade-6 class
    expect((await authenticatedRequest('post', '/api/announcements', asTeacher).field('scope', 'school').field('title', 't').field('body', 'b')).status).toBe(403);
    expect((await postSchool('PA Day')).status).toBe(201);
    expect((await authenticatedRequest('get', '/api/announcements', asStranger)).body.data).toHaveLength(1);
  });

  it('pinned-and-current sorts first; an expired pin does not', async () => {
    const a = (await postSchool('Old')).body.data.announcementId;
    const b = (await postSchool('Newer')).body.data.announcementId;
    const c = (await authenticatedRequest('post', '/api/announcements', asAdmin).field('scope', 'school').field('title', 'Pinned').field('body', 'b').field('pinnedUntil', '2099-01-01')).body.data.announcementId;
    await pool.query(`UPDATE announcements SET pinned_until = '2020-01-01' WHERE announcement_id = $1`, [a]);
    const list = (await authenticatedRequest('get', '/api/announcements', asMom)).body.data;
    expect(list.map((x) => x.announcementId)).toEqual([c, b, a]);
    expect(list[2].isPinned).toBe(false);
  });

  it('edit does not re-email; delete cancels jobs, hides the row and answers 410 on GET', async () => {
    const id = (await postClass(asTeacher)).body.data.announcementId;
    const count = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM announcement_email_jobs WHERE announcement_id = $1`, [id])).rows[0].n;
    const before = await count();
    expect((await authenticatedRequest('patch', `/api/announcements/${id}`, asTeacher).field('title', 'Forms due Monday')).status).toBe(200);
    expect(await count()).toBe(before);
    expect((await authenticatedRequest('patch', `/api/announcements/${id}`, asCo).field('title', 'x')).status).toBe(403);
    expect((await authenticatedRequest('delete', `/api/announcements/${id}`, asAdmin)).status).toBe(200);
    expect((await pool.query(`SELECT DISTINCT status FROM announcement_email_jobs WHERE announcement_id = $1`, [id])).rows).toEqual([{ status: 'skipped' }]);
    expect((await authenticatedRequest('get', '/api/announcements', asMom)).body.data).toHaveLength(0);
    const gone = await authenticatedRequest('get', `/api/announcements/${id}`, asMom);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('REMOVED');
  });

  it('the worker sends one email per job kind and records sent', async () => {
    const id = (await postClass(asTeacher)).body.data.announcementId;
    await pool.query(`UPDATE announcement_email_jobs SET send_after = NOW() - interval '1 minute' WHERE announcement_id = $1`, [id]);
    expect(await notifier.drainAnnouncements()).toBe(4);
    const rows = (await pool.query(`SELECT status, kind FROM announcement_email_jobs WHERE announcement_id = $1 ORDER BY kind`, [id])).rows;
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1`, [PENDING_ID])).rows[0].n).toBe(1);
  }, 20000);

  it('"Ask about this": a parent opens a General thread with an admin author of a school-wide post', async () => {
    const id = (await postSchool('PA Day')).body.data.announcementId;
    const res = await authenticatedRequest('post', '/api/messaging/conversations', asMom)
      .field('studentId', aminaId).field('teacherId', ADMIN_ID).field('title', 'Re: PA Day').field('body', 'Is care open?').field('announcementId', id);
    expect(res.status).toBe(201);
    expect(res.body.data.conversation.kind).toBe('general');
    expect(res.body.data.conversation.teacherId).toBe(ADMIN_ID);
    const noAnn = await authenticatedRequest('post', '/api/messaging/conversations', asMom)
      .field('studentId', aminaId).field('teacherId', ADMIN_ID).field('title', 'Hi').field('body', 'x');
    expect(noAnn.status).toBe(403);
  });
});
