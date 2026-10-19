// Students message their teachers (spec D14, T17): parents are always in the
// thread, older parent–teacher threads stay between the adults, a student
// reaches only their own current teachers, and "messages about this work"
// are one thread per student × item (which a school may keep from parents).
// Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const HOMEROOM_ID = '550e8400-e29b-41d4-a716-446655440004';
const MOM_ID = '550e8400-e29b-41d4-a716-446655440005';
const DAD_ID = '550e8400-e29b-41d4-a716-446655440006';
const RANIA_ID = '550e8400-e29b-41d4-a716-446655440007';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const BILAL_USER_ID = '550e8400-e29b-41d4-a716-446655440011';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office.admin@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asCoTeacher = { userId: CO_TEACHER_ID, username: 'Omar Coteacher', email: 'omar.coteacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asMom = { userId: MOM_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asDad = { userId: DAD_ID, username: 'Sami Haddad', email: 'sami.haddad@example.com', role: 'PARENT' };
const asRania = { userId: RANIA_ID, username: 'Rania Karim', email: 'rania.karim@example.com', role: 'PARENT' };
const asAmal = { userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'] };
const asBilal = { userId: BILAL_USER_ID, username: 'Bilal Karim', email: 'bilal.karim@example.com', role: 'STUDENT', roles: ['STUDENT'] };

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();

describe('Integration: student messaging', () => {
  let pool, yearId, termId;
  let sciId, mathId, pastId, amalId, bilalId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = async (subject, teacherId, term = { id: termId, name: 'Term 1' }) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', '5', $1, 'Lead Name', $2, $3, $4, $5) RETURNING class_id`,
    [subject, teacherId, term.id, term.name, yearId],
  )).rows[0].class_id;
  const makeStudent = async (name, classIds, loginId, homeroomId = null) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2, $3) RETURNING student_id`,
      [name, yearId, homeroomId],
    )).rows[0].student_id;
    for (const c of classIds) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [c, id]);
    await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [loginId, id, yearId]);
    await pool.query(`INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())`, [loginId]);
    return id;
  };

  const call = (method, url, who) => authenticatedRequest(method, url, who);
  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const get = (url, who, status = 200) => expectStatus(call('get', url, who), status);
  const send = (method, url, who, body, status) => expectStatus(call(method, url, who).send(body), status);
  const startThread = (body, who = asAmal, status = 201) => send('post', '/api/student/conversations', who, body, status);
  const staffPost = (id, who, body) => expectStatus(call('post', `/api/messaging/conversations/${id}/messages`, who).field('body', body), 201);
  const pendingJobs = async (conversationId) => (await pool.query(
    `SELECT recipient_id FROM message_email_jobs WHERE conversation_id = $1 AND status = 'pending' ORDER BY recipient_id`, [conversationId],
  )).rows.map((r) => r.recipient_id);
  const createItem = async (classId, body, who = asTeacher) => (await send('post', `/api/classroom/classes/${classId}/items`, who, body, 201)).data;
  const sorted = (a) => [...a].sort();

  beforeEach(async () => {
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;
    const pastTermId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Summer', DATE '2026-07-01', DATE '2026-08-31', FALSE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;

    await user(ADMIN_ID, 'office.admin@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(CO_TEACHER_ID, 'omar.coteacher@example.com', 'Omar', 'Coteacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(HOMEROOM_ID, 'huda.homeroom@example.com', 'Huda', 'Homeroom', 'TEACHER');
    await user(MOM_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(DAD_ID, 'sami.haddad@example.com', 'Sami', 'Haddad', 'PARENT');
    await user(RANIA_ID, 'rania.karim@example.com', 'Rania', 'Karim', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await user(BILAL_USER_ID, 'bilal.karim@example.com', 'Bilal', 'Karim', 'STUDENT');
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    sciId = await makeClass('Science', TEACHER_ID);
    await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [sciId, CO_TEACHER_ID]);
    mathId = await makeClass('Math', OTHER_TEACHER_ID);
    pastId = await makeClass('Summer Art', OTHER_TEACHER_ID, { id: pastTermId, name: 'Summer' });
    amalId = await makeStudent('Amal Haddad', [sciId, pastId], AMAL_USER_ID, HOMEROOM_ID);
    bilalId = await makeStudent('Bilal Karim', [sciId, mathId], BILAL_USER_ID);
    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school) VALUES
       ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY'),
       ($3, $2, 'Sami Haddad', 'sami.haddad@example.com', 'Father', 'ALHAADIACADEMY'),
       ($4, $5, 'Rania Karim', 'rania.karim@example.com', 'Mother', 'ALHAADIACADEMY')`,
      [MOM_ID, amalId, DAD_ID, RANIA_ID, bilalId],
    );
  });

  it('a student starts a thread with a current teacher; both guardians and the teacher are participants; email jobs queue for all three', async () => {
    const targets = (await get('/api/student/conversations/targets', asAmal)).data;
    // Current-term teachers of Amal's classes (lead and co) and her homeroom
    // teacher; never the past-term class's teacher, an admin or a classmate.
    expect(targets.teachers.map((t) => [t.name, t.classes.map((c) => c.subject)])).toEqual([
      ['Huda Homeroom', []],
      ['Omar Coteacher', ['Science']],
      ['Ziad Teacher', ['Science']],
    ]);
    expect(targets.teachers[2]).toEqual({ userId: TEACHER_ID, name: 'Ziad Teacher', avatar: null, classes: [{ classId: sciId, subject: 'Science' }] });
    expect(targets.guardians).toEqual([{ name: 'Mona Haddad', relation: 'Mother' }, { name: 'Sami Haddad', relation: 'Father' }]);

    const thread = (await startThread({ teacherId: TEACHER_ID, classId: sciId, subject: 'Lab partner', body: 'Can I switch lab partners?' })).data;
    expect(thread.conversation).toMatchObject({
      kind: 'general', title: 'Lab partner', classId: sciId, studentId: amalId, includesStudent: true, classworkItemId: null,
      leadTeacherName: 'Ziad Teacher', classSubject: 'Science',
    });
    expect(thread.student).toBeNull(); // no staff context strip for a student
    expect(thread.context).toBeNull();
    const roles = Object.fromEntries(thread.participants.map((p) => [p.userId, [p.role, p.relation]]));
    expect(roles).toEqual({
      [MOM_ID]: ['PARENT', 'Mother'], [DAD_ID]: ['PARENT', 'Father'], [AMAL_USER_ID]: ['STUDENT', 'student'],
      [TEACHER_ID]: ['TEACHER', null], [CO_TEACHER_ID]: ['TEACHER', null],
    });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ senderId: AMAL_USER_ID, senderRole: 'STUDENT', body: 'Can I switch lab partners?' });

    const id = thread.conversation.conversationId;
    // Both guardians and the teachers get a digest; the student wrote it.
    expect(await pendingJobs(id)).toEqual(sorted([MOM_ID, DAD_ID, TEACHER_ID, CO_TEACHER_ID]));

    // The homeroom teacher (no class with Amal) is reachable too; the thread has no class.
    const homeroom = (await startThread({ teacherId: HOMEROOM_ID, subject: 'Lunch', body: 'I lost my lunch card.' })).data;
    expect(homeroom.conversation).toMatchObject({ classId: null, teacherId: HOMEROOM_ID, includesStudent: true });
    expect(await pendingJobs(homeroom.conversation.conversationId)).toEqual(sorted([MOM_ID, DAD_ID, HOMEROOM_ID]));

    // Validation.
    await startThread({ teacherId: TEACHER_ID, subject: '', body: 'x' }, asAmal, 400);
    await startThread({ teacherId: TEACHER_ID, subject: 'x'.repeat(121), body: 'x' }, asAmal, 400);
    await startThread({ teacherId: TEACHER_ID, subject: 'Hi', body: '   ' }, asAmal, 400);
    await startThread({ teacherId: TEACHER_ID, subject: 'Hi', body: 'x'.repeat(5001) }, asAmal, 400);
    await startThread({ teacherId: 'nope', subject: 'Hi', body: 'x' }, asAmal, 400);
  });

  it('a student cannot message a teacher who does not teach them (403) and there is no way to address another student', async () => {
    const refused = 'You can message your own teachers only.';
    // Teaches Bilal (Math), and Amal only in a past term.
    expect((await startThread({ teacherId: OTHER_TEACHER_ID, subject: 'Hi', body: 'Hello' }, asAmal, 403)).message).toBe(refused);
    // Another student, a parent and an admin are never teachers.
    for (const id of [BILAL_USER_ID, MOM_ID, ADMIN_ID]) {
      expect((await startThread({ teacherId: id, subject: 'Hi', body: 'Hello' }, asAmal, 403)).message).toBe(refused);
    }
    // A class the teacher doesn't teach Amal in.
    await startThread({ teacherId: TEACHER_ID, classId: mathId, subject: 'Hi', body: 'Hello' }, asAmal, 400);
    // A student id in the body is ignored: the thread is always the caller's own.
    const own = (await startThread({ teacherId: TEACHER_ID, studentId: bilalId, subject: 'Hi', body: 'Hello' })).data;
    expect(own.conversation.studentId).toBe(amalId);
    expect(own.participants.map((p) => p.userId)).not.toContain(BILAL_USER_ID);
    expect(own.participants.map((p) => p.userId)).not.toContain(RANIA_ID);

    // Bilal never sees, opens or posts in Amal's thread.
    const id = own.conversation.conversationId;
    expect((await get('/api/student/conversations', asBilal)).data.items).toEqual([]);
    await get(`/api/student/conversations/${id}`, asBilal, 403);
    await send('post', `/api/student/conversations/${id}/messages`, asBilal, { body: 'Hi' }, 403);
    await get(`/api/student/conversations/${id}`, asAmal, 200);
    await get('/api/student/conversations/not-a-uuid', asAmal, 404);
    await get('/api/student/conversations/00000000-0000-4000-8000-000000000001', asAmal, 404);

    // The fence: a student token never reaches /api/messaging.
    const fenced = await call('get', '/api/messaging/conversations', asAmal);
    expect(fenced.status).toBe(403);
    expect(fenced.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('Fable M3: a teacher who teaches the student in two classes needs the class named (400 CLASS_REQUIRED); never a guess', async () => {
    const labId = await makeClass('Lab Skills', TEACHER_ID);
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [labId, amalId]);
    const ziad = (await get('/api/student/conversations/targets', asAmal)).data.teachers.find((t) => t.userId === TEACHER_ID);
    expect(ziad.classes.map((c) => c.subject).sort()).toEqual(['Lab Skills', 'Science']);

    const refused = await startThread({ teacherId: TEACHER_ID, subject: 'Lab', body: 'Is the lab open at lunch?' }, asAmal, 400);
    expect(refused).toMatchObject({ code: 'CLASS_REQUIRED', message: 'Choose which class this message is about.' });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE student_id = $1`, [amalId])).rows[0].n).toBe(0);

    // Named: the thread is filed under that class.
    const lab = (await startThread({ teacherId: TEACHER_ID, classId: labId, subject: 'Lab', body: 'Is the lab open at lunch?' })).data;
    expect(lab.conversation).toMatchObject({ classId: labId, classSubject: 'Lab Skills' });
    // One class with this teacher (Omar co-teaches Science only): no class needed, it is that one.
    const omar = (await startThread({ teacherId: CO_TEACHER_ID, subject: 'Lab', body: 'Can I stay late?' })).data;
    expect(omar.conversation).toMatchObject({ classId: sciId });
  });

  it('an existing parent–teacher thread about the student is not listed for the student and GET is 403', async () => {
    const adult = await expectStatus(call('post', '/api/messaging/conversations', asMom)
      .field('studentId', amalId).field('teacherId', TEACHER_ID).field('title', 'Pickup time').field('body', 'Can we talk privately?'), 201);
    const id = adult.data.conversation.conversationId;
    expect(adult.data.conversation.includesStudent).toBe(false);
    expect(adult.data.participants.map((p) => p.role)).not.toContain('STUDENT');
    await staffPost(id, asTeacher, 'Of course.');
    // Nobody emails the student about it.
    expect(await pendingJobs(id)).not.toContain(AMAL_USER_ID);

    expect((await get('/api/student/conversations', asAmal)).data.items).toEqual([]);
    expect((await get('/api/student/conversations?status=open', asAmal)).data.items).toEqual([]);
    await get(`/api/student/conversations/${id}`, asAmal, 403);
    await send('post', `/api/student/conversations/${id}/messages`, asAmal, { body: 'Hi' }, 403);
    await send('post', `/api/student/conversations/${id}/read`, asAmal, undefined, 403);
    await get(`/api/student/conversations/${id}/attachments/00000000-0000-4000-8000-000000000001/url`, asAmal, 403);
    expect((await get('/api/student/conversations/unread-count', asAmal)).data).toEqual({ unreadConversations: 0, unreadMessages: 0 });
  });

  it("the parent sees the student thread and can reply; the teacher's inbox lists it and needs-reply counts the student's message", async () => {
    const id = (await startThread({ teacherId: TEACHER_ID, classId: sciId, subject: 'Homework', body: 'I left my book at school.' })).data.conversation.conversationId;

    // The guardians' inbox lists it and they can open it and reply.
    const momList = (await get('/api/messaging/conversations?status=all', asMom)).data;
    expect(momList.map((c) => [c.conversationId, c.includesStudent])).toEqual([[id, true]]);
    expect(momList[0].needsReply).toBe(false); // their own child spoke last: nothing for the family to answer
    const momThread = (await get(`/api/messaging/conversations/${id}`, asMom)).data;
    expect(momThread.participants.map((p) => p.userId)).toContain(AMAL_USER_ID);
    await staffPost(id, asDad, 'She can borrow a copy from her cousin.');
    // The student is emailed what the parent wrote.
    expect(await pendingJobs(id)).toContain(AMAL_USER_ID);

    // The teacher's inbox: needs reply (the family spoke last), and the badge counts it.
    const teacherList = (await get('/api/messaging/conversations', asTeacher)).data;
    expect(teacherList.find((c) => c.conversationId === id)).toMatchObject({ needsReply: true, studentName: 'Amal Haddad', includesStudent: true });
    expect((await get('/api/messaging/conversations/unread-count', asTeacher)).data.needsReply).toBe(1);
    expect((await get('/api/messaging/conversations', asCoTeacher)).data.map((c) => c.conversationId)).toEqual([id]);
    expect((await get('/api/messaging/conversations', asOtherTeacher)).data).toEqual([]);
    await get(`/api/messaging/conversations/${id}`, asRania, 403);

    // A student-only last word counts as needing a reply too.
    const id2 = (await startThread({ teacherId: TEACHER_ID, subject: 'Quiz', body: 'When is the quiz?' })).data.conversation.conversationId;
    expect((await get('/api/messaging/conversations', asTeacher)).data.find((c) => c.conversationId === id2).needsReply).toBe(true);
    expect((await get('/api/messaging/conversations/unread-count', asTeacher)).data.needsReply).toBe(2);

    // The teacher answers: now the student's side needs to reply, not the teacher's.
    await staffPost(id, asTeacher, 'Bring it tomorrow.');
    const amalList = (await get('/api/student/conversations', asAmal)).data.items;
    expect(amalList.find((c) => c.conversationId === id)).toMatchObject({ needsReply: true, includesStudent: true, leadTeacherName: 'Ziad Teacher' });
    expect((await get('/api/messaging/conversations/unread-count', asTeacher)).data.needsReply).toBe(1);
    expect((await get('/api/messaging/conversations', asMom)).data.find((c) => c.conversationId === id).needsReply).toBe(true);
    expect(await pendingJobs(id)).toEqual(expect.arrayContaining([AMAL_USER_ID, MOM_ID, DAD_ID]));
  });

  it('the item thread is created once per student and item (two posts, one conversation)', async () => {
    const item = await createItem(sciId, { kind: 'assignment', title: 'Plant cell diagram', submissionMode: 'file', dueAt: inDays(3) });
    const url = `/api/student/items/${item.itemId}/thread`;
    expect((await get(url, asAmal)).data).toEqual({ thread: null });
    expect((await get(`/api/student/items/${item.itemId}`, asAmal)).data.thread).toBeNull();

    const first = (await send('post', `${url}/messages`, asAmal, { body: 'Is the cell wall thicker than the membrane?' }, 201)).data;
    const second = (await send('post', `${url}/messages`, asAmal, { body: 'Also, do we label the vacuole?' }, 201)).data;
    const id = first.conversation.conversationId;
    expect(second.conversation.conversationId).toBe(id);
    expect(first.conversation).toMatchObject({
      title: 'Plant cell diagram', classId: sciId, classworkItemId: item.itemId, includesStudent: true, kind: 'general', leadTeacherName: 'Ziad Teacher',
    });
    expect(second.messages.map((m) => m.body)).toEqual(['Is the cell wall thicker than the membrane?', 'Also, do we label the vacuole?']);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE student_id = $1 AND classwork_item_id = $2`, [amalId, item.itemId]);
    expect(rows[0].n).toBe(1);
    expect(sorted(second.participants.map((p) => p.userId))).toEqual(sorted([MOM_ID, DAD_ID, AMAL_USER_ID, TEACHER_ID, CO_TEACHER_ID]));

    const viaGet = (await get(url, asAmal)).data.thread;
    expect(viaGet.conversation.conversationId).toBe(id);
    expect(viaGet.messages).toHaveLength(2);
    expect((await get(`/api/student/items/${item.itemId}`, asAmal)).data.thread).toEqual({ conversationId: id, messageCount: 2 });
    // It is also in Messages.
    expect((await get('/api/student/conversations', asAmal)).data.items.find((c) => c.conversationId === id))
      .toMatchObject({ classworkItemId: item.itemId });
    // The parent lens shows it (guardians may read private comments by default).
    expect((await get(`/api/parent-portal/students/${amalId}/classroom/items/${item.itemId}`, asMom)).data.thread)
      .toEqual({ conversationId: id, messageCount: 2 });

    // Bilal's thread on the same item is his own (none yet).
    expect((await get(url, asBilal)).data).toEqual({ thread: null });
    const bilals = (await send('post', `${url}/messages`, asBilal, { body: 'Mine too?' }, 201)).data.conversation.conversationId;
    expect(bilals).not.toBe(id);

    // Only turn-in work takes a thread; an item the student can't see is 404.
    const material = await createItem(sciId, { kind: 'material', title: 'Cells reading' });
    expect((await get(`/api/student/items/${material.itemId}/thread`, asAmal)).data).toEqual({ thread: null });
    await send('post', `/api/student/items/${material.itemId}/thread/messages`, asAmal, { body: 'Hi' }, 400);
    const mathItem = await createItem(mathId, { kind: 'assignment', title: 'Fractions', submissionMode: 'done' }, asOtherTeacher);
    await get(`/api/student/items/${mathItem.itemId}/thread`, asAmal, 404);
    await send('post', `/api/student/items/${mathItem.itemId}/thread/messages`, asAmal, { body: 'Hi' }, 404);
    const draft = await createItem(sciId, { kind: 'assignment', title: 'Not yet', submissionMode: 'done', status: 'draft' });
    await send('post', `/api/student/items/${draft.itemId}/thread/messages`, asAmal, { body: 'Hi' }, 404);
    await send('post', `${url}/messages`, asAmal, { body: '' }, 400);

    // A past-term class: no new thread (the current-term gate), but the item page still opens.
    const pastItem = await createItem(pastId, { kind: 'assignment', title: 'Summer sketch', submissionMode: 'done' }, asOtherTeacher);
    expect((await send('post', `/api/student/items/${pastItem.itemId}/thread/messages`, asAmal, { body: 'Hi' }, 400)).message)
      .toMatch(/past term/);
  });

  it('with parents_read_private_comments off, the parent cannot open the item thread but still sees the student\'s general thread', async () => {
    await pool.query(`UPDATE school_classroom_settings SET parents_read_private_comments = FALSE WHERE school = 'ALHAADIACADEMY'`);
    const item = await createItem(sciId, { kind: 'assignment', title: 'Lab report', submissionMode: 'text', dueAt: inDays(3) });
    const itemThread = (await send('post', `/api/student/items/${item.itemId}/thread/messages`, asAmal, { body: 'Can I add a graph?' }, 201)).data;
    const itemId = itemThread.conversation.conversationId;
    const general = (await startThread({ teacherId: TEACHER_ID, subject: 'Trip form', body: 'I forgot the form.' })).data.conversation.conversationId;

    // The item thread: no guardians in it, and no guardian email.
    expect(itemThread.participants.map((p) => p.role).sort()).toEqual(['STUDENT', 'TEACHER', 'TEACHER']);
    expect(await pendingJobs(itemId)).toEqual(sorted([TEACHER_ID, CO_TEACHER_ID]));
    const momBadge = async () => (await get('/api/messaging/conversations/unread-count', asMom)).data;
    const badgeBefore = await momBadge();
    await staffPost(itemId, asTeacher, 'Yes, a graph is great.');
    expect(await pendingJobs(itemId)).toEqual(sorted([CO_TEACHER_ID, AMAL_USER_ID]));
    // The parent's badge doesn't move, and a search doesn't find it.
    expect(await momBadge()).toEqual(badgeBefore);
    expect((await get('/api/messaging/conversations?status=all&q=Lab%20report', asMom)).data).toEqual([]);
    // Staff list rows name no guardians on it (they aren't in it).
    const staffRow = (await get('/api/messaging/conversations', asTeacher)).data.find((c) => c.conversationId === itemId);
    expect(staffRow.guardianNames).toEqual([]);
    expect((await get('/api/messaging/conversations', asTeacher)).data.find((c) => c.conversationId === general).guardianNames.sort())
      .toEqual(['Mona Haddad', 'Sami Haddad']);

    // The parent: not listed, not openable, not in the badge or the chips, not in the lens.
    const momList = (await get('/api/messaging/conversations?status=all', asMom)).data.map((c) => c.conversationId);
    expect(momList).toEqual([general]);
    await get(`/api/messaging/conversations/${itemId}`, asMom, 403);
    await expectStatus(call('post', `/api/messaging/conversations/${itemId}/messages`, asMom).field('body', 'Hello?'), 403);
    const stubs = (await get(`/api/messaging/conversations/stubs?studentId=${amalId}`, asMom)).data.map((s) => s.conversationId);
    expect(stubs).toEqual([general]);
    expect((await get(`/api/parent-portal/students/${amalId}/classroom/items/${item.itemId}`, asMom)).data.thread).toBeNull();
    expect((await get(`/api/messaging/conversations/${general}`, asMom)).data.participants.map((p) => p.userId)).toContain(AMAL_USER_ID);

    // The teacher's view of the item thread has no guardians either.
    const teacherView = (await get(`/api/messaging/conversations/${itemId}`, asTeacher)).data;
    expect(teacherView.participants.map((p) => p.userId)).not.toContain(MOM_ID);
    // A teacher reply never invites or links a guardian into a hidden thread.
    expect((await expectStatus(call('post', `/api/messaging/conversations/${itemId}/messages`, asTeacher).field('body', 'More?'), 201)).data.invites).toEqual([]);

    // The setting back on: the parent reads it again.
    await pool.query(`UPDATE school_classroom_settings SET parents_read_private_comments = TRUE WHERE school = 'ALHAADIACADEMY'`);
    await get(`/api/messaging/conversations/${itemId}`, asMom, 200);
  });

  it('a teacher ensures an item thread from the grading view and posts through /api/messaging', async () => {
    const item = await createItem(sciId, { kind: 'assignment', title: 'Plant cell diagram', submissionMode: 'done', dueAt: inDays(3) });
    const base = `/api/classroom/items/${item.itemId}/students`;
    expect((await get(`${base}/${amalId}/thread`, asTeacher)).data).toEqual({ conversationId: null, messageCount: 0 });

    const ensured = (await send('post', `${base}/${amalId}/thread`, asTeacher, undefined, 201)).data;
    const again = (await send('post', `${base}/${amalId}/thread`, asCoTeacher, undefined, 200)).data;
    expect(again.conversationId).toBe(ensured.conversationId);
    const id = ensured.conversationId;
    await staffPost(id, asTeacher, 'Nice labels. Check the nucleus.');
    expect(await pendingJobs(id)).toEqual(sorted([MOM_ID, DAD_ID, AMAL_USER_ID, CO_TEACHER_ID]));

    expect((await get(`${base}/${amalId}/thread`, asTeacher)).data).toEqual({ conversationId: id, messageCount: 1 });
    const list = (await get(`/api/classroom/items/${item.itemId}/submissions`, asTeacher)).data.students;
    expect(Object.fromEntries(list.map((r) => [r.studentId, r.hasThread]))).toEqual({ [amalId]: true, [bilalId]: false });
    expect((await get(`/api/classroom/items/${item.itemId}/submissions/${amalId}`, asTeacher)).data.thread)
      .toEqual({ conversationId: id, messageCount: 1 });
    expect((await get(`/api/classroom/items/${item.itemId}/submissions/${bilalId}`, asTeacher)).data.thread).toBeNull();

    // The student sees it on the assignment page and in Messages, and reads it there.
    const page = (await get(`/api/student/items/${item.itemId}/thread`, asAmal)).data.thread;
    expect(page.conversation).toMatchObject({ conversationId: id, classworkItemId: item.itemId, title: 'Plant cell diagram' });
    expect(page.messages.map((m) => [m.senderRole, m.body])).toEqual([['TEACHER', 'Nice labels. Check the nucleus.']]);
    expect((await get('/api/student/conversations/unread-count', asAmal)).data).toEqual({ unreadConversations: 0, unreadMessages: 0 });

    // Not someone else's class, not a student the item isn't for, only turn-in work.
    await get(`${base}/${amalId}/thread`, asOtherTeacher, 403);
    await send('post', `${base}/${amalId}/thread`, asOtherTeacher, undefined, 403);
    const outsider = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Omar Saleh', '5', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId],
    )).rows[0].student_id;
    await send('post', `${base}/${outsider}/thread`, asTeacher, undefined, 404);
    const material = await createItem(sciId, { kind: 'material', title: 'Cells reading' });
    await send('post', `/api/classroom/items/${material.itemId}/students/${amalId}/thread`, asTeacher, undefined, 400);

    // A past-term class: a teacher can't start one there; an admin can.
    const pastItem = await createItem(pastId, { kind: 'assignment', title: 'Summer sketch', submissionMode: 'done' }, asOtherTeacher);
    await send('post', `/api/classroom/items/${pastItem.itemId}/students/${amalId}/thread`, asOtherTeacher, undefined, 400);
    await send('post', `/api/classroom/items/${pastItem.itemId}/students/${amalId}/thread`, asAdmin, undefined, 201);

    // A student token never reaches the teacher routes.
    expect((await call('post', `${base}/${amalId}/thread`, asAmal)).body.code).toBe('STUDENT_FORBIDDEN');
  });

  it("a student edits and deletes their own message within 15 minutes; not someone else's", async () => {
    const thread = (await startThread({ teacherId: TEACHER_ID, subject: 'Typo', body: 'Teh homework' })).data;
    const id = thread.conversation.conversationId;
    const mine = thread.messages[0].messageId;
    const msgUrl = (messageId) => `/api/student/conversations/${id}/messages/${messageId}`;

    expect((await send('patch', msgUrl(mine), asAmal, { body: 'The homework' }, 200)).data).toMatchObject({ messageId: mine, body: 'The homework' });
    const teacherMsg = (await staffPost(id, asTeacher, 'Which homework?')).data.messages.find((m) => m.senderId === TEACHER_ID).messageId;
    const momMsg = (await staffPost(id, asMom, 'The worksheet.')).data.messages.find((m) => m.senderId === MOM_ID).messageId;
    for (const other of [teacherMsg, momMsg]) {
      await send('patch', msgUrl(other), asAmal, { body: 'Changed' }, 403);
      await send('delete', msgUrl(other), asAmal, undefined, 403);
    }
    await send('patch', msgUrl('not-a-uuid'), asAmal, { body: 'x' }, 404);

    // A second message, deleted inside the window.
    const second = (await send('post', `/api/student/conversations/${id}/messages`, asAmal, { body: 'Oops, wrong thread' }, 201)).data
      .messages.filter((m) => m.senderId === AMAL_USER_ID).pop().messageId;
    expect((await send('delete', msgUrl(second), asAmal, undefined, 200)).data.deletedAt).toBeTruthy();
    const after = (await get(`/api/student/conversations/${id}`, asAmal)).data.messages.find((m) => m.messageId === second);
    expect(after).toMatchObject({ body: null, deletedAt: expect.any(String) });

    // After 15 minutes the first one can neither be edited nor removed.
    await pool.query(`UPDATE messages SET created_at = NOW() - INTERVAL '20 minutes' WHERE message_id = $1`, [mine]);
    await send('patch', msgUrl(mine), asAmal, { body: 'Too late' }, 403);
    expect((await send('delete', msgUrl(mine), asAmal, undefined, 403)).message).toMatch(/15 minutes/);
    const still = (await get(`/api/student/conversations/${id}`, asAmal)).data.messages.find((m) => m.messageId === mine);
    expect(still).toMatchObject({ body: 'The homework', deletedAt: null });
  });

  it("the student unread badge counts only the student's threads", async () => {
    const own = (await startThread({ teacherId: TEACHER_ID, subject: 'Lab', body: 'Question about the lab.' })).data.conversation.conversationId;
    await staffPost(own, asTeacher, 'Ask me tomorrow.');
    await staffPost(own, asTeacher, 'Or now, actually: what is it?');
    // An adults-only thread about Amal, with unread messages for the family.
    const adult = (await expectStatus(call('post', '/api/messaging/conversations', asMom)
      .field('studentId', amalId).field('teacherId', TEACHER_ID).field('title', 'Private').field('body', 'A word, please.'), 201))
      .data.conversation.conversationId;
    await staffPost(adult, asTeacher, 'Sure.');
    // Bilal's thread with the same teacher.
    const bilals = (await startThread({ teacherId: TEACHER_ID, subject: 'Mine', body: 'Hello' }, asBilal)).data.conversation.conversationId;
    await staffPost(bilals, asTeacher, 'Hi Bilal');

    expect((await get('/api/student/conversations/unread-count', asAmal)).data).toEqual({ unreadConversations: 1, unreadMessages: 2 });
    expect((await get('/api/student/conversations/unread-count', asBilal)).data).toEqual({ unreadConversations: 1, unreadMessages: 1 });
    const items = (await get('/api/student/conversations', asAmal)).data.items;
    expect(items.map((c) => [c.conversationId, c.unreadCount])).toEqual([[own, 2]]);
    expect((await get('/api/student/conversations?unread=1', asAmal)).data.items.map((c) => c.conversationId)).toEqual([own]);

    // Opening the thread reads it (and cancels the pending email).
    expect(await pendingJobs(own)).toContain(AMAL_USER_ID);
    await get(`/api/student/conversations/${own}`, asAmal);
    expect((await get('/api/student/conversations/unread-count', asAmal)).data).toEqual({ unreadConversations: 0, unreadMessages: 0 });
    expect(await pendingJobs(own)).not.toContain(AMAL_USER_ID);
    // The parent's badge still counts the adults' thread and the student's.
    expect((await get('/api/messaging/conversations/unread-count', asMom)).data.unreadConversations).toBe(2);
    // POST /read works too.
    await staffPost(own, asTeacher, 'Still there?');
    expect((await send('post', `/api/student/conversations/${own}/read`, asAmal, undefined, 200)).data.lastReadAt).toBeTruthy();
    expect((await get('/api/student/conversations/unread-count', asAmal)).data.unreadMessages).toBe(0);
  });

  describe('fix round 1', () => {
    const ADMIN_LEAD_ID = '550e8400-e29b-41d4-a716-446655440020';
    const ADMIN_CO_ID = '550e8400-e29b-41d4-a716-446655440021';
    const AUNT_ID = '550e8400-e29b-41d4-a716-446655440022';
    const asAdminLead = { userId: ADMIN_LEAD_ID, username: 'Rami Principal', email: 'rami.principal@example.com', role: 'ADMIN' };

    it('an admin who leads or co-teaches one of the student\'s current classes is a target and can be messaged; a non-teaching admin is refused', async () => {
      await user(ADMIN_LEAD_ID, 'rami.principal@example.com', 'Rami', 'Principal', 'ADMIN');
      await user(ADMIN_CO_ID, 'laila.vice@example.com', 'Laila', 'Vice', 'ADMIN');
      const artId = await makeClass('Art', ADMIN_LEAD_ID);
      await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [artId, amalId]);
      await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [sciId, ADMIN_CO_ID]);
      // An admin who leads only Amal's past-term class is not a current teacher.
      await pool.query(`UPDATE classes SET teacher_id = $2 WHERE class_id = $1`, [pastId, ADMIN_ID]);

      const targets = (await get('/api/student/conversations/targets', asAmal)).data.teachers;
      expect(targets.map((t) => [t.name, t.classes.map((c) => c.subject)])).toEqual([
        ['Huda Homeroom', []],
        ['Laila Vice', ['Science']],
        ['Omar Coteacher', ['Science']],
        ['Rami Principal', ['Art']],
        ['Ziad Teacher', ['Science']],
      ]);
      expect(targets.map((t) => t.userId)).not.toContain(ADMIN_ID);

      // The teaching admins can be messaged, with the parents in the thread as always.
      const lead = (await startThread({ teacherId: ADMIN_LEAD_ID, subject: 'Paint', body: 'Can I bring my own brushes?' })).data;
      expect(lead.conversation).toMatchObject({ classId: artId, leadTeacherName: 'Rami Principal', includesStudent: true });
      expect(sorted(lead.participants.map((p) => p.userId))).toEqual(sorted([MOM_ID, DAD_ID, AMAL_USER_ID, ADMIN_LEAD_ID]));
      expect(await pendingJobs(lead.conversation.conversationId)).toEqual(sorted([MOM_ID, DAD_ID, ADMIN_LEAD_ID]));
      const co = (await startThread({ teacherId: ADMIN_CO_ID, classId: sciId, subject: 'Lab', body: 'Is the lab open at lunch?' })).data;
      expect(sorted(co.participants.map((p) => p.userId)))
        .toEqual(sorted([MOM_ID, DAD_ID, AMAL_USER_ID, TEACHER_ID, CO_TEACHER_ID, ADMIN_CO_ID]));
      await startThread({ teacherId: ADMIN_LEAD_ID, classId: sciId, subject: 'Hi', body: 'x' }, asAmal, 400); // not this class

      // The teaching admin answers in their inbox; no "joined" line (they teach the class).
      const answered = (await staffPost(lead.conversation.conversationId, asAdminLead, 'Yes, bring them.')).data;
      expect(answered.messages.map((m) => m.kind)).toEqual(['message', 'message']);

      // A non-teaching admin, and the admin of the past-term class, are refused.
      const refused = 'You can message your own teachers only.';
      expect((await startThread({ teacherId: ADMIN_ID, subject: 'Hi', body: 'Hello' }, asAmal, 403)).message).toBe(refused);
      // Bilal has no class with either teaching admin except Laila's Science.
      expect((await startThread({ teacherId: ADMIN_LEAD_ID, subject: 'Hi', body: 'Hello' }, asBilal, 403)).message).toBe(refused);
      await startThread({ teacherId: ADMIN_CO_ID, subject: 'Hi', body: 'Hello' }, asBilal, 201);
    });

    it('an admin who is the homeroom teacher is a target like a homeroom teacher, with the parents in the thread', async () => {
      await user(ADMIN_LEAD_ID, 'rami.principal@example.com', 'Rami', 'Principal', 'ADMIN');
      // Bilal's homeroom teacher is an admin who teaches none of his classes.
      await pool.query(`UPDATE students SET homeroom_teacher_id = $2 WHERE student_id = $1`, [bilalId, ADMIN_LEAD_ID]);

      const targets = (await get('/api/student/conversations/targets', asBilal)).data.teachers;
      expect(targets.find((t) => t.userId === ADMIN_LEAD_ID)).toEqual({ userId: ADMIN_LEAD_ID, name: 'Rami Principal', avatar: null, classes: [] });
      const thread = (await startThread({ teacherId: ADMIN_LEAD_ID, subject: 'Bus', body: 'My bus was late.' }, asBilal)).data;
      expect(thread.conversation).toMatchObject({ classId: null, teacherId: ADMIN_LEAD_ID, includesStudent: true });
      expect(sorted(thread.participants.map((p) => p.userId))).toEqual(sorted([RANIA_ID, BILAL_USER_ID, ADMIN_LEAD_ID]));
      expect(await pendingJobs(thread.conversation.conversationId)).toEqual(sorted([RANIA_ID, ADMIN_LEAD_ID]));
      await startThread({ teacherId: ADMIN_LEAD_ID, classId: sciId, subject: 'Hi', body: 'x' }, asBilal, 400); // teaches no class of his

      // The admin is no one's target through Bilal's homeroom: Amal is refused.
      expect((await startThread({ teacherId: ADMIN_LEAD_ID, subject: 'Hi', body: 'Hello' }, asAmal, 403)).message)
        .toBe('You can message your own teachers only.');
    });

    it('guardians are derived at read time: one linked after the thread began is in it; one unlinked is out', async () => {
      await user(AUNT_ID, 'nadia.haddad@example.com', 'Nadia', 'Haddad', 'PARENT');
      const asAunt = { userId: AUNT_ID, username: 'Nadia Haddad', email: 'nadia.haddad@example.com', role: 'PARENT' };
      const id = (await startThread({ teacherId: TEACHER_ID, subject: 'Field trip', body: 'Do I need a lunch?' })).data.conversation.conversationId;
      await get(`/api/messaging/conversations/${id}`, asAunt, 403);

      await pool.query(
        `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school)
         VALUES ($1, $2, 'Nadia Haddad', 'nadia.haddad@example.com', 'Aunt', 'ALHAADIACADEMY')`, [AUNT_ID, amalId],
      );
      const opened = (await get(`/api/messaging/conversations/${id}`, asAunt)).data;
      expect(opened.participants.map((p) => p.userId)).toContain(AUNT_ID);
      expect((await get('/api/student/conversations/targets', asAmal)).data.guardians.map((g) => g.name)).toContain('Nadia Haddad');
      await staffPost(id, asTeacher, 'Yes, bring a lunch.');
      expect(await pendingJobs(id)).toContain(AUNT_ID);

      await pool.query(`DELETE FROM parent_students WHERE parent_id = $1`, [AUNT_ID]);
      await pool.query(`UPDATE message_email_jobs SET status = 'sent' WHERE conversation_id = $1`, [id]);
      await get(`/api/messaging/conversations/${id}`, asAunt, 403);
      await staffPost(id, asTeacher, 'And a hat.');
      expect(await pendingJobs(id)).not.toContain(AUNT_ID);
      expect(await pendingJobs(id)).toEqual(expect.arrayContaining([MOM_ID, DAD_ID, AMAL_USER_ID]));

      // An archived guardian is not named in the student's compose note.
      await pool.query(`UPDATE users SET is_archived = TRUE WHERE user_id = $1`, [DAD_ID]);
      expect((await get('/api/student/conversations/targets', asAmal)).data.guardians).toEqual([{ name: 'Mona Haddad', relation: 'Mother' }]);
    });

    it('an item with messages stays an assignment or quiz (409), so the thread keeps its anchor', async () => {
      await pool.query(`UPDATE school_classroom_settings SET parents_read_private_comments = FALSE WHERE school = 'ALHAADIACADEMY'`);
      const catId = (await pool.query(
        `INSERT INTO assessments (class_id, name, is_parent, weight_points) VALUES ($1, 'Tests', TRUE, 40) RETURNING assessment_id`, [sciId],
      )).rows[0].assessment_id;
      const item = await createItem(sciId, { kind: 'assignment', title: 'Private one', submissionMode: 'text', dueAt: inDays(3) });
      const conv = (await send('post', `/api/student/items/${item.itemId}/thread/messages`, asAmal, { body: 'A question' }, 201)).data.conversation.conversationId;

      const toAssessment = await call('patch', `/api/classroom/items/${item.itemId}`, asTeacher)
        .send({ kind: 'assessment', title: 'Private one', date: '2026-10-20', gradebook: { mode: 'category', categoryId: catId, maxScore: 10 } });
      expect([toAssessment.status, toAssessment.body.code]).toEqual([409, 'ITEM_HAS_MESSAGES']);
      const toMaterial = await call('patch', `/api/classroom/items/${item.itemId}`, asTeacher).send({ kind: 'material', title: 'Private one' });
      expect([toMaterial.status, toMaterial.body.code]).toEqual([409, 'ITEM_HAS_MESSAGES']);
      // Other edits, and assignment ↔ quiz, are fine.
      await send('patch', `/api/classroom/items/${item.itemId}`, asTeacher, { title: 'Private one (v2)' }, 200);
      // Deleting the item soft-deletes it: the anchor and the guardians' exclusion stay.
      await send('delete', `/api/classroom/items/${item.itemId}`, asTeacher, undefined, 200);
      const { rows: [row] } = await pool.query(`SELECT classwork_item_id FROM conversations WHERE conversation_id = $1`, [conv]);
      expect(row.classwork_item_id).toBe(item.itemId);
      await get(`/api/messaging/conversations/${conv}`, asMom, 403);

      // An item with no messages may still change kind.
      const plain = await createItem(sciId, { kind: 'assignment', title: 'No messages', submissionMode: 'text' });
      await send('patch', `/api/classroom/items/${plain.itemId}`, asTeacher, { kind: 'material', title: 'No messages' }, 200);
    });

    it('a teacher cannot start a thread about work the students cannot see yet (409 ITEM_NOT_POSTED)', async () => {
      const draft = await createItem(sciId, { kind: 'assignment', title: 'Not yet', submissionMode: 'done', status: 'draft' });
      const res = await call('post', `/api/classroom/items/${draft.itemId}/students/${amalId}/thread`, asTeacher);
      expect([res.status, res.body.code]).toEqual([409, 'ITEM_NOT_POSTED']);
      expect((await get(`/api/classroom/items/${draft.itemId}/students/${amalId}/thread`, asTeacher)).data)
        .toEqual({ conversationId: null, messageCount: 0 });
      // Posted: the thread can start.
      await send('patch', `/api/classroom/items/${draft.itemId}`, asTeacher, { status: 'posted' }, 200);
      await send('post', `/api/classroom/items/${draft.itemId}/students/${amalId}/thread`, asTeacher, undefined, 201);
    });

    it("the student's badge counts this year's threads, like the list", async () => {
      const id = (await startThread({ teacherId: TEACHER_ID, subject: 'This year', body: 'Hello' })).data.conversation.conversationId;
      await staffPost(id, asTeacher, 'Hi');
      // Last year's row of Amal, linked to the same login, with an unread thread.
      const pastYear = (await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         SELECT 'ALHAADIACADEMY', school_id, '2019-2020', DATE '2019-09-01', DATE '2020-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY' RETURNING school_year_id`,
      )).rows[0].school_year_id;
      const oldRow = (await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amal Haddad', '4', 'ALHAADIACADEMY', $1) RETURNING student_id`, [pastYear],
      )).rows[0].student_id;
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [AMAL_USER_ID, oldRow, pastYear]);
      const old = (await pool.query(
        `INSERT INTO conversations (school, student_id, teacher_id, kind, title, includes_student) VALUES ('ALHAADIACADEMY', $1, $2, 'general', 'Last year', TRUE)
         RETURNING conversation_id`, [oldRow, TEACHER_ID],
      )).rows[0].conversation_id;
      await pool.query(`INSERT INTO messages (conversation_id, sender_id, sender_role, body) VALUES ($1, $2, 'TEACHER', 'Old news')`, [old, TEACHER_ID]);

      expect((await get('/api/student/conversations', asAmal)).data.items.map((c) => c.conversationId)).toEqual([id]);
      expect((await get('/api/student/conversations/unread-count', asAmal)).data).toEqual({ unreadConversations: 1, unreadMessages: 1 });
    });
  });

  it("staff thread rows and the student context card carry the student's displayed avatar (studentAvatar)", async () => {
    const teacherSet = { style: 'curly', skin: 2, bg: 1 };
    const ownPick = { style: 'kufi', skin: 4, bg: 6 };
    await pool.query(`UPDATE students SET avatar = $2::jsonb WHERE student_id = $1`, [amalId, JSON.stringify(teacherSet)]);
    const id = (await startThread({ teacherId: TEACHER_ID, classId: sciId, subject: 'Lab', body: 'Can I stay late?' })).data.conversation.conversationId;
    const row = async (who) => (await get('/api/messaging/conversations?status=all', who)).data.find((r) => r.conversationId === id);
    expect((await row(asTeacher)).studentAvatar).toEqual(teacherSet);
    expect((await row(asAdmin)).studentAvatar).toEqual(teacherSet);
    expect((await get(`/api/messaging/conversations/${id}`, asTeacher)).data.student).toMatchObject({ studentId: amalId, studentAvatar: teacherSet });
    // The student's own pick wins once there is one.
    await pool.query(`UPDATE users SET avatar = $2::jsonb WHERE user_id = $1`, [AMAL_USER_ID, JSON.stringify(ownPick)]);
    expect((await row(asTeacher)).studentAvatar).toEqual(ownPick);
    expect((await get(`/api/messaging/conversations/${id}`, asTeacher)).data.student.studentAvatar).toEqual(ownPick);
  });

  it("the admin inbox names each thread's addressee: a co-teacher or homeroom teacher, not only the class lead", async () => {
    const co = (await startThread({ teacherId: CO_TEACHER_ID, classId: sciId, subject: 'Lab', body: 'Can I stay late?' })).data.conversation.conversationId;
    const home = (await startThread({ teacherId: HOMEROOM_ID, subject: 'Bus', body: 'The bus was late.' })).data.conversation.conversationId;
    const rows = (await get('/api/messaging/conversations?status=all', asAdmin)).data;
    const byId = Object.fromEntries(rows.map((r) => [r.conversationId, r]));
    expect(byId[co]).toMatchObject({ leadTeacherName: 'Ziad Teacher', addresseeName: 'Omar Coteacher' });
    expect(byId[home]).toMatchObject({ addresseeName: 'Huda Homeroom' });
    // Teachers' and parents' list rows are unchanged.
    expect((await get('/api/messaging/conversations', asTeacher)).data.find((r) => r.conversationId === co)).not.toHaveProperty('addresseeName');
  });

  describe('email digests on student threads', () => {
    const notifier = require('../../../services/messageNotifier');
    const { getResend } = require('../../../utils/emailUtils');
    // Postgres keeps microseconds and a JS Date keeps milliseconds. Pin a
    // non-zero microsecond part so every run exercises the precision gap.
    const withMicros = (id) => pool.query(
      `UPDATE messages SET created_at = date_trunc('milliseconds', created_at) + interval '228 microseconds' WHERE conversation_id = $1`, [id]);
    const makeDue = (id) => pool.query(
      `UPDATE message_email_jobs SET send_after = NOW() - interval '1 minute' WHERE conversation_id = $1 AND status = 'pending'`, [id]);

    it('S10: subjects read naturally on student threads (never "Amal Haddad sent a message about Amal Haddad\'s …")', async () => {
      const resend = getResend().emails.send;
      const subjectsTo = (email) => resend.mock.calls.map(([e]) => e).filter((e) => e.to[0] === email).map((e) => e.subject);
      resend.mockClear();
      const general = (await startThread({ teacherId: TEACHER_ID, classId: sciId, subject: 'Question about the quiz', body: 'Is it open book?' })).data.conversation.conversationId;
      await makeDue(general);
      await notifier.drainAll();
      expect(subjectsTo('ziad.teacher@example.com')).toEqual(['New message from Amal Haddad: Question about the quiz']);
      expect(subjectsTo('mona.haddad@example.com')).toEqual(['New message from Amal Haddad: Question about the quiz']);

      // Two replies before the digest goes: one email that counts them.
      resend.mockClear();
      await staffPost(general, asTeacher, 'Yes, open book.');
      await staffPost(general, asTeacher, 'Bring your notes.');
      await makeDue(general);
      await notifier.drainAll();
      expect(subjectsTo('mona.haddad@example.com')).toEqual(['2 new messages: Question about the quiz']);
      expect(subjectsTo('amal.haddad@example.com')).toEqual(['2 new messages: Question about the quiz']);

      // About a piece of work: the student's own message drops the possessive; a teacher's keeps whose work it is.
      resend.mockClear();
      const item = await createItem(sciId, { kind: 'assignment', title: 'Plant cell diagram', submissionMode: 'file', dueAt: inDays(3) });
      const thread = (await send('post', `/api/student/items/${item.itemId}/thread/messages`, asAmal, { body: 'Do we label the vacuole?' }, 201))
        .data.conversation.conversationId;
      await makeDue(thread);
      await notifier.drainAll();
      expect(subjectsTo('ziad.teacher@example.com')).toEqual(['Amal Haddad sent a message about Plant cell diagram']);
      resend.mockClear();
      await staffPost(thread, asTeacher, 'Yes, label it.');
      await makeDue(thread);
      await notifier.drainAll();
      expect(subjectsTo('mona.haddad@example.com')).toEqual(["Ziad Teacher sent a message about Amal Haddad's Plant cell diagram"]);
      expect(subjectsTo('amal.haddad@example.com')).toEqual(['Ziad Teacher sent you a message about Plant cell diagram']);
    }, 30000);

    it('a student-started thread emails each message once (microsecond timestamps never re-queue it), the student included', async () => {
      const resend = getResend().emails.send;
      resend.mockClear();
      const id = (await startThread({ teacherId: TEACHER_ID, classId: sciId, subject: 'Lab partner', body: 'Can I switch lab partners?' })).data.conversation.conversationId;
      await withMicros(id);
      await makeDue(id);
      expect(await notifier.drainAll()).toBe(4);
      expect(resend.mock.calls.map(([e]) => e.to[0]).sort()).toEqual(
        ['mona.haddad@example.com', 'omar.coteacher@example.com', 'sami.haddad@example.com', 'ziad.teacher@example.com']);
      expect(await pendingJobs(id)).toEqual([]);
      await makeDue(id);
      expect(await notifier.drainAll()).toBe(0);
      expect(resend).toHaveBeenCalledTimes(4);

      // The teacher replies: the student (and the parents and co-teacher) get one email each, with only the reply.
      resend.mockClear();
      await staffPost(id, asTeacher, 'Yes, see me at lunch.');
      await withMicros(id);
      await makeDue(id);
      expect(await notifier.drainAll()).toBe(4);
      const toStudent = resend.mock.calls.map(([e]) => e).find((e) => e.to[0] === 'amal.haddad@example.com');
      expect(toStudent).toBeTruthy();
      expect(toStudent.html).toContain('Yes, see me at lunch.');
      expect(toStudent.html).not.toContain('Can I switch lab partners?');
      expect(await pendingJobs(id)).toEqual([]);
      await makeDue(id);
      expect(await notifier.drainAll()).toBe(0);
      expect(resend).toHaveBeenCalledTimes(4);
    }, 30000);
  });
});
