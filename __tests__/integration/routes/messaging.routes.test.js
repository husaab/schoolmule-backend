jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const MOM_ID = '550e8400-e29b-41d4-a716-446655440002';
const DAD_ID = '550e8400-e29b-41d4-a716-446655440004';
const STRANGER_ID = '550e8400-e29b-41d4-a716-446655440005';

const asTeacher = { userId: TEACHER_ID, username: 'Teacher One', email: 'teacher@example.com', role: 'TEACHER' };
const asCoTeacher = { userId: CO_TEACHER_ID, username: 'Teacher Two', email: 'co@example.com', role: 'TEACHER' };
const asMom = { userId: MOM_ID, username: 'Mom Test', email: 'mom@example.com', role: 'PARENT' };
const asDad = { userId: DAD_ID, username: 'Dad Test', email: 'dad@example.com', role: 'PARENT' };
const asStranger = { userId: STRANGER_ID, username: 'Other Parent', email: 'other@example.com', role: 'PARENT' };
const HOMEROOM_ID = '550e8400-e29b-41d4-a716-446655440006';
const asHomeroom = { userId: HOMEROOM_ID, username: 'Sana Rahman', email: 'homeroom@example.com', role: 'TEACHER' };

describe('Integration: Messaging routes', () => {
  let pool;
  let yearId, classId, studentId, publishedId, draftId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, username, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, username, username.split(' ')[0], username.split(' ')[1], role],
  );

  beforeEach(async () => {
    const y = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`);
    yearId = y.rows[0].school_year_id;

    await user(ADMIN_ID, 'admin@example.com', 'Admin User', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Teacher One', 'TEACHER');
    await user(CO_TEACHER_ID, 'co@example.com', 'Teacher Two', 'TEACHER');
    await user(MOM_ID, 'mom@example.com', 'Mom Test', 'PARENT');
    await user(DAD_ID, 'dad@example.com', 'Dad Test', 'PARENT');
    await user(STRANGER_ID, 'other@example.com', 'Other Parent', 'PARENT');
    await user(HOMEROOM_ID, 'homeroom@example.com', 'Sana Rahman', 'TEACHER');

    const c = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '6', 'Math', 'Teacher One', $1, $2) RETURNING class_id`, [TEACHER_ID, yearId]);
    classId = c.rows[0].class_id;
    await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [classId, CO_TEACHER_ID]);

    const s = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ('Amina Test', '6', 'ALHAADIACADEMY', $1, $2) RETURNING student_id`, [yearId, HOMEROOM_ID]);
    studentId = s.rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, studentId]);
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES
       ($1, $2, 'Mom Test', 'mom@example.com', 'Mother', 'ALHAADIACADEMY'),
       ($1, $3, 'Dad Test', 'dad@example.com', 'Father', 'ALHAADIACADEMY')`, [studentId, MOM_ID, DAD_ID]);

    const a = await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, weight_points, is_published, published_at) VALUES
       ($1, 'Unit 3 Quiz', 20, 10, TRUE, NOW()),
       ($1, 'Draft Test', 30, 15, FALSE, NULL)
       RETURNING assessment_id, name`, [classId]);
    publishedId = a.rows.find((r) => r.name === 'Unit 3 Quiz').assessment_id;
    draftId = a.rows.find((r) => r.name === 'Draft Test').assessment_id;
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, 14)`, [studentId, publishedId]);
  });

  const start = (who, assessmentId, body = 'Hello') =>
    authenticatedRequest('post', '/api/messaging/conversations', who)
      .field('studentId', studentId).field('classId', classId).field('assessmentId', assessmentId).field('body', body);

  it('a guardian starts a thread; both guardians and both teachers see it, strangers do not', async () => {
    const res = await start(asMom, publishedId, 'Can we talk about the quiz?');
    expect(res.status).toBe(201);
    const id = res.body.data.conversation.conversationId;
    expect(res.body.data.context).toMatchObject({ score: 14, maxScore: 20, pct: 70, isPublished: true });
    expect(res.body.data.participants.map((p) => p.userId).sort()).toEqual([MOM_ID, DAD_ID, TEACHER_ID, CO_TEACHER_ID].sort());

    for (const who of [asMom, asDad, asTeacher, asCoTeacher]) {
      const list = await authenticatedRequest('get', '/api/messaging/conversations', who);
      expect(list.status).toBe(200);
      expect(list.body.data.map((c) => c.conversationId)).toEqual([id]);
    }
    const teacherList = await authenticatedRequest('get', '/api/messaging/conversations', asTeacher);
    expect(teacherList.body.data[0]).toMatchObject({ needsReply: true, unreadCount: 1, studentName: 'Amina Test', title: 'Unit 3 Quiz' });

    expect((await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asStranger)).status).toBe(403);
    expect((await authenticatedRequest('get', '/api/messaging/conversations', asStranger)).body.data).toEqual([]);
  });

  it('queues one email job per other participant and reading cancels your own', async () => {
    const created = await start(asMom, publishedId);
    const id = created.body.data.conversation.conversationId;
    let jobs = await pool.query(`SELECT recipient_id, status FROM message_email_jobs WHERE conversation_id = $1 ORDER BY recipient_id`, [id]);
    expect(jobs.rows.filter((j) => j.status === 'pending').map((j) => j.recipient_id).sort()).toEqual([DAD_ID, TEACHER_ID, CO_TEACHER_ID].sort());

    // Dad opens the thread before the window elapses: his job is cancelled.
    expect((await authenticatedRequest('post', `/api/messaging/conversations/${id}/read`, asDad)).status).toBe(200);
    jobs = await pool.query(`SELECT status FROM message_email_jobs WHERE conversation_id = $1 AND recipient_id = $2`, [id, DAD_ID]);
    expect(jobs.rows[0].status).toBe('skipped');

    // Teacher replies: mom and dad get (new) pending jobs, teacher's own is cancelled.
    const reply = await authenticatedRequest('post', `/api/messaging/conversations/${id}/messages`, asTeacher).field('body', 'Sure, Friday works');
    expect(reply.status).toBe(201);
    expect(reply.body.data.messages).toHaveLength(2);
    jobs = await pool.query(`SELECT recipient_id FROM message_email_jobs WHERE conversation_id = $1 AND status = 'pending'`, [id]);
    expect(jobs.rows.map((j) => j.recipient_id).sort()).toEqual([MOM_ID, DAD_ID, CO_TEACHER_ID].sort());

    const unread = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', asDad);
    expect(unread.body.data).toEqual({ unreadConversations: 1, unreadMessages: 1, needsReply: 1, unreadAnnouncements: 0 });
  });

  it('refuses a parent on an unpublished assessment but lets the teacher start it, hiding the score from the parent', async () => {
    expect((await start(asMom, draftId)).status).toBe(403);
    const res = await start(asTeacher, draftId, 'Heads up before I publish');
    expect(res.status).toBe(201);
    expect(res.body.data.context.isPublished).toBe(false);
    const id = res.body.data.conversation.conversationId;
    const momView = await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asMom);
    expect(momView.status).toBe(200);
    expect(momView.body.data.context.score).toBeNull();
    expect(momView.body.data.context.name).toBe('Draft Test');
  });

  it('a second start on the same assessment lands in the existing thread', async () => {
    const first = await start(asMom, publishedId, 'First');
    const second = await start(asDad, publishedId, 'Second');
    expect(second.status).toBe(200);
    expect(second.body.data.conversation.conversationId).toBe(first.body.data.conversation.conversationId);
    expect(second.body.data.messages.map((m) => m.body)).toEqual(['First', 'Second']);
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM conversations`);
    expect(count.rows[0].n).toBe(1);
  });

  it('staff resolve, parents cannot, and a parent reply reopens', async () => {
    const id = (await start(asMom, publishedId)).body.data.conversation.conversationId;
    expect((await authenticatedRequest('patch', `/api/messaging/conversations/${id}`, asMom).send({ status: 'resolved' })).status).toBe(403);
    expect((await authenticatedRequest('patch', `/api/messaging/conversations/${id}`, asCoTeacher).send({ status: 'resolved' })).status).toBe(200);
    let row = await pool.query(`SELECT status, resolved_by FROM conversations WHERE conversation_id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: 'resolved', resolved_by: CO_TEACHER_ID });

    const resolvedList = await authenticatedRequest('get', '/api/messaging/conversations?status=resolved', asMom);
    expect(resolvedList.body.data).toHaveLength(1);
    expect((await authenticatedRequest('get', '/api/messaging/conversations', asMom)).body.data).toHaveLength(0);

    await authenticatedRequest('post', `/api/messaging/conversations/${id}/messages`, asMom).field('body', 'One more thing');
    row = await pool.query(`SELECT status, resolved_by FROM conversations WHERE conversation_id = $1`, [id]);
    expect(row.rows[0]).toEqual({ status: 'open', resolved_by: null });
  });

  it('a resolved thread with an unread reply still counts and shows in the default list', async () => {
    const id = (await start(asMom, publishedId)).body.data.conversation.conversationId;
    await authenticatedRequest('post', `/api/messaging/conversations/${id}/messages`, asTeacher).field('body', 'Here is why, and I am closing this.');
    await authenticatedRequest('patch', `/api/messaging/conversations/${id}`, asTeacher).send({ status: 'resolved' });

    const unread = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', asMom);
    expect(unread.body.data).toMatchObject({ unreadConversations: 1, unreadMessages: 1, needsReply: 0 });
    const list = await authenticatedRequest('get', '/api/messaging/conversations', asMom);
    expect(list.body.data.map((c) => c.conversationId)).toEqual([id]);
    expect(list.body.data[0]).toMatchObject({ status: 'resolved', unreadCount: 1, needsReply: false });

    // Once read, the resolved thread leaves the default (open) list.
    await authenticatedRequest('post', `/api/messaging/conversations/${id}/read`, asMom);
    expect((await authenticatedRequest('get', '/api/messaging/conversations', asMom)).body.data).toEqual([]);
    expect((await authenticatedRequest('get', '/api/messaging/conversations?status=resolved', asMom)).body.data).toHaveLength(1);
  });

  it('an admin joining is announced once; edit and delete follow the rules', async () => {
    const id = (await start(asMom, publishedId, 'Original')).body.data.conversation.conversationId;
    const msgId = (await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asMom)).body.data.messages[0].messageId;

    const adminPost = await authenticatedRequest('post', `/api/messaging/conversations/${id}/messages`, {}).field('body', 'Office here');
    expect(adminPost.status).toBe(201);
    const kinds = adminPost.body.data.messages.map((m) => [m.kind, m.body]);
    expect(kinds).toEqual([['message', 'Original'], ['system', 'Test Admin (Admin) joined the conversation'], ['message', 'Office here']]);
    await authenticatedRequest('post', `/api/messaging/conversations/${id}/messages`, {}).field('body', 'Again');
    const systemCount = await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND kind = 'system'`, [id]);
    expect(systemCount.rows[0].n).toBe(1);

    // Mom edits her own message within the window; the teacher cannot.
    expect((await authenticatedRequest('patch', `/api/messaging/conversations/${id}/messages/${msgId}`, asTeacher).send({ body: 'nope' })).status).toBe(403);
    const edit = await authenticatedRequest('patch', `/api/messaging/conversations/${id}/messages/${msgId}`, asMom).send({ body: 'Original (edited)' });
    expect(edit.status).toBe(200);
    // Teacher cannot delete it; admin can; it then renders as removed.
    expect((await authenticatedRequest('delete', `/api/messaging/conversations/${id}/messages/${msgId}`, asTeacher)).status).toBe(403);
    expect((await authenticatedRequest('delete', `/api/messaging/conversations/${id}/messages/${msgId}`, {})).status).toBe(200);
    const after = await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asDad);
    expect(after.body.data.messages[0]).toMatchObject({ body: null, attachments: [] });
    expect(after.body.data.messages[0].deletedAt).not.toBeNull();
  });

  it('stubs and targets serve the entry points', async () => {
    const id = (await start(asMom, publishedId)).body.data.conversation.conversationId;
    const stubs = await authenticatedRequest('get', `/api/messaging/conversations/stubs?classId=${classId}`, asTeacher);
    expect(stubs.body.data).toEqual([{ conversationId: id, studentId, classId, assessmentId: publishedId, status: 'open', unreadCount: 1 }]);

    const parentTargets = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${studentId}`, asDad);
    expect(parentTargets.status).toBe(200);
    expect(parentTargets.body.data.classes).toEqual([{
      classId, subject: 'Math', teacherName: 'Teacher One',
      assessments: [{ assessmentId: publishedId, name: 'Unit 3 Quiz', date: null, conversationId: id }],
    }]);
    expect((await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${studentId}`, asStranger)).status).toBe(403);

    const staffTargets = await authenticatedRequest('get', `/api/messaging/conversations/targets?classId=${classId}`, asCoTeacher);
    expect(staffTargets.body.data.students[0]).toMatchObject({ studentId, name: 'Amina Test' });
    expect(staffTargets.body.data.students[0].guardians.map((g) => g.hasAccount)).toEqual([true, true]);
    expect(staffTargets.body.data.assessments.map((a) => a.isPublished).sort()).toEqual([false, true]);
  });

  describe('phase 2: general threads and guardian invites', () => {
    const startGeneral = (who, teacherId, title = 'Away Thursday', body = 'Amina will be away Thursday and Friday.') =>
      authenticatedRequest('post', '/api/messaging/conversations', who)
        .field('studentId', studentId).field('teacherId', teacherId).field('title', title).field('body', body);

    it('a parent writes to the homeroom teacher with no class row; the teacher sees it, the Math teacher does not', async () => {
      const res = await startGeneral(asMom, HOMEROOM_ID);
      expect(res.status).toBe(201);
      expect(res.body.data.conversation).toMatchObject({ kind: 'general', classId: null, teacherId: HOMEROOM_ID, title: 'Away Thursday', classSubject: 'Homeroom' });
      expect(res.body.data.context).toBeNull();
      const id = res.body.data.conversation.conversationId;
      expect((await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asHomeroom)).status).toBe(200);
      expect((await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asTeacher)).status).toBe(403);
      const homeroomList = await authenticatedRequest('get', '/api/messaging/conversations', asHomeroom);
      expect(homeroomList.body.data.map((c) => c.conversationId)).toEqual([id]);
      // The homeroom teacher and the other guardian are emailed; no class, so no co-teachers.
      const jobs = await pool.query(`SELECT recipient_id FROM message_email_jobs WHERE conversation_id = $1 AND status = 'pending'`, [id]);
      expect(jobs.rows.map((j) => j.recipient_id).sort()).toEqual([HOMEROOM_ID, DAD_ID].sort());
      // Staff get the student block.
      const view = await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asHomeroom);
      expect(view.body.data.student).toMatchObject({ studentId, name: 'Amina Test', homeroomTeacherName: 'Sana Rahman' });
    });

    it('staff targets for one student list classes with assessments; a General thread can name its class', async () => {
      const targets = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${studentId}`, asTeacher);
      expect(targets.status).toBe(200);
      expect(targets.body.data.classes).toEqual([
        { classId, subject: 'Math', assessments: expect.arrayContaining([expect.objectContaining({ assessmentId: publishedId, isPublished: true }), expect.objectContaining({ assessmentId: draftId, isPublished: false })]) },
      ]);
      // The homeroom teacher teaches no class of Amina's: no classes, still her guardians.
      const hr = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${studentId}`, asHomeroom);
      expect(hr.body.data.classes).toEqual([]);

      const res = await authenticatedRequest('post', '/api/messaging/conversations', asTeacher)
        .field('studentId', studentId).field('teacherId', TEACHER_ID).field('classId', classId).field('title', 'Planner').field('body', 'Please check the planner.');
      expect(res.status).toBe(201);
      expect(res.body.data.conversation).toMatchObject({ kind: 'general', classId, classSubject: 'Math' });
      // The co-teacher of that class is in, because the thread is anchored to it.
      expect(res.body.data.participants.map((p) => p.userId)).toEqual(expect.arrayContaining([CO_TEACHER_ID]));
    });

    it('a parent may only write to teachers of the child', async () => {
      expect((await startGeneral(asMom, STRANGER_ID)).status).toBe(400); // a parent account cannot receive messages
      const { rows } = await pool.query(`INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
        VALUES (gen_random_uuid(), 'other-teacher@example.com', 'Other Teacher', 'x', 'Other', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true) RETURNING user_id`);
      expect((await startGeneral(asMom, rows[0].user_id)).status).toBe(403);
    });

    it('parent targets include the teachers to write to', async () => {
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${studentId}`, asDad);
      expect(res.status).toBe(200);
      expect(res.body.data.classes).toHaveLength(1);
      expect(res.body.data.teachers.map((t) => [t.name, t.via]).sort()).toEqual([['Sana Rahman', 'Homeroom'], ['Teacher One', 'Math'], ['Teacher Two', 'Math']]);
    });

    it('a teacher writing about a student with an unlinked guardian invites them once, and the invite lands in the thread', async () => {
      // Bilal: one guardian with an email and no account.
      const b = await pool.query(`INSERT INTO students (name, grade, school, school_year_id) VALUES ('Bilal Test', '6', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId]);
      const bilal = b.rows[0].student_id;
      await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, bilal]);
      await pool.query(`INSERT INTO parent_students (student_id, parent_name, parent_email, relation, school) VALUES ($1, 'Hana Test', 'hana@example.com', 'Mother', 'ALHAADIACADEMY')`, [bilal]);

      const res = await authenticatedRequest('post', '/api/messaging/conversations', asTeacher)
        .field('studentId', bilal).field('teacherId', TEACHER_ID).field('title', 'Missing homework').field('body', 'Please remind Bilal about his planner.');
      expect(res.status).toBe(201);
      expect(res.body.data.invites).toEqual([expect.objectContaining({ name: 'Hana Test', status: 'invited' })]);
      const id = res.body.data.conversation.conversationId;

      const link = await pool.query(`SELECT ps.parent_id, ps.invited_at, ps.invited_by, ps.invite_conversation_id, u.password, u.role, u.email
        FROM parent_students ps JOIN users u ON u.user_id = ps.parent_id WHERE ps.student_id = $1`, [bilal]);
      expect(link.rows).toHaveLength(1);
      expect(link.rows[0]).toMatchObject({ password: '!', role: 'PARENT', email: 'hana@example.com', invited_by: TEACHER_ID, invite_conversation_id: id });
      expect(link.rows[0].invited_at).not.toBeNull();
      const tokens = await pool.query(`SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1`, [link.rows[0].parent_id]);
      expect(tokens.rows[0].n).toBe(1);

      // The pending guardian is a participant, flagged, and gets no digest job yet.
      const view = await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asTeacher);
      expect(view.body.data.participants.find((p) => p.name === 'Hana Test')).toMatchObject({ role: 'PARENT', invitePending: true });

      // A second message does not re-invite.
      const again = await authenticatedRequest('post', `/api/messaging/conversations/${id}/messages`, asTeacher).field('body', 'One more thing.');
      expect(again.status).toBe(201);
      expect(again.body.data.invites).toEqual([]);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM password_reset_tokens WHERE user_id = $1`, [link.rows[0].parent_id])).rows[0].n).toBe(1);

      // Resend is rate-limited for an hour.
      const linkId = (await pool.query(`SELECT parent_student_link_id FROM parent_students WHERE student_id = $1`, [bilal])).rows[0].parent_student_link_id;
      expect((await authenticatedRequest('post', `/api/messaging/conversations/invites/${linkId}/resend`, asTeacher)).status).toBe(429);

      // Once she sets a password (simulated), she can open the thread as a normal guardian.
      await pool.query(`UPDATE users SET password = 'hashed' WHERE user_id = $1`, [link.rows[0].parent_id]);
      const asHana = { userId: link.rows[0].parent_id, username: 'Hana Test', email: 'hana@example.com', role: 'PARENT' };
      const hanaView = await authenticatedRequest('get', `/api/messaging/conversations/${id}`, asHana);
      expect(hanaView.status).toBe(200);
      expect(hanaView.body.data.messages).toHaveLength(2);
    });

    it('an email that already has a parent account is linked, not invited', async () => {
      const b = await pool.query(`INSERT INTO students (name, grade, school, school_year_id) VALUES ('Zayd Test', '6', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId]);
      const zayd = b.rows[0].student_id;
      await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, zayd]);
      // Mom already has an account (MOM_ID, mom@example.com) but this link row is free-text only.
      await pool.query(`INSERT INTO parent_students (student_id, parent_name, parent_email, relation, school) VALUES ($1, 'Layla Test', 'MOM@example.com', 'Mother', 'ALHAADIACADEMY')`, [zayd]);
      const res = await authenticatedRequest('post', '/api/messaging/conversations', asTeacher)
        .field('studentId', zayd).field('teacherId', TEACHER_ID).field('title', 'Welcome').field('body', 'Hello!');
      expect(res.status).toBe(201);
      expect(res.body.data.invites).toEqual([expect.objectContaining({ status: 'linked' })]);
      const link = await pool.query(`SELECT parent_id, invited_at FROM parent_students WHERE student_id = $1`, [zayd]);
      expect(link.rows[0]).toEqual({ parent_id: MOM_ID, invited_at: null });
      // She is a normal participant and gets a digest job (so does the class co-teacher).
      const jobs = await pool.query(`SELECT recipient_id FROM message_email_jobs WHERE conversation_id = $1 AND status = 'pending'`, [res.body.data.conversation.conversationId]);
      expect(jobs.rows.map((j) => j.recipient_id).sort()).toEqual([MOM_ID, CO_TEACHER_ID].sort());
    });
  });
});
