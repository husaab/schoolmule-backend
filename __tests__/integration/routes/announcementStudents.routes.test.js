// Students in the class Stream: the 'student' email kind (gated by the
// school's per-grade switch), the student feed with read receipts and
// attachments, student seen counts for staff, the opt-out email flag and the
// teacher's class stream endpoint. Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const notifier = require('../../../services/messageNotifier');
const { getResend } = require('../../../utils/emailUtils');
const supabase = require('../../../config/supabaseClient');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MONA_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const SAMI_USER_ID = '550e8400-e29b-41d4-a716-446655440011';
const RAMI_USER_ID = '550e8400-e29b-41d4-a716-446655440012';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office.admin@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asMona = { userId: MONA_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const student = (userId, username, email) => ({ userId, username, email, role: 'STUDENT', roles: ['STUDENT'] });
const asAmal = student(AMAL_USER_ID, 'Amal Haddad', 'amal.haddad@example.com');
const asRami = student(RAMI_USER_ID, 'Rami Saleh', 'rami.saleh@example.com');

describe('Integration: the class Stream reaches students', () => {
  let pool, yearId, mathId, sciId, amalId, samiId, ramiId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, `${first} ${last}`, password, first, last, role],
  );
  const makeClass = async (subject, grade, teacherId) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', $1, $2, 'Lead Name', $3, 'Term 1', $4) RETURNING class_id`,
    [grade, subject, teacherId, yearId],
  )).rows[0].class_id;
  const enrol = async (name, grade, classId, loginUserId) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, $2, 'ALHAADIACADEMY', $3) RETURNING student_id`,
      [name, grade, yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    if (loginUserId) {
      await pool.query(
        `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [loginUserId, id, yearId],
      );
    }
    return id;
  };
  const settings = (patch) => pool.query(
    `UPDATE school_classroom_settings SET ${Object.keys(patch).map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE school = 'ALHAADIACADEMY'`,
    Object.values(patch),
  );

  const post = (who = asTeacher, classId = mathId, extra = {}) => {
    let r = authenticatedRequest('post', '/api/announcements', who)
      .field('scope', 'class').field('classId', classId).field('title', extra.title || 'Forms due Friday').field('body', 'Please return the form.');
    for (const [k, v] of Object.entries(extra)) if (k !== 'title') r = r.field(k, v);
    return r;
  };
  const postId = async (...args) => {
    const res = await post(...args);
    expect(res.status).toBe(201);
    return res.body.data.announcementId;
  };
  const jobs = async (id) => (await pool.query(
    `SELECT recipient_email, kind, recipient_id, status FROM announcement_email_jobs WHERE announcement_id = $1 ORDER BY recipient_email`, [id],
  )).rows;
  const feed = async (who, query = '') => {
    const res = await authenticatedRequest('get', `/api/student/announcements${query}`, who);
    expect(res.status).toBe(200);
    return res.body.data.items;
  };
  const stream = async (classId = mathId, who = asTeacher) => {
    const res = await authenticatedRequest('get', `/api/classroom/classes/${classId}/stream`, who);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeEach(async () => {
    supabase._reset();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;

    await user(ADMIN_ID, 'office.admin@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(MONA_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await user(SAMI_USER_ID, 'sami.haddad@example.com', 'Sami', 'Haddad', 'STUDENT', '!'); // invite pending
    await user(RAMI_USER_ID, 'rami.saleh@example.com', 'Rami', 'Saleh', 'STUDENT');

    await pool.query(
      `INSERT INTO school_classroom_settings (school, enabled, student_email_from_grade) VALUES ('ALHAADIACADEMY', TRUE, '1')`,
    );

    mathId = await makeClass('Math', '6', TEACHER_ID);
    sciId = await makeClass('Science', '6', OTHER_TEACHER_ID);
    amalId = await enrol('Amal Haddad', '6', mathId, AMAL_USER_ID);
    samiId = await enrol('Sami Haddad', '6', mathId, SAMI_USER_ID);
    ramiId = await enrol('Rami Saleh', '6', sciId, RAMI_USER_ID);

    const guardian = (sid, pid, name, email, rel) => pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES ($1, $2, $3, $4, $5, 'ALHAADIACADEMY')`,
      [sid, pid, name, email, rel],
    );
    await guardian(amalId, MONA_ID, 'Mona Haddad', 'mona.haddad@example.com', 'Mother');
    await guardian(samiId, null, 'Noor Saleh', 'noor.saleh@example.com', 'Mother'); // email only
  });

  describe('student emails', () => {
    it("posting to the class queues one 'student' job for the active student account and none for the invite-pending one", async () => {
      const id = await postId();
      expect(await jobs(id)).toEqual([
        { recipient_email: 'amal.haddad@example.com', kind: 'student', recipient_id: AMAL_USER_ID, status: 'pending' },
        { recipient_email: 'mona.haddad@example.com', kind: 'account', recipient_id: MONA_ID, status: 'pending' },
        { recipient_email: 'noor.saleh@example.com', kind: 'signup', recipient_id: null, status: 'pending' },
      ]); // sami.haddad@example.com is invite-pending: no job

      const preview = await authenticatedRequest('get', `/api/announcements/preview?scope=class&classId=${mathId}`, asTeacher);
      expect(preview.body.data).toMatchObject({ students: 2, studentsWithAccount: 1, guardiansWithAccount: 1, guardiansEmailOnly: 1 });
    });

    it("no student jobs when the school's student email is off (from_grade NULL) or classrooms are disabled", async () => {
      await settings({ student_email_from_grade: null });
      let kinds = (await jobs(await postId())).map((j) => j.kind);
      expect(kinds).toEqual(['account', 'signup']);
      expect((await authenticatedRequest('get', `/api/announcements/preview?scope=class&classId=${mathId}`, asTeacher)).body.data.studentsWithAccount).toBe(0);

      await settings({ student_email_from_grade: '1', enabled: false });
      kinds = (await jobs(await postId())).map((j) => j.kind);
      expect(kinds).toEqual(['account', 'signup']);

      // A school that never saved its settings has classrooms off.
      await pool.query(`DELETE FROM school_classroom_settings`);
      kinds = (await jobs(await postId())).map((j) => j.kind);
      expect(kinds).toEqual(['account', 'signup']);
    });

    it('no student job for a grade below student_email_from_grade', async () => {
      await settings({ student_email_from_grade: '7' });
      expect((await jobs(await postId())).map((j) => j.kind)).toEqual(['account', 'signup']);
      // The switch is inclusive: "from Grade 6" includes Grade 6.
      await settings({ student_email_from_grade: '6' });
      expect((await jobs(await postId())).map((j) => j.kind)).toEqual(['student', 'account', 'signup']);
      // JK and SK rank below Grade 1.
      await settings({ student_email_from_grade: 'SK' });
      expect((await jobs(await postId())).map((j) => j.kind)).toEqual(['student', 'account', 'signup']);
    });

    it("a student address equal to a parent account address yields one 'account' job only", async () => {
      await pool.query(`UPDATE users SET email = 'Mona.Haddad@example.com' WHERE user_id = $1`, [AMAL_USER_ID]);
      const id = await postId();
      expect(await jobs(id)).toEqual([
        { recipient_email: 'mona.haddad@example.com', kind: 'account', recipient_id: MONA_ID, status: 'pending' },
        { recipient_email: 'noor.saleh@example.com', kind: 'signup', recipient_id: null, status: 'pending' },
      ]);
    });

    it('a teacher whose address a student shares is still never emailed their own post', async () => {
      await pool.query(`UPDATE users SET email = 'TEACHER@example.com' WHERE user_id = $1`, [AMAL_USER_ID]);
      expect((await jobs(await postId())).map((j) => j.kind)).toEqual(['account', 'signup']);
    });

    it('sendEmail=false queues no jobs at all', async () => {
      const id = await postId(asTeacher, mathId, { sendEmail: 'false' });
      expect(await jobs(id)).toEqual([]);
      const items = (await stream()).announcements;
      expect(items.find((a) => a.announcementId === id).sendEmail).toBe(false);
      // The default (no flag) emails, and says so.
      const emailed = await postId();
      expect((await jobs(emailed)).length).toBe(3);
      expect((await stream()).announcements.find((a) => a.announcementId === emailed).sendEmail).toBe(true);

      // A hand-picked post that was not emailed stays un-emailed when its selection changes.
      const custom = await authenticatedRequest('post', '/api/announcements', asTeacher)
        .field('scope', 'custom').field('studentIds', amalId).field('title', 'Reading group').field('body', 'Monday')
        .field('sendEmail', 'false');
      expect(custom.status).toBe(201);
      const customId = custom.body.data.announcementId;
      const patched = await authenticatedRequest('patch', `/api/announcements/${customId}`, asTeacher)
        .field('studentIds', amalId).field('studentIds', samiId);
      expect(patched.status).toBe(200);
      expect(await jobs(customId)).toEqual([]);
    });

    it('processAnnouncementJob sends a student job with the /student link and no author Reply-To', async () => {
      const send = getResend().emails.send;
      send.mockClear();
      await pool.query(`UPDATE schools SET email_reply_to = '{office@example.org}', email = 'info@example.org' WHERE school_code = 'ALHAADIACADEMY'`);
      await pool.query(`UPDATE users SET avatar = '{"style":"hijab","skin":2,"bg":5}' WHERE user_id = $1`, [TEACHER_ID]);
      const id = await postId(asTeacher, mathId, { ackRequested: '1' });
      await pool.query(`UPDATE announcement_email_jobs SET send_after = NOW() - interval '1 minute' WHERE announcement_id = $1`, [id]);

      expect(await notifier.drainAnnouncements()).toBe(3);
      expect((await jobs(id)).every((j) => j.status === 'sent')).toBe(true);

      const sent = send.mock.calls.map((c) => c[0]);
      const toAmal = sent.find((e) => e.to[0] === 'amal.haddad@example.com');
      expect(toAmal.subject).toBe('Gr 6 Math: Forms due Friday');
      expect(toAmal.replyTo).toEqual(['office@example.org', 'info@example.org']); // the teacher is not on it
      expect(toAmal.html).toContain(`http://localhost:3000/student/classes/${mathId}?announcement=${id}`);
      expect(toAmal.html).toContain('Hi Amal,');
      expect(toAmal.html).toContain('<strong>Ziad Teacher</strong> posted in <strong>Gr 6 Math</strong>.');
      expect(toAmal.html).toContain('Open in SchoolMule');
      expect(toAmal.html).toContain('Questions? Ask your teacher in SchoolMule. Your parents get this announcement too.');
      expect(toAmal.html).toContain('https://schoolmule.ca/email/avatars/hijab-2-5.png');
      expect(toAmal.html).not.toContain('Got it'); // students do not acknowledge
      expect(toAmal.html).not.toContain('/parent/');

      // The parent's copy is unchanged: the teacher first on Reply-To, the parent link.
      const toMona = sent.find((e) => e.to[0] === 'mona.haddad@example.com');
      expect(toMona.replyTo).toEqual(['teacher@example.com', 'office@example.org', 'info@example.org']);
      expect(toMona.html).toContain('/parent/messages?tab=announcements');
      expect(toMona.html).toContain('Got it');
    }, 20000);

    it('the send path skips a student job once the student has left the audience', async () => {
      const id = await postId();
      await pool.query(`DELETE FROM class_students WHERE class_id = $1 AND student_id = $2`, [mathId, amalId]);
      await pool.query(`UPDATE announcement_email_jobs SET send_after = NOW() - interval '1 minute' WHERE announcement_id = $1`, [id]);
      await notifier.drainAnnouncements();
      const amal = (await pool.query(
        `SELECT status, last_error FROM announcement_email_jobs WHERE announcement_id = $1 AND recipient_email = 'amal.haddad@example.com'`, [id],
      )).rows[0];
      expect(amal).toEqual({ status: 'skipped', last_error: 'removed from audience' });
    }, 20000);
  });

  describe('student feed', () => {
    it("student feed lists the class post for an enrolled student and nothing for another class's student", async () => {
      const id = await postId();
      const items = await feed(asAmal);
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        announcementId: id,
        scope: 'class',
        classId: mathId,
        classSubject: 'Math',
        title: 'Forms due Friday',
        body: 'Please return the form.',
        author: { userId: TEACHER_ID, name: 'Ziad Teacher', avatar: null, photoUrl: null },
        publishedAt: expect.any(String),
        editedAt: null,
        isPinned: false,
        attachments: [],
        read: false,
        ackRequested: false,
        ackedAt: null,
      });
      expect(await feed(asRami)).toEqual([]);
      expect(await feed(asAmal, `?classId=${sciId}`)).toEqual([]);
      expect((await feed(asAmal, `?classId=${mathId}`)).map((a) => a.announcementId)).toEqual([id]);

      // A school-wide post reaches both; the class filter leaves it out.
      const school = (await authenticatedRequest('post', '/api/announcements', asAdmin)
        .field('scope', 'school').field('title', 'PA Day').field('body', 'No school Friday')).body.data.announcementId;
      expect((await feed(asRami)).map((a) => a.announcementId)).toEqual([school]);
      expect((await feed(asAmal)).map((a) => a.announcementId)).toEqual([school, id]);
      expect((await feed(asAmal, `?classId=${mathId}`)).map((a) => a.announcementId)).toEqual([id]);
      expect((await feed(asAmal, '?limit=1'))).toHaveLength(1);

      // Removed posts leave the feed.
      await authenticatedRequest('delete', `/api/announcements/${id}`, asTeacher);
      expect((await feed(asAmal)).map((a) => a.announcementId)).toEqual([school]);

      expect((await authenticatedRequest('get', '/api/student/announcements?classId=nope', asAmal)).status).toBe(400);
      expect((await authenticatedRequest('get', '/api/student/announcements', asMona)).status).toBe(403);
    });

    it('POST /api/student/announcements/:id/read records a read; the staff stream shows studentSeenCount 1 of studentAudienceCount 1', async () => {
      const id = await postId();
      let item = (await stream()).announcements.find((a) => a.announcementId === id);
      expect(item).toMatchObject({ studentSeenCount: 0, studentAudienceCount: 1, seenCount: 0, audienceCount: 1 });

      const read = await authenticatedRequest('post', `/api/student/announcements/${id}/read`, asAmal);
      expect(read.status).toBe(200);
      expect(read.body.data).toEqual({ read: true });
      expect((await authenticatedRequest('post', `/api/student/announcements/${id}/read`, asAmal)).status).toBe(200); // idempotent
      expect((await feed(asAmal))[0].read).toBe(true);

      item = (await stream()).announcements.find((a) => a.announcementId === id);
      expect(item).toMatchObject({ studentSeenCount: 1, studentAudienceCount: 1, seenCount: 0 });
      const detail = await authenticatedRequest('get', `/api/announcements/${id}`, asTeacher);
      expect(detail.body.data).toMatchObject({ studentSeenCount: 1, studentAudienceCount: 1, seenCount: 0 });
      const listed = (await authenticatedRequest('get', '/api/announcements', asTeacher)).body.data.find((a) => a.announcementId === id);
      expect(listed).toMatchObject({ studentSeenCount: 1, studentAudienceCount: 1 });

      // Outside the audience: 404, never a write. A removed post: 410.
      expect((await authenticatedRequest('post', `/api/student/announcements/${id}/read`, asRami)).status).toBe(404);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM announcement_reads WHERE user_id = $1`, [RAMI_USER_ID])).rows[0].n).toBe(0);
      await authenticatedRequest('delete', `/api/announcements/${id}`, asTeacher);
      const gone = await authenticatedRequest('post', `/api/student/announcements/${id}/read`, asAmal);
      expect(gone.status).toBe(410);
      expect(gone.body.code).toBe('REMOVED');
      expect((await authenticatedRequest('post', '/api/student/announcements/not-a-uuid/read', asAmal)).status).toBe(404);
    });

    it('student attachment URL is 404 for a post outside the audience', async () => {
      const mine = await postId();
      const theirs = await postId(asOtherTeacher, sciId);
      const attach = async (announcementId, name) => (await pool.query(
        `INSERT INTO announcement_attachments (announcement_id, file_path, file_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, 'application/pdf', 1234) RETURNING attachment_id`,
        [announcementId, `ALHAADIACADEMY/announcements/${announcementId}/${name}`, name],
      )).rows[0].attachment_id;
      const mineFile = await attach(mine, 'form.pdf');
      const theirFile = await attach(theirs, 'lab.pdf');

      expect((await feed(asAmal))[0].attachments).toEqual([
        { attachmentId: mineFile, fileName: 'form.pdf', mimeType: 'application/pdf', sizeBytes: 1234 },
      ]);
      const ok = await authenticatedRequest('get', `/api/student/announcements/${mine}/attachments/${mineFile}/url`, asAmal);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ url: 'https://mock-signed-url.com' });
      expect(supabase._mockStorage.createSignedUrl).toHaveBeenCalledWith(`ALHAADIACADEMY/announcements/${mine}/form.pdf`, 3600);

      expect((await authenticatedRequest('get', `/api/student/announcements/${theirs}/attachments/${theirFile}/url`, asAmal)).status).toBe(404);
      // Another post's file through a post the student can see.
      expect((await authenticatedRequest('get', `/api/student/announcements/${mine}/attachments/${theirFile}/url`, asAmal)).status).toBe(404);
      expect((await authenticatedRequest('get', `/api/student/announcements/${mine}/attachments/nope/url`, asAmal)).status).toBe(404);
      expect(supabase._mockStorage.createSignedUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe('classroom stream', () => {
    it('classroom stream returns class posts with counts, upcoming, and audience { students, guardians }', async () => {
      const assessmentId = (await pool.query(
        `INSERT INTO assessments (class_id, name, date, is_parent, sort_order)
         VALUES ($1, 'Unit 2 test', (NOW() AT TIME ZONE 'America/Toronto')::date + 3, FALSE, 0) RETURNING assessment_id`,
        [mathId],
      )).rows[0].assessment_id;
      const first = await postId(asTeacher, mathId, { title: 'First' });
      await pool.query(`UPDATE announcements SET published_at = NOW() - interval '1 hour' WHERE announcement_id = $1`, [first]);
      const second = await postId(asTeacher, mathId, { title: 'Second' });
      await postId(asOtherTeacher, sciId, { title: 'Science only' });
      await authenticatedRequest('post', '/api/announcements', asAdmin).field('scope', 'school').field('title', 'PA Day').field('body', 'b');

      const data = await stream();
      expect(data.announcements.map((a) => a.title)).toEqual(['Second', 'First']); // this class only, newest first
      expect(data.announcements[0]).toMatchObject({
        announcementId: second, scope: 'class', classId: mathId, authorId: TEACHER_ID, authorName: 'Ziad Teacher',
        audienceCount: 1, seenCount: 0, studentAudienceCount: 1, studentSeenCount: 0, sendEmail: true, canEdit: true,
      });
      expect(data.notices).toEqual([]);
      expect(data.upcoming).toEqual([expect.objectContaining({ assessmentId, classId: mathId, title: 'Unit 2 test', kind: 'assessment' })]);
      expect(data.audience).toEqual({ students: 1, guardians: 2 }); // Amal (Sami is invite-pending); Mona + Noor

      // The admin sees the same stream; another class's teacher and a student are refused.
      expect((await stream(mathId, asAdmin)).announcements).toHaveLength(2);
      expect((await authenticatedRequest('get', `/api/classroom/classes/${mathId}/stream`, asOtherTeacher)).status).toBe(403);
      const fenced = await authenticatedRequest('get', `/api/classroom/classes/${mathId}/stream`, asAmal);
      expect(fenced.status).toBe(403);
      expect(fenced.body.code).toBe('STUDENT_FORBIDDEN');
      expect((await authenticatedRequest('get', `/api/classroom/classes/${mathId}/stream`, asMona)).status).toBe(403);
      expect((await authenticatedRequest('get', '/api/classroom/classes/99999999-9999-4999-8999-999999999999/stream', asAdmin)).status).toBe(404);

      // The class stream of a school whose student email is off counts no students.
      await settings({ student_email_from_grade: null });
      expect((await stream()).audience).toEqual({ students: 0, guardians: 2 });
    });
  });
});
