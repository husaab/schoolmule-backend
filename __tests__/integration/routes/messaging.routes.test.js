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

    const c = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '6', 'Math', 'Teacher One', $1, $2) RETURNING class_id`, [TEACHER_ID, yearId]);
    classId = c.rows[0].class_id;
    await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [classId, CO_TEACHER_ID]);

    const s = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amina Test', '6', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId]);
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
    expect(unread.body.data).toEqual({ unreadConversations: 1, unreadMessages: 1, needsReply: 1 });
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
    expect(parentTargets.body.data).toEqual([{
      classId, subject: 'Math', teacherName: 'Teacher One',
      assessments: [{ assessmentId: publishedId, name: 'Unit 3 Quiz', date: null, conversationId: id }],
    }]);
    expect((await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${studentId}`, asStranger)).status).toBe(403);

    const staffTargets = await authenticatedRequest('get', `/api/messaging/conversations/targets?classId=${classId}`, asCoTeacher);
    expect(staffTargets.body.data.students[0]).toMatchObject({ studentId, name: 'Amina Test' });
    expect(staffTargets.body.data.students[0].guardians.map((g) => g.hasAccount)).toEqual([true, true]);
    expect(staffTargets.body.data.assessments.map((a) => a.isPublished).sort()).toEqual([false, true]);
  });
});
