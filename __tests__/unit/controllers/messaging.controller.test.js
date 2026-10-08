const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const supabase = require('../../../config/supabaseClient'); // mapped to the mock
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockParentUser, mockTeacherUser, mockAdminUser } = require('../../helpers/mockAuth');

const SCHOOL = 'ALHAADIACADEMY';
const PARENT = '550e8400-e29b-41d4-a716-446655440002';
const TEACHER = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_PARENT = '66666666-6666-4666-8666-666666666666';
const STUDENT = '11111111-1111-4111-8111-111111111111';
const CLASS = '22222222-2222-4222-8222-222222222222';
const ASSESSMENT = '33333333-3333-4333-8333-333333333333';
const CONVO = '44444444-4444-4444-8444-444444444444';
const MESSAGE = '55555555-5555-4555-8555-555555555555';

/**
 * A tiny in-memory "database": each test declares the rows a query fragment
 * returns, and every call is recorded so assertions can check what ran.
 */
function makeRouter(overrides = {}) {
  const calls = [];
  const defaults = {
    'CROSS JOIN students': [{
      class_id: CLASS, school: SCHOOL, class_subject: 'Math', lead_teacher_id: TEACHER,
      student_id: STUDENT, student_name: 'Amina Test', student_school: SCHOOL,
      assessment_id: ASSESSMENT, assessment_name: 'Unit 3 Quiz', is_published: true, is_parent: false,
      assessment_in_class: true, student_in_class: true, is_guardian: true, is_co_teacher: false,
    }],
    'SELECT conversation_id, status FROM conversations': [],
    'INSERT INTO conversations': [{ conversation_id: CONVO }],
    'AS admin_participant_ids': [{
      conversation_id: CONVO, school: SCHOOL, student_id: STUDENT, student_name: 'Amina Test', class_id: CLASS,
      class_subject: 'Math', assessment_id: ASSESSMENT, title: 'Unit 3 Quiz', status: 'open',
      lead_teacher_id: TEACHER, co_teacher_ids: [], guardian_ids: [PARENT, OTHER_PARENT], admin_participant_ids: [],
      school_year_id: 'y1', last_message_at: '2026-10-07T12:00:00Z', created_at: '2026-10-07T12:00:00Z',
    }],
    'INSERT INTO messages': [{ message_id: MESSAGE, created_at: '2026-10-07T12:00:00Z' }],
    'INSERT INTO message_attachments': [{ attachment_id: 'att-1' }],
    'AS sender_relation': [{
      message_id: MESSAGE, sender_id: PARENT, sender_role: 'PARENT', kind: 'message', body: 'Hello',
      created_at: '2026-10-07T12:00:00Z', edited_at: null, deleted_at: null, sender_name: 'Layla Test', sender_relation: 'Mother',
    }],
    'UNION': [
      { user_id: PARENT, name: 'Layla Test', role: 'PARENT', relation: 'Mother' },
      { user_id: TEACHER, name: 'Ahmed Khan', role: 'TEACHER', relation: null },
    ],
    'SELECT last_read_at, last_emailed_at, muted': [],
    'AS class_avg_pct': [{
      assessment_id: ASSESSMENT, name: 'Unit 3 Quiz', date: '2026-10-03', weight_points: 10, max_score: 20,
      is_published: true, parent_comment: 'Nice', published_at: '2026-10-03', score: 14, class_avg_pct: '76.0',
    }],
    'WHERE message_id = ANY': [],
    'DO UPDATE SET last_read_at': [{ last_read_at: '2026-10-07T12:00:01Z' }],
  };
  const table = { ...defaults, ...overrides };
  const impl = (sql, params) => {
    calls.push({ sql, params });
    for (const [frag, rows] of Object.entries(table)) {
      if (sql.includes(frag)) return Promise.resolve({ rows: typeof rows === 'function' ? rows(params) : rows, rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('FROM school_years')) return Promise.resolve({ rows: [{ school_year_id: 'y1', school: SCHOOL, is_active: true }] });
    return impl(sql, params);
  });
  db._mockClient.query.mockImplementation(impl);
  const ran = (frag) => calls.filter((c) => c.sql.includes(frag));
  return { calls, ran };
}

const png = Buffer.from('89504e470d0a1a0a', 'hex');

describe('messaging controller', () => {
  beforeEach(() => { db._reset(); supabase._reset(); });

  describe('POST /api/messaging/conversations', () => {
    it('lets a guardian start a thread on a published assessment and emails the teachers, not the sender', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Hello teacher');
      expect(res.status).toBe(201);
      expect(res.body.data.conversation.conversationId).toBe(CONVO);
      expect(res.body.data.messages).toHaveLength(1);
      expect(r.ran('INSERT INTO conversations')).toHaveLength(1);
      const [enqueue] = r.ran('INSERT INTO message_email_jobs');
      expect(enqueue.params[1].sort()).toEqual([TEACHER, OTHER_PARENT].sort());
      expect(enqueue.params[1]).not.toContain(PARENT);
    });

    it('refuses a parent on an unpublished assessment', async () => {
      makeRouter({ 'CROSS JOIN students': [{ class_id: CLASS, school: SCHOOL, student_school: SCHOOL, assessment_id: ASSESSMENT, assessment_in_class: true, student_in_class: true, is_guardian: true, is_published: false, is_parent: false, lead_teacher_id: TEACHER, assessment_name: 'Q' }] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Hi');
      expect(res.status).toBe(403);
    });

    it('lets the lead teacher start a thread on an unpublished assessment', async () => {
      makeRouter({ 'CROSS JOIN students': [{ class_id: CLASS, school: SCHOOL, student_school: SCHOOL, assessment_id: ASSESSMENT, assessment_in_class: true, student_in_class: true, is_guardian: false, is_published: false, is_parent: false, lead_teacher_id: TEACHER, is_co_teacher: false, assessment_name: 'Q' }] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockTeacherUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Heads up');
      expect(res.status).toBe(201);
    });

    it('returns the existing thread (200) and appends when the anchor already has one', async () => {
      const r = makeRouter({ 'SELECT conversation_id, status FROM conversations': [{ conversation_id: CONVO, status: 'open' }] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Again');
      expect(res.status).toBe(200);
      expect(r.ran('INSERT INTO conversations')).toHaveLength(0);
      expect(r.ran('INSERT INTO messages')).toHaveLength(1);
    });

    it('rejects an empty body with no files and a body over 5000 characters', async () => {
      makeRouter();
      let res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', '   ');
      expect(res.status).toBe(400);
      res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'x'.repeat(5001));
      expect(res.status).toBe(400);
    });

    it('rejects a file whose declared type does not match its extension and stores nothing', async () => {
      makeRouter();
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'see attached')
        .attach('files', png, { filename: 'notes.pdf', contentType: 'image/png' });
      expect(res.status).toBe(400);
      expect(supabase._mockStorage.upload).not.toHaveBeenCalled();
    });

    it('uploads an accepted image under the school/conversation/message path', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', '')
        .attach('files', png, { filename: 'sheet.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      expect(supabase._mockStorage.upload).toHaveBeenCalledTimes(1);
      expect(supabase._mockStorage.upload.mock.calls[0][0]).toMatch(new RegExp(`^${SCHOOL}/${CONVO}/${MESSAGE}/[0-9a-f-]+\\.png$`));
      expect(r.ran('INSERT INTO message_attachments')).toHaveLength(1);
    });
  });

  describe('GET /api/messaging/conversations/:id', () => {
    it('hides the score from a parent when the assessment is unpublished', async () => {
      makeRouter({ 'AS class_avg_pct': [{ assessment_id: ASSESSMENT, name: 'Q', max_score: 20, score: 14, is_published: false, parent_comment: 'x', class_avg_pct: '70.0' }] });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/${CONVO}`, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.context.score).toBeNull();
      expect(res.body.data.context.pct).toBeNull();
      expect(res.body.data.context.parentComment).toBeNull();
      expect(res.body.data.context.classAvgPct).toBeNull();
      // Spec: name only until published.
      expect(res.body.data.context.maxScore).toBeNull();
      expect(res.body.data.context.weightPoints).toBeNull();
      expect(res.body.data.context.date).toBeNull();
    });

    it('signs all attachments in one batched call', async () => {
      makeRouter({ 'WHERE message_id = ANY': [
        { attachment_id: 'at1', message_id: MESSAGE, file_path: 'p/1.png', file_name: '1.png', mime_type: 'image/png', size_bytes: 10 },
        { attachment_id: 'at2', message_id: MESSAGE, file_path: 'p/2.pdf', file_name: '2.pdf', mime_type: 'application/pdf', size_bytes: 10 },
      ] });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/${CONVO}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(supabase._mockStorage.createSignedUrls).toHaveBeenCalledTimes(1);
      expect(supabase._mockStorage.createSignedUrls.mock.calls[0][0]).toEqual(['p/1.png', 'p/2.pdf']);
      expect(res.body.data.messages[0].attachments.map((a) => a.url)).toEqual(['https://mock-signed-url.com/p/1.png', 'https://mock-signed-url.com/p/2.pdf']);
    });

    it('gives staff the class average', async () => {
      makeRouter();
      const res = await authenticatedRequest('get', `/api/messaging/conversations/${CONVO}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data.context.classAvgPct).toBe(76);
      expect(res.body.data.context.pct).toBe(70);
    });
  });

  describe('POST /api/messaging/conversations/:id/messages', () => {
    it('posting cancels the sender\'s own pending email job and marks them read', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('post', `/api/messaging/conversations/${CONVO}/messages`, mockTeacherUser()).field('body', 'Reply');
      expect(res.status).toBe(201);
      const [cancel] = r.ran("last_error = 'read before send'");
      expect(cancel.params).toEqual([CONVO, TEACHER]);
      expect(r.ran('DO UPDATE SET last_read_at')[0].params).toEqual([CONVO, TEACHER]);
      expect(r.ran('INSERT INTO message_email_jobs')[0].params[1].sort()).toEqual([PARENT, OTHER_PARENT].sort());
    });

    it('records an admin joining with a system line the first time they post', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('post', `/api/messaging/conversations/${CONVO}/messages`, mockAdminUser()).field('body', 'Hello from the office');
      expect(res.status).toBe(201);
      const inserts = r.ran('INSERT INTO messages');
      expect(inserts).toHaveLength(2);
      expect(inserts[0].params[3]).toBe('system');
      expect(inserts[0].params[4]).toMatch(/joined the conversation/);
      expect(r.ran('INSERT INTO conversation_participants (conversation_id, user_id) VALUES')).toHaveLength(1);
    });
  });

  describe('PATCH / DELETE messages', () => {
    it('refuses an edit after 15 minutes', async () => {
      makeRouter({ 'SELECT message_id, sender_id, kind, created_at, deleted_at': [{ message_id: MESSAGE, sender_id: PARENT, kind: 'message', created_at: new Date(Date.now() - 16 * 60 * 1000).toISOString(), deleted_at: null }] });
      const res = await authenticatedRequest('patch', `/api/messaging/conversations/${CONVO}/messages/${MESSAGE}`, mockParentUser()).send({ body: 'edited' });
      expect(res.status).toBe(403);
    });

    it('edits within the window', async () => {
      makeRouter({
        'SELECT message_id, sender_id, kind, created_at, deleted_at': [{ message_id: MESSAGE, sender_id: PARENT, kind: 'message', created_at: new Date().toISOString(), deleted_at: null }],
        'SET body = $2': [{ edited_at: '2026-10-07T12:05:00Z' }],
      });
      const res = await authenticatedRequest('patch', `/api/messaging/conversations/${CONVO}/messages/${MESSAGE}`, mockParentUser()).send({ body: 'edited' });
      expect(res.status).toBe(200);
      expect(res.body.data.editedAt).toBe('2026-10-07T12:05:00Z');
    });

    it('refuses a delete by someone who is neither author nor admin', async () => {
      makeRouter({ 'SELECT message_id, sender_id, kind, created_at, deleted_at': [{ message_id: MESSAGE, sender_id: PARENT, kind: 'message', created_at: new Date().toISOString(), deleted_at: null }] });
      const res = await authenticatedRequest('delete', `/api/messaging/conversations/${CONVO}/messages/${MESSAGE}`, mockTeacherUser());
      expect(res.status).toBe(403);
    });

    it('lets an admin soft-delete and removes the files', async () => {
      const r = makeRouter({
        'SELECT message_id, sender_id, kind, created_at, deleted_at': [{ message_id: MESSAGE, sender_id: PARENT, kind: 'message', created_at: new Date().toISOString(), deleted_at: null }],
        'SELECT file_path FROM message_attachments': [{ file_path: 'p/1.png' }],
        'SET deleted_at = NOW()': [{ deleted_at: '2026-10-07T12:06:00Z' }],
      });
      const res = await authenticatedRequest('delete', `/api/messaging/conversations/${CONVO}/messages/${MESSAGE}`, mockAdminUser());
      expect(res.status).toBe(200);
      expect(supabase._mockStorage.remove).toHaveBeenCalledWith(['p/1.png']);
      expect(r.ran('SET deleted_at = NOW()')[0].params[1]).toBe('550e8400-e29b-41d4-a716-446655440000');
    });
  });

  describe('status, read, mute', () => {
    it('refuses a parent resolving a thread', async () => {
      makeRouter();
      const res = await authenticatedRequest('patch', `/api/messaging/conversations/${CONVO}`, mockParentUser()).send({ status: 'resolved' });
      expect(res.status).toBe(403);
    });

    it('lets staff resolve and writes a system line', async () => {
      const r = makeRouter({ 'SET status = $2::text': [{ status: 'resolved' }] });
      const res = await authenticatedRequest('patch', `/api/messaging/conversations/${CONVO}`, mockTeacherUser()).send({ status: 'resolved' });
      expect(res.status).toBe(200);
      expect(r.ran('INSERT INTO messages')[0].params[3]).toBe('system');
    });

    it('marking read upserts the participant row and cancels the pending job', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('post', `/api/messaging/conversations/${CONVO}/read`, mockParentUser());
      expect(res.status).toBe(200);
      expect(r.ran('DO UPDATE SET last_read_at')[0].params).toEqual([CONVO, PARENT]);
      expect(r.ran("last_error = 'read before send'")[0].params).toEqual([CONVO, PARENT]);
    });

    it('validates the mute flag', async () => {
      makeRouter();
      const res = await authenticatedRequest('patch', `/api/messaging/conversations/${CONVO}/mute`, mockParentUser()).send({ muted: 'yes' });
      expect(res.status).toBe(400);
    });
  });

  describe('lists and helpers', () => {
    it('lists with needsReply computed against the caller\'s side', async () => {
      makeRouter({
        'ORDER BY c.last_message_at DESC': [{
          conversation_id: CONVO, student_id: STUDENT, student_name: 'Amina Test', class_id: CLASS, class_subject: 'Math',
          assessment_id: ASSESSMENT, title: 'Q', status: 'open', last_message_at: 'x', created_at: 'x', lead_teacher_name: 'Ahmed Khan',
          unread_count: 2, last_real_sender_role: 'PARENT',
          last_message: { senderId: PARENT, senderRole: 'PARENT', kind: 'message', body: 'hi', deleted: false, createdAt: 'x', senderName: 'Layla' },
        }],
      });
      const res = await authenticatedRequest('get', '/api/messaging/conversations', mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data[0].needsReply).toBe(true);
      expect(res.body.data[0].unreadCount).toBe(2);
    });

    it('returns the unread summary', async () => {
      makeRouter({ 'AS unread_conversations': [{ unread_conversations: 1, unread_messages: 3, needs_reply: 1 }] });
      const res = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', mockParentUser());
      expect(res.body.data).toEqual({ unreadConversations: 1, unreadMessages: 3, needsReply: 1 });
    });

    it('scopes admin stubs by school and rejects malformed ids with 400', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('get', `/api/messaging/conversations/stubs?studentId=${STUDENT}`, mockAdminUser());
      expect(res.status).toBe(200);
      const [stubs] = r.ran('FROM conversations c') .filter((c) => c.sql.includes('AS unread_count') && c.params.length === 4);
      expect(stubs.params[3]).toBe(SCHOOL);
      expect((await authenticatedRequest('get', '/api/messaging/conversations?classId=not-a-uuid', mockTeacherUser())).status).toBe(400);
      expect((await authenticatedRequest('get', '/api/messaging/conversations/stubs?classId=nope', mockTeacherUser())).status).toBe(400);
      const bad = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', 'nope').field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'x');
      expect(bad.status).toBe(400);
    });

    it('creates the conversation with an upsert on the anchor so concurrent starts cannot 500', async () => {
      const r = makeRouter();
      await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Hello');
      expect(r.ran('INSERT INTO conversations')[0].sql).toMatch(/ON CONFLICT \(student_id, class_id, assessment_id\)/);
    });

    it('needsReply ignores deleted and system messages', async () => {
      makeRouter({
        'ORDER BY c.last_message_at DESC': [{
          conversation_id: CONVO, student_id: STUDENT, student_name: 'Amina Test', class_id: CLASS, class_subject: 'Math',
          assessment_id: ASSESSMENT, title: 'Q', status: 'open', last_message_at: 'x', created_at: 'x', lead_teacher_name: 'Ahmed Khan',
          unread_count: 0, last_real_sender_role: 'TEACHER',
          last_message: { senderId: PARENT, senderRole: 'PARENT', kind: 'message', body: null, deleted: true, createdAt: 'x', senderName: 'Layla' },
        }],
      });
      const res = await authenticatedRequest('get', '/api/messaging/conversations', mockTeacherUser());
      expect(res.body.data[0].needsReply).toBe(false);
    });

    it('parent targets require a link to the student', async () => {
      makeRouter({ 'SELECT 1 FROM parent_students WHERE student_id = $1 AND parent_id = $2': [] });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockParentUser());
      expect(res.status).toBe(403);
    });
  });
});
