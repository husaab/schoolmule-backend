jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => global.__mockInviteSend(...args) } })),
}));
global.__mockInviteSend = jest.fn().mockResolvedValue({ data: { id: 'email-1' } });

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
      assessment_in_class: true, student_in_class: true, is_guardian: true, is_co_teacher: false, in_current_term: true,
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
  // Overrides are checked before defaults so a test can pin a fragment that a
  // default would otherwise match first (e.g. 'UNION').
  const table = [...Object.entries(overrides), ...Object.entries(defaults).filter(([k]) => !(k in overrides))];
  const impl = (sql, params) => {
    calls.push({ sql, params });
    for (const [frag, rows] of table) {
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

const HOMEROOM = '77777777-7777-4777-8777-777777777777';
const LINK = '88888888-8888-4888-8888-888888888888';
const ADMIN = '99999999-9999-4999-8999-999999999999';

describe('messaging controller', () => {
  beforeEach(() => { db._reset(); supabase._reset(); global.__mockInviteSend.mockClear(); });

  it('unread-count folds in unread announcements from the announcement query', async () => {
    makeRouter({
      'AS unread_conversations': [{ unread_conversations: 2, unread_messages: 5, needs_reply: 1 }],
      'AS unread_announcements': [{ unread_announcements: 3 }],
    });
    const res = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', mockParentUser());
    expect(res.body.data).toEqual({ unreadConversations: 2, unreadMessages: 5, needsReply: 1, unreadAnnouncements: 3 });
  });

  describe('general threads (phase 2)', () => {
    const generalCtx = (over = {}) => ({
      student_id: STUDENT, student_name: 'Amina Test', student_school: SCHOOL,
      teacher_school: SCHOOL, teacher_role: 'TEACHER', teacher_archived: false, teacher_name: 'Sana Rahman',
      is_homeroom: true, class_id: null, is_guardian: true, caller_teaches: false, ...over,
    });
    const generalAccess = {
      conversation_id: CONVO, school: SCHOOL, student_id: STUDENT, student_name: 'Amina Test', class_id: null,
      class_subject: 'Homeroom', assessment_id: null, kind: 'general', teacher_id: HOMEROOM, title: 'Away Thursday', status: 'open',
      lead_teacher_id: HOMEROOM, co_teacher_ids: [], guardian_ids: [PARENT], admin_participant_ids: [],
      school_year_id: 'y1', last_message_at: '2026-10-07T12:00:00Z', created_at: '2026-10-07T12:00:00Z',
    };

    it('lets a guardian start a general thread with the homeroom teacher (no class row)', async () => {
      const r = makeRouter({ 'CROSS JOIN users t': [generalCtx()], 'AS admin_participant_ids': [generalAccess], "kind, title, created_by)": [{ conversation_id: CONVO }] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'Away Thursday').field('body', 'Sara will be away');
      expect(res.status).toBe(201);
      const [ins] = r.ran("kind, title, created_by)");
      expect(ins.params).toEqual([SCHOOL, STUDENT, null, HOMEROOM, 'Away Thursday', PARENT]);
      expect(res.body.data.conversation.kind).toBe('general');
      expect(res.body.data.context).toBeNull();
      expect(r.ran('INSERT INTO message_email_jobs')[0].params[1]).toEqual([HOMEROOM]);
    });

    it('rejects a teacher who neither teaches the child nor is their homeroom teacher', async () => {
      makeRouter({ 'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: null })] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'Hi').field('body', 'x');
      expect(res.status).toBe(403);
    });

    it('requires a title between 1 and 120 characters', async () => {
      makeRouter({ 'CROSS JOIN users t': [generalCtx()] });
      let res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', '  ').field('body', 'x');
      expect(res.status).toBe(400);
      res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'x'.repeat(121)).field('body', 'x');
      expect(res.status).toBe(400);
    });

    it('a staff caller must teach the student (or be admin)', async () => {
      makeRouter({ 'CROSS JOIN users t': [generalCtx({ caller_teaches: false, is_guardian: false })] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockTeacherUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'Planner').field('body', 'x');
      expect(res.status).toBe(403);
    });

    it('staff targets for one student list the classes the caller teaches, each with its assessments', async () => {
      const r = makeRouter({
        'FROM students s WHERE s.student_id = $1': [{ student_id: STUDENT, name: 'Amina Test', school: SCHOOL, homeroom_teacher_id: HOMEROOM }],
        'CROSS JOIN users t': [generalCtx({ caller_teaches: true })],
        'GROUP BY s.student_id, s.name': [{ student_id: STUDENT, name: 'Amina Test', guardians: [] }],
        'AS caller_teaches\n    FROM class_students cs': [
          { class_id: CLASS, subject: 'Math', grade: '6', caller_teaches: true },
          { class_id: 'other-class', subject: 'Science', grade: '6', caller_teaches: false },
        ],
        'WHERE class_id = ANY($1::uuid[])': [{ class_id: CLASS, assessment_id: ASSESSMENT, name: 'Unit 3 Quiz', date: null, is_published: true }],
      });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data.classes).toEqual([{ classId: CLASS, subject: 'Math', assessments: [{ assessmentId: ASSESSMENT, name: 'Unit 3 Quiz', date: null, isPublished: true }] }]);
      expect(r.ran('WHERE class_id = ANY($1::uuid[])')[0].params).toEqual([[CLASS]]);
    });

    it('a General thread may name the class it is about, validated against the student and teacher', async () => {
      const r = makeRouter({
        'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: 'auto-class', caller_teaches: true })],
        'AS teacher_teaches\n    FROM classes cl WHERE cl.class_id = $1': [{ class_id: CLASS, school: SCHOOL, has_student: true, teacher_teaches: true }],
        'AS admin_participant_ids': [{ ...generalAccess, class_id: CLASS, class_subject: 'Math', teacher_id: TEACHER, lead_teacher_id: TEACHER }],
        "kind, title, created_by)": [{ conversation_id: CONVO }],
      });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockTeacherUser())
        .field('studentId', STUDENT).field('teacherId', TEACHER).field('classId', CLASS).field('title', 'Planner').field('body', 'x');
      expect(res.status).toBe(201);
      expect(r.ran("kind, title, created_by)")[0].params[2]).toBe(CLASS);

      makeRouter({
        'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: 'auto-class', caller_teaches: true })],
        'AS teacher_teaches\n    FROM classes cl WHERE cl.class_id = $1': [{ class_id: CLASS, school: SCHOOL, has_student: false, teacher_teaches: true }],
      });
      const bad = await authenticatedRequest('post', '/api/messaging/conversations', mockTeacherUser())
        .field('studentId', STUDENT).field('teacherId', TEACHER).field('classId', CLASS).field('title', 'Planner').field('body', 'x');
      expect(bad.status).toBe(400);
    });

    const ANN = '99999999-9999-4999-8999-999999999991';
    const annCtx = (over = {}) => ({ announcement_id: ANN, author_id: HOMEROOM, scope: 'school', class_id: null, school: SCHOOL, deleted_at: null, student_in_audience: true, is_guardian: true, ...over });

    it('a parent may ask the author of a school-wide announcement even though they teach none of their children', async () => {
      const r = makeRouter({
        'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: null, teacher_role: 'ADMIN' })],
        'AS student_in_audience': [annCtx()],
        'AS admin_participant_ids': [generalAccess],
        'kind, title, created_by)': [{ conversation_id: CONVO }],
      });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'Re: PA Day').field('body', 'Is care open?').field('announcementId', ANN);
      expect(res.status).toBe(201);
      expect(r.ran('AS student_in_audience')[0].params).toEqual([ANN, PARENT, STUDENT]);
      expect(r.ran('kind, title, created_by)')[0].params[2]).toBeNull();
    });

    it('refuses when the teacher is not the author, the child is outside the audience, or the announcement was removed', async () => {
      makeRouter({ 'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: null })], 'AS student_in_audience': [annCtx({ author_id: TEACHER })] });
      let res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'x').field('body', 'x').field('announcementId', ANN);
      expect(res.status).toBe(403);
      makeRouter({ 'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: null })], 'AS student_in_audience': [annCtx({ student_in_audience: false })] });
      res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'x').field('body', 'x').field('announcementId', ANN);
      expect(res.status).toBe(403);
      makeRouter({ 'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: null })], 'AS student_in_audience': [annCtx({ deleted_at: '2026-10-08T00:00:00Z' })] });
      res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'x').field('body', 'x').field('announcementId', ANN);
      expect(res.status).toBe(404);
    });

    it('a class announcement anchors the thread to that class; staff callers may not pass announcementId', async () => {
      const r = makeRouter({
        'CROSS JOIN users t': [generalCtx({ is_homeroom: false, class_id: null })],
        'AS student_in_audience': [annCtx({ scope: 'class', class_id: CLASS })],
        'AS admin_participant_ids': [generalAccess], 'kind, title, created_by)': [{ conversation_id: CONVO }],
      });
      let res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'x').field('body', 'x').field('announcementId', ANN);
      expect(res.status).toBe(201);
      expect(r.ran('kind, title, created_by)')[0].params[2]).toBe(CLASS);
      makeRouter({ 'CROSS JOIN users t': [generalCtx({ caller_teaches: true })] });
      res = await authenticatedRequest('post', '/api/messaging/conversations', mockTeacherUser())
        .field('studentId', STUDENT).field('teacherId', HOMEROOM).field('title', 'x').field('body', 'x').field('announcementId', ANN);
      expect(res.status).toBe(400);
    });

    it('parent targets list the teachers they may write to', async () => {
      makeRouter({
        'SELECT 1 FROM parent_students WHERE student_id = $1 AND parent_id = $2': [{ ok: 1 }],
        "'Homeroom' AS via": [
          { user_id: HOMEROOM, name: 'Sana Rahman', via: 'Homeroom', role: 'TEACHER' },
          { user_id: TEACHER, name: 'Ahmed Khan', via: 'Math', role: 'TEACHER' },
          { user_id: ADMIN, name: 'Pat Principal', via: 'Principal', role: 'ADMIN' },
        ],
      });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.teachers).toEqual([
        { userId: HOMEROOM, name: 'Sana Rahman', via: 'Homeroom', role: 'TEACHER' },
        { userId: TEACHER, name: 'Ahmed Khan', via: 'Math', role: 'TEACHER' },
        { userId: ADMIN, name: 'Pat Principal', via: 'Principal', role: 'ADMIN' },
      ]);
    });

    it('a parent may write to an admin with a staff title, never to one without', async () => {
      makeRouter({
        'CROSS JOIN users t': [generalCtx({ teacher_role: 'ADMIN', teacher_staff_title: 'Principal', is_homeroom: false, class_id: null, is_guardian: true })],
      });
      const ok = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', ADMIN).field('title', 'Bus pass').field('body', 'x');
      expect(ok.status).toBe(201);

      makeRouter({
        'CROSS JOIN users t': [generalCtx({ teacher_role: 'ADMIN', teacher_staff_title: null, is_homeroom: false, class_id: null, is_guardian: true })],
      });
      const bad = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', ADMIN).field('title', 'Bus pass').field('body', 'x');
      expect(bad.status).toBe(403);
    });

    it('staff see a student context block and the General pill data on a general thread', async () => {
      makeRouter({
        'AS admin_participant_ids': [{ ...generalAccess, teacher_id: TEACHER, lead_teacher_id: TEACHER }],
        'AS attendance_pct': [{ student_id: STUDENT, name: 'Amina Test', grade: '6', homeroom_teacher_name: 'Sana Rahman', attendance_pct: '96' }],
      });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/${CONVO}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data.context).toBeNull();
      expect(res.body.data.student).toEqual({ studentId: STUDENT, name: 'Amina Test', grade: '6', homeroomTeacherName: 'Sana Rahman', attendancePct: 96 });
    });
  });

  describe('current-term gate', () => {
    const TERM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const activeTerm = { 'FROM terms WHERE school = $1 AND is_active': [{ term_id: TERM, name: 'Term 2' }] };
    const linked = { 'SELECT 1 FROM parent_students WHERE student_id = $1 AND parent_id = $2': [{ ok: 1 }] };
    const anchor = (over = {}) => ({
      class_id: CLASS, school: SCHOOL, class_subject: 'Math', lead_teacher_id: TEACHER,
      student_id: STUDENT, student_name: 'Amina Test', student_school: SCHOOL,
      assessment_id: ASSESSMENT, assessment_name: 'Unit 3 Quiz', is_published: true, is_parent: false,
      assessment_in_class: true, student_in_class: true, is_guardian: true, is_co_teacher: false, in_current_term: true, ...over,
    });
    const startAssessment = (who) => authenticatedRequest('post', '/api/messaging/conversations', who)
      .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Hello');

    it('parent targets are scoped to the active term of the selected year and say which term that is', async () => {
      const r = makeRouter({ ...activeTerm, ...linked });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.currentTerm).toEqual({ termId: TERM, name: 'Term 2' });
      expect(r.ran('FROM terms WHERE school = $1 AND is_active')[0].params).toEqual([SCHOOL, 'y1']);
      expect(r.ran('ORDER BY cl.subject, a.sort_order')[0].params).toEqual([STUDENT, 'y1', TERM, 'Term 2']);
      expect(r.ran("'Homeroom' AS via")[0].params).toEqual([STUDENT, 'y1', TERM, 'Term 2']);
    });

    it('with no active term the picker falls back to every class of the year', async () => {
      const r = makeRouter({ ...linked });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.currentTerm).toBeNull();
      expect(r.ran('ORDER BY cl.subject, a.sort_order')[0].params).toEqual([STUDENT, 'y1', null, null]);
      expect(r.ran("'Homeroom' AS via")[0].params).toEqual([STUDENT, 'y1', null, null]);
    });

    it('the anchor check receives the current term', async () => {
      const r = makeRouter({ ...activeTerm, 'CROSS JOIN students': [anchor()] });
      const res = await startAssessment(mockParentUser());
      expect(res.status).toBe(201);
      expect(r.ran('CROSS JOIN students')[0].params).toEqual([STUDENT, CLASS, ASSESSMENT, PARENT, TERM, 'Term 2']);
    });

    it('a parent or teacher cannot start an assessment thread on a past-term class; an admin can', async () => {
      makeRouter({ ...activeTerm, 'CROSS JOIN students': [anchor({ in_current_term: false })] });
      const parent = await startAssessment(mockParentUser());
      expect(parent.status).toBe(400);
      expect(parent.body.message).toMatch(/current term/i);
      expect((await startAssessment(mockTeacherUser())).status).toBe(400);
      expect((await startAssessment(mockAdminUser())).status).toBe(201);
    });

    it('a past-term anchor that already has a thread is appended to, not refused', async () => {
      makeRouter({
        ...activeTerm,
        'CROSS JOIN students': [anchor({ in_current_term: false })],
        'SELECT conversation_id, status FROM conversations': [{ conversation_id: CONVO, status: 'open' }],
      });
      const res = await startAssessment(mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.conversation.conversationId).toBe(CONVO);
    });

    it('general threads: the teacher match and the named class are term-bound for parents and teachers, not admins', async () => {
      const generalCtx = {
        student_id: STUDENT, student_name: 'Amina Test', student_school: SCHOOL,
        teacher_school: SCHOOL, teacher_role: 'TEACHER', teacher_archived: false, teacher_name: 'Ahmed Khan',
        is_homeroom: false, class_id: 'auto-class', is_guardian: true, caller_teaches: true,
      };
      const pastClass = { 'AS teacher_teaches\n    FROM classes cl WHERE cl.class_id = $1': [{ class_id: CLASS, school: SCHOOL, has_student: true, teacher_teaches: true, in_current_term: false }] };
      const general = (who) => authenticatedRequest('post', '/api/messaging/conversations', who)
        .field('studentId', STUDENT).field('teacherId', TEACHER).field('classId', CLASS).field('title', 'Planner').field('body', 'x');

      const r = makeRouter({ ...activeTerm, 'CROSS JOIN users t': [generalCtx], ...pastClass });
      const parent = await general(mockParentUser());
      expect(parent.status).toBe(400);
      expect(parent.body.message).toMatch(/current term/i);
      expect(r.ran('CROSS JOIN users t')[0].params).toEqual([STUDENT, TEACHER, PARENT, 'y1', TERM, 'Term 2']);
      expect(r.ran('AS teacher_teaches\n    FROM classes cl WHERE cl.class_id = $1')[0].params).toEqual([CLASS, STUDENT, TEACHER, TERM, 'Term 2']);
      expect((await general(mockTeacherUser())).status).toBe(400);

      makeRouter({
        ...activeTerm, 'CROSS JOIN users t': [generalCtx], ...pastClass,
        'AS admin_participant_ids': [{
          conversation_id: CONVO, school: SCHOOL, student_id: STUDENT, student_name: 'Amina Test', class_id: CLASS,
          class_subject: 'Math', assessment_id: null, kind: 'general', teacher_id: TEACHER, title: 'Planner', status: 'open',
          lead_teacher_id: TEACHER, co_teacher_ids: [], guardian_ids: [PARENT], admin_participant_ids: [],
          school_year_id: 'y1', last_message_at: '2026-10-07T12:00:00Z', created_at: '2026-10-07T12:00:00Z',
        }],
        'kind, title, created_by)': [{ conversation_id: CONVO }],
      });
      expect((await general(mockAdminUser())).status).toBe(201);
    });

    it('staff targets for one student scope the classes to the current term', async () => {
      const r = makeRouter({
        ...activeTerm,
        'FROM students s WHERE s.student_id = $1': [{ student_id: STUDENT, name: 'Amina Test', school: SCHOOL, homeroom_teacher_id: HOMEROOM }],
        'CROSS JOIN users t': [{ student_id: STUDENT, student_school: SCHOOL, teacher_school: SCHOOL, teacher_role: 'TEACHER', caller_teaches: true, is_homeroom: false, class_id: CLASS, is_guardian: false }],
        'GROUP BY s.student_id, s.name': [{ student_id: STUDENT, name: 'Amina Test', guardians: [] }],
        'AS caller_teaches\n    FROM class_students cs': [{ class_id: CLASS, subject: 'Math', grade: '6', caller_teaches: true }],
      });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data.currentTerm).toEqual({ termId: TERM, name: 'Term 2' });
      expect(r.ran('AS caller_teaches\n    FROM class_students cs')[0].params).toEqual([STUDENT, TEACHER, 'y1', TERM, 'Term 2']);
    });

    it('staff targets for a class say whether that class is in the current term', async () => {
      const classRow = (term_id, term_name) => ({ 'AS co FROM classes WHERE class_id = $1': [{ school: SCHOOL, teacher_id: TEACHER, co: false, term_id, term_name }] });
      makeRouter({ ...activeTerm, ...classRow('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Term 1') });
      let res = await authenticatedRequest('get', `/api/messaging/conversations/targets?classId=${CLASS}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ inCurrentTerm: false, currentTerm: { termId: TERM, name: 'Term 2' } });

      makeRouter({ ...activeTerm, ...classRow(TERM, 'Term 2') });
      res = await authenticatedRequest('get', `/api/messaging/conversations/targets?classId=${CLASS}`, mockTeacherUser());
      expect(res.body.data.inCurrentTerm).toBe(true);

      // Legacy rows with no term FK fall back to the name.
      makeRouter({ ...activeTerm, ...classRow(null, 'Term 2') });
      res = await authenticatedRequest('get', `/api/messaging/conversations/targets?classId=${CLASS}`, mockTeacherUser());
      expect(res.body.data.inCurrentTerm).toBe(true);

      // No active term: nothing is out of term.
      makeRouter({ ...classRow('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Term 1') });
      res = await authenticatedRequest('get', `/api/messaging/conversations/targets?classId=${CLASS}`, mockTeacherUser());
      expect(res.body.data).toMatchObject({ inCurrentTerm: true, currentTerm: null });
    });
  });

  describe('guardian invites (phase 2)', () => {
    const unlinked = { parent_student_link_id: LINK, parent_name: 'Hana Test', parent_email: 'hana@example.com', relation: 'Mother', invited_at: null };
    const replyAsTeacher = (extra = {}) => {
      let req = authenticatedRequest('post', `/api/messaging/conversations/${CONVO}/messages`, mockTeacherUser()).field('body', 'Please remind Bilal about his planner.');
      for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
      return req;
    };

    it('invites a guardian with an email but no account: creates the pending user, links the row, mints a token and emails', async () => {
      const r = makeRouter({
        'parent_id IS NULL AND parent_email IS NOT NULL': [unlinked],
        'LOWER(email) = LOWER($1)': [],
        "true AS invite_pending": [{ user_id: 'new-user', email: 'hana@example.com', first_name: 'Hana' }],
        'INSERT INTO password_reset_tokens': [{ token: 'tok-1' }],
        'SET parent_id = $2': [{ parent_student_link_id: LINK }],
        'FROM schools': [{ name: 'Al Haadi Academy' }],
      });
      const res = await replyAsTeacher();
      expect(res.status).toBe(201);
      expect(r.ran("true AS invite_pending")[0].params).toEqual(['hana@example.com', 'Hana Test', 'Hana', 'Test', SCHOOL, 'PARENT']);
      expect(r.ran('SET parent_id = $2')[0].params).toEqual([LINK, 'new-user', TEACHER, CONVO, true]);
      expect(r.ran('INSERT INTO password_reset_tokens')[0].params).toEqual(['new-user']);
      expect(global.__mockInviteSend).toHaveBeenCalledTimes(1);
      const email = global.__mockInviteSend.mock.calls[0][0];
      expect(email.to).toEqual(['hana@example.com']);
      expect(email.html).toContain('reset-password?token=tok-1&amp;invite=1&amp;next=');
      expect(email.html).toContain('Please remind Bilal');
      expect(res.body.data.invites).toEqual([{ linkId: LINK, name: 'Hana Test', status: 'invited' }]);
    });

    it('links an email that already has an account instead of inviting it', async () => {
      const r = makeRouter({
        'parent_id IS NULL AND parent_email IS NOT NULL': [unlinked],
        'LOWER(email) = LOWER($1)': [{ user_id: 'existing', role: 'PARENT', password: 'hashed', is_archived: false }],
        'SET parent_id = $2': [{ parent_student_link_id: LINK }],
      });
      const res = await replyAsTeacher();
      expect(res.status).toBe(201);
      expect(r.ran("true AS invite_pending")).toHaveLength(0);
      expect(r.ran('SET parent_id = $2')[0].params).toEqual([LINK, 'existing', TEACHER, CONVO, false]);
      expect(global.__mockInviteSend).not.toHaveBeenCalled();
      expect(res.body.data.invites).toEqual([{ linkId: LINK, name: 'Hana Test', status: 'linked' }]);
    });

    it('respects invite=false and omits the preview when includePreview=false', async () => {
      makeRouter({ 'parent_id IS NULL AND parent_email IS NOT NULL': [unlinked] });
      let res = await replyAsTeacher({ invite: 'false' });
      expect(res.status).toBe(201);
      expect(global.__mockInviteSend).not.toHaveBeenCalled();
      expect(res.body.data.invites).toEqual([]);

      makeRouter({
        'parent_id IS NULL AND parent_email IS NOT NULL': [unlinked], 'LOWER(email) = LOWER($1)': [],
        "true AS invite_pending": [{ user_id: 'new-user', email: 'hana@example.com', first_name: 'Hana' }],
        'INSERT INTO password_reset_tokens': [{ token: 'tok-2' }], 'SET parent_id = $2': [{ parent_student_link_id: LINK }],
      });
      res = await replyAsTeacher({ includePreview: 'false' });
      expect(res.status).toBe(201);
      expect(global.__mockInviteSend.mock.calls[0][0].html).not.toContain('Please remind Bilal');
    });

    it('parents never trigger invites', async () => {
      const r = makeRouter({ 'parent_id IS NULL AND parent_email IS NOT NULL': [unlinked] });
      await authenticatedRequest('post', `/api/messaging/conversations/${CONVO}/messages`, mockParentUser()).field('body', 'hi');
      expect(r.ran('parent_id IS NULL AND parent_email IS NOT NULL')).toHaveLength(0);
    });

    it('resend: re-mints a token after an hour, 429 within the hour, 404 across schools', async () => {
      const pending = { parent_student_link_id: LINK, parent_id: 'new-user', parent_name: 'Hana Test', parent_email: 'hana@example.com', relation: 'Mother', invite_conversation_id: CONVO, school: SCHOOL, student_name: 'Bilal Test', invite_pending: true, first_name: 'Hana' };
      const r = makeRouter({
        'WHERE ps.parent_student_link_id = $1 AND ps.school = $2': [{ ...pending, invited_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }],
        'INSERT INTO password_reset_tokens': [{ token: 'tok-3' }], 'FROM schools': [{ name: 'Al Haadi Academy' }],
      });
      let res = await authenticatedRequest('post', `/api/messaging/conversations/invites/${LINK}/resend`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(global.__mockInviteSend).toHaveBeenCalledTimes(1);
      expect(r.ran('SET invited_at = NOW() WHERE parent_student_link_id')).toHaveLength(1);

      makeRouter({ 'WHERE ps.parent_student_link_id = $1 AND ps.school = $2': [{ ...pending, invited_at: new Date().toISOString() }] });
      res = await authenticatedRequest('post', `/api/messaging/conversations/invites/${LINK}/resend`, mockTeacherUser());
      expect(res.status).toBe(429);

      makeRouter({ 'WHERE ps.parent_student_link_id = $1 AND ps.school = $2': [] });
      res = await authenticatedRequest('post', `/api/messaging/conversations/invites/${LINK}/resend`, mockTeacherUser());
      expect(res.status).toBe(404);
      expect((await authenticatedRequest('post', `/api/messaging/conversations/invites/${LINK}/resend`, mockParentUser())).status).toBe(403);
    });
  });

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
          unread_count: 2, last_real_sender_role: 'PARENT', term_name: 'Term 1', guardian_names: ['Layla Test', 'Omar Test'],
          last_message: { senderId: PARENT, senderRole: 'PARENT', kind: 'message', body: 'hi', deleted: false, createdAt: 'x', senderName: 'Layla' },
        }],
      });
      const res = await authenticatedRequest('get', '/api/messaging/conversations', mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data[0].needsReply).toBe(true);
      expect(res.body.data[0].unreadCount).toBe(2);
      expect(res.body.data[0]).toMatchObject({ termName: 'Term 1', guardianNames: ['Layla Test', 'Omar Test'] });
    });

    it('returns the unread summary', async () => {
      makeRouter({ 'AS unread_conversations': [{ unread_conversations: 1, unread_messages: 3, needs_reply: 1 }] });
      const res = await authenticatedRequest('get', '/api/messaging/conversations/unread-count', mockParentUser());
      expect(res.body.data).toEqual({ unreadConversations: 1, unreadMessages: 3, needsReply: 1, unreadAnnouncements: 0 });
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

  // A staff member linked to their own child acts in the parent view with a
  // PARENT token. Writing to yourself is never useful, so both anchors refuse
  // it and the picker never offers it.
  describe('dual-role: a parent who is also the teacher', () => {
    const selfTaught = (over = {}) => ({
      class_id: CLASS, school: SCHOOL, class_subject: 'Math', lead_teacher_id: PARENT,
      student_id: STUDENT, student_name: 'Amina Test', student_school: SCHOOL,
      assessment_id: ASSESSMENT, assessment_name: 'Unit 3 Quiz', is_published: true, is_parent: false,
      assessment_in_class: true, student_in_class: true, is_guardian: true, is_co_teacher: false, in_current_term: true, ...over,
    });

    it('refuses an assessment thread when the parent leads the class', async () => {
      const r = makeRouter({ 'CROSS JOIN students': [selfTaught()] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Hello me');
      expect(res.status).toBe(403);
      expect(r.ran('INSERT INTO conversations')).toHaveLength(0);
    });

    it('refuses an assessment thread when the parent co-teaches the class', async () => {
      makeRouter({ 'CROSS JOIN students': [selfTaught({ lead_teacher_id: TEACHER, is_co_teacher: true })] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('classId', CLASS).field('assessmentId', ASSESSMENT).field('body', 'Hello me');
      expect(res.status).toBe(403);
    });

    it('refuses a general thread addressed to the parent themself', async () => {
      makeRouter({ 'CROSS JOIN users t': [{
        student_id: STUDENT, student_name: 'Amina Test', student_school: SCHOOL,
        teacher_school: SCHOOL, teacher_role: 'TEACHER', teacher_archived: false, teacher_name: 'Me',
        is_homeroom: true, class_id: null, is_guardian: true, caller_teaches: true,
      }] });
      const res = await authenticatedRequest('post', '/api/messaging/conversations', mockParentUser())
        .field('studentId', STUDENT).field('teacherId', PARENT).field('title', 'Note to self').field('body', 'x');
      expect(res.status).toBe(403);
    });

    it('leaves the parent out of their own teacher targets', async () => {
      makeRouter({
        'SELECT 1 FROM parent_students WHERE student_id = $1 AND parent_id = $2': [{ ok: 1 }],
        "'Homeroom' AS via": [
          { user_id: PARENT, name: 'Me Myself', via: 'Homeroom', role: 'TEACHER' },
          { user_id: TEACHER, name: 'Ahmed Khan', via: 'Math', role: 'TEACHER' },
        ],
      });
      const res = await authenticatedRequest('get', `/api/messaging/conversations/targets?studentId=${STUDENT}`, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.teachers).toEqual([{ userId: TEACHER, name: 'Ahmed Khan', via: 'Math', role: 'TEACHER' }]);
    });

    it('links a guardian email that belongs to a staff account instead of skipping it', async () => {
      const unlinked = { parent_student_link_id: LINK, parent_name: 'Hana Test', parent_email: 'hana@example.com', relation: 'Mother', invited_at: null };
      const r = makeRouter({
        'parent_id IS NULL AND parent_email IS NOT NULL': [unlinked],
        'LOWER(email) = LOWER($1)': [{ user_id: 'staff-guardian', role: 'TEACHER', password: 'hashed', is_archived: false }],
        'SET parent_id = $2': [{ parent_student_link_id: LINK }],
      });
      const res = await authenticatedRequest('post', `/api/messaging/conversations/${CONVO}/messages`, mockTeacherUser()).field('body', 'Reminder');
      expect(res.status).toBe(201);
      expect(r.ran('SET parent_id = $2')[0].params).toEqual([LINK, 'staff-guardian', TEACHER, CONVO, false]);
      expect(global.__mockInviteSend).not.toHaveBeenCalled();
      expect(res.body.data.invites).toEqual([{ linkId: LINK, name: 'Hana Test', status: 'linked' }]);
    });
  });
});
