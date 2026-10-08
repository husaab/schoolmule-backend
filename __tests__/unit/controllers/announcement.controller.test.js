const mockSend = jest.fn().mockResolvedValue({ data: { id: 'email_1' } });
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));

const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const supabase = require('../../../config/supabaseClient'); // mapped to the mock
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockParentUser, mockTeacherUser, mockAdminUser, mockStaffUser } = require('../../helpers/mockAuth');

const SCHOOL = 'ALHAADIACADEMY';
const ADMIN = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER = '550e8400-e29b-41d4-a716-446655440001';
const PARENT = '550e8400-e29b-41d4-a716-446655440002';
const CLASS = '22222222-2222-4222-8222-222222222222';
const ANN = '44444444-4444-4444-8444-444444444444';

const accessRow = (over = {}) => ({
  announcement_id: ANN, school: SCHOOL, school_year_id: 'y1', scope: 'class', class_id: CLASS, grade: null, title: 'Forms due Friday',
  body: 'Please return the form.', author_id: TEACHER, author_role: 'TEACHER', author_name: 'Teacher User',
  published_at: '2026-10-08T12:00:00Z', pinned_until: null, is_pinned: false, edited_at: null, deleted_at: null,
  created_at: '2026-10-08T12:00:00Z', class_subject: 'Math', class_grade: '6', attachment_count: 0,
  is_author: true, is_guardian: true, is_class_teacher: true, ...over,
});

/**
 * A tiny in-memory "database": each test declares the rows a query fragment
 * returns, and every call is recorded so assertions can check what ran.
 */
function makeRouter(overrides = {}) {
  const calls = [];
  const defaults = {
    'AS is_class_teacher': [accessRow()],
    'INSERT INTO announcements': [{ announcement_id: ANN, published_at: '2026-10-08T12:00:00Z' }],
    'FROM classes cl WHERE cl.class_id = $1': [{ school: SCHOOL, subject: 'Math', grade: '6', allowed: true }],
    'AS allowed': [{ allowed: false }],
    'FROM announcement_attachments WHERE announcement_id = $1 ORDER BY': [],
    'AS sent,': [{ sent: 0, pending: 2, failed: 0, signup: 1, invite: 0 }],
    'AS state': [],
    'INSERT INTO announcement_reads': [{ read_at: '2026-10-08T12:30:00Z' }],
  };
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
  return { calls, ran: (frag) => calls.filter((c) => c.sql.includes(frag)) };
}

const post = (token) => authenticatedRequest('post', '/api/announcements', token);
const png = Buffer.from('89504e470d0a1a0a', 'hex');

describe('announcement controller', () => {
  beforeEach(() => { db._reset(); supabase._reset(); });

  describe('POST /', () => {
    it('teacher posts to a class they teach: inserts, enqueues with the 2-minute delay, 201', async () => {
      const r = makeRouter();
      const res = await post(mockTeacherUser()).field('scope', 'class').field('classId', CLASS).field('title', 'Forms due Friday').field('body', 'Please return the form.');
      expect(res.status).toBe(201);
      const [ins] = r.ran('INSERT INTO announcements');
      expect(ins.params).toEqual([SCHOOL, 'y1', 'class', CLASS, null, 'Forms due Friday', 'Please return the form.', TEACHER, 'TEACHER', null]);
      expect(r.ran('INSERT INTO announcement_email_jobs')[0].params).toEqual([ANN, '2 minutes']);
      expect(res.body.data.scopeLabel).toBe('Gr 6 Math');
      expect(res.body.data.canEdit).toBe(true);
    });

    it('teacher cannot post to a class they do not teach (403) or another school (404)', async () => {
      makeRouter({ 'FROM classes cl WHERE cl.class_id = $1': [{ school: SCHOOL, allowed: false }] });
      expect((await post(mockTeacherUser()).field('scope', 'class').field('classId', CLASS).field('title', 't').field('body', 'b')).status).toBe(403);
      makeRouter({ 'FROM classes cl WHERE cl.class_id = $1': [{ school: 'PLAYGROUND', allowed: true }] });
      expect((await post(mockTeacherUser()).field('scope', 'class').field('classId', CLASS).field('title', 't').field('body', 'b')).status).toBe(404);
    });

    it('grade: homeroom teacher allowed, other teacher 403, admin allowed without the check', async () => {
      let r = makeRouter({ 'AS allowed': [{ allowed: true }] });
      expect((await post(mockTeacherUser()).field('scope', 'grade').field('grade', '6').field('title', 't').field('body', 'b')).status).toBe(201);
      expect(r.ran('AS allowed')[0].params).toEqual(['6', TEACHER, SCHOOL, 'y1']);
      makeRouter({ 'AS allowed': [{ allowed: false }] });
      expect((await post(mockTeacherUser()).field('scope', 'grade').field('grade', '6').field('title', 't').field('body', 'b')).status).toBe(403);
      r = makeRouter();
      expect((await post(mockAdminUser()).field('scope', 'grade').field('grade', '6').field('title', 't').field('body', 'b')).status).toBe(201);
      expect(r.ran('AS allowed')).toHaveLength(0);
    });

    it('school scope is admin only; STAFF role cannot post; parents 403', async () => {
      makeRouter();
      expect((await post(mockTeacherUser()).field('scope', 'school').field('title', 't').field('body', 'b')).status).toBe(403);
      expect((await post(mockStaffUser()).field('scope', 'school').field('title', 't').field('body', 'b')).status).toBe(403);
      expect((await post(mockParentUser()).field('scope', 'school').field('title', 't').field('body', 'b')).status).toBe(403);
      expect((await post(mockAdminUser()).field('scope', 'school').field('title', 't').field('body', 'b')).status).toBe(201);
    });

    it('validates title, body, scope and pin date', async () => {
      makeRouter();
      expect((await post(mockAdminUser()).field('scope', 'school').field('title', '  ').field('body', 'b')).status).toBe(400);
      expect((await post(mockAdminUser()).field('scope', 'school').field('title', 'x'.repeat(121)).field('body', 'b')).status).toBe(400);
      expect((await post(mockAdminUser()).field('scope', 'school').field('title', 't').field('body', '')).status).toBe(400);
      expect((await post(mockAdminUser()).field('scope', 'bogus').field('title', 't').field('body', 'b')).status).toBe(400);
      expect((await post(mockAdminUser()).field('scope', 'school').field('title', 't').field('body', 'b').field('pinnedUntil', '2020-01-01')).status).toBe(400);
      expect((await post(mockAdminUser()).field('scope', 'school').field('title', 't').field('body', 'b').field('pinnedUntil', 'next week')).status).toBe(400);
    });

    it('uploads files before COMMIT under the announcements prefix and rolls back on a storage failure', async () => {
      const r = makeRouter();
      let res = await post(mockAdminUser()).field('scope', 'school').field('title', 't').field('body', 'b').attach('files', png, { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(201);
      const uploadPath = supabase._mockStorage.upload.mock.calls[0][0];
      expect(uploadPath).toMatch(new RegExp(`^${SCHOOL}/announcements/${ANN}/[0-9a-f-]+\\.png$`));
      expect(r.ran('INSERT INTO announcement_attachments')).toHaveLength(1);

      supabase._mockStorage.upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket down' } });
      res = await post(mockAdminUser()).field('scope', 'school').field('title', 't').field('body', 'b').attach('files', png, { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(500);
      expect(db._mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('POST /preview-email', () => {
    beforeEach(() => mockSend.mockClear());

    it('emails the author one copy as a parent would get it; nothing is posted', async () => {
      const r = makeRouter();
      const res = await authenticatedRequest('post', '/api/announcements/preview-email', mockTeacherUser())
        .send({ scope: 'class', classId: CLASS, title: 'Forms due Friday', body: 'Please return the form.', attachmentCount: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ sentTo: 'teacher@test.com' });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const msg = mockSend.mock.calls[0][0];
      expect(msg.to).toEqual(['teacher@test.com']);
      expect(msg.subject).toBe('[Preview] Gr 6 Math: Forms due Friday');
      expect(msg.html).toContain('Please return the form.');
      expect(msg.html).toContain('1 attachment');
      expect(msg.html).toContain('Gr 6 Math');

      expect(r.ran('INSERT INTO announcements')).toHaveLength(0);
      expect(r.ran('INSERT INTO announcement_email_jobs')).toHaveLength(0);
    });

    it('validates like a real post and keeps the scope rules', async () => {
      makeRouter();
      const t = mockTeacherUser();
      expect((await authenticatedRequest('post', '/api/announcements/preview-email', t).send({ scope: 'class', classId: CLASS, title: '', body: 'x' })).status).toBe(400);
      expect((await authenticatedRequest('post', '/api/announcements/preview-email', t).send({ scope: 'school', title: 'T', body: 'x' })).status).toBe(403);
      expect((await authenticatedRequest('post', '/api/announcements/preview-email', mockParentUser()).send({ scope: 'class', classId: CLASS, title: 'T', body: 'x' })).status).toBe(403);
      makeRouter({ 'FROM classes cl WHERE cl.class_id = $1': [{ school: SCHOOL, subject: 'Math', grade: '6', allowed: false }] });
      expect((await authenticatedRequest('post', '/api/announcements/preview-email', t).send({ scope: 'class', classId: CLASS, title: 'T', body: 'x' })).status).toBe(403);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id, PATCH, DELETE, read', () => {
    it('returns the item with signed attachments and staff receipts; parents get no receipts', async () => {
      makeRouter({
        'FROM announcement_attachments WHERE announcement_id = $1 ORDER BY': [{ attachment_id: 'at1', announcement_id: ANN, file_path: 'p/a.pdf', file_name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 10 }],
        'AS state': [{ user_id: PARENT, name: 'Layla Test', relation: 'Mother', student_names: ['Amina Test'], read_at: null, state: 'emailed' }],
      });
      let res = await authenticatedRequest('get', `/api/announcements/${ANN}`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.data.attachments[0].url).toBe('https://mock-signed-url.com/p/a.pdf');
      expect(res.body.data.receipts.notYet[0].state).toBe('emailed');
      expect(res.body.data.emails.signup).toBe(1);
      makeRouter({ 'AS is_class_teacher': [accessRow({ is_author: false, is_class_teacher: false })] });
      res = await authenticatedRequest('get', `/api/announcements/${ANN}`, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data.receipts).toBeUndefined();
      expect(res.body.data.canEdit).toBe(false);
    });

    it('PATCH: author edits title/body/pin, removes an attachment, adds a file; a non-author teacher is refused', async () => {
      const r = makeRouter({
        'RETURNING file_path': [{ file_path: 'p/old.pdf' }],
        'UPDATE announcements SET title': [{ edited_at: '2026-10-08T12:10:00Z' }],
      });
      let res = await authenticatedRequest('patch', `/api/announcements/${ANN}`, mockTeacherUser())
        .field('title', 'Forms due Monday').field('body', 'Changed').field('pinnedUntil', '2099-01-01').field('removeAttachmentIds', 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1');
      expect(res.status).toBe(200);
      expect(r.ran('UPDATE announcements SET title')[0].params).toEqual([ANN, 'Forms due Monday', 'Changed', '2099-01-01']);
      expect(supabase._mockStorage.remove).toHaveBeenCalledWith(['p/old.pdf']);
      expect(r.ran('INSERT INTO announcement_email_jobs')).toHaveLength(0);
      makeRouter({ 'AS is_class_teacher': [accessRow({ is_author: false, is_class_teacher: true })] });
      res = await authenticatedRequest('patch', `/api/announcements/${ANN}`, mockTeacherUser()).field('title', 'x');
      expect(res.status).toBe(403);
    });

    it('PATCH keeps an unchanged (even expired) pin, but refuses a new date in the past', async () => {
      const r = makeRouter({ 'AS is_class_teacher': [accessRow({ pinned_until: '2020-01-01' })], 'UPDATE announcements SET title': [{ edited_at: '2026-10-08T12:10:00Z' }] });
      let res = await authenticatedRequest('patch', `/api/announcements/${ANN}`, mockTeacherUser()).field('title', 'Typo fixed').field('pinnedUntil', '2020-01-01');
      expect(res.status).toBe(200);
      expect(r.ran('UPDATE announcements SET title')[0].params[3]).toBe('2020-01-01');
      res = await authenticatedRequest('patch', `/api/announcements/${ANN}`, mockTeacherUser()).field('title', 'Typo fixed').field('pinnedUntil', '2021-01-01');
      expect(res.status).toBe(400);
    });

    it('DELETE soft-deletes, cancels pending jobs, removes objects; admin may delete anyone’s', async () => {
      const r = makeRouter({
        'AS is_class_teacher': [accessRow({ is_author: false })],
        'SELECT file_path FROM announcement_attachments': [{ file_path: 'p/a.pdf' }],
        'SET deleted_at = NOW()': [{ deleted_at: '2026-10-08T13:00:00Z' }],
      });
      const res = await authenticatedRequest('delete', `/api/announcements/${ANN}`, mockAdminUser());
      expect(res.status).toBe(200);
      expect(r.ran("SET status = 'skipped', last_error = 'announcement removed'")[0].params).toEqual([ANN]);
      expect(supabase._mockStorage.remove).toHaveBeenCalledWith(['p/a.pdf']);
      expect(r.ran('SET deleted_at = NOW()')[0].params).toEqual([ANN, ADMIN]);
    });

    it('POST /:id/read upserts the caller’s read row', async () => {
      const r = makeRouter({ 'AS is_class_teacher': [accessRow({ is_author: false, is_class_teacher: false, is_guardian: true })] });
      const res = await authenticatedRequest('post', `/api/announcements/${ANN}/read`, mockParentUser());
      expect(res.status).toBe(200);
      expect(r.ran('INSERT INTO announcement_reads')[0].params).toEqual([ANN, PARENT]);
    });

    it('POST /:id/emails/retry is admin only', async () => {
      const r = makeRouter({ "SET status = 'pending', attempts = 0": [{ job_id: 'j1' }, { job_id: 'j2' }] });
      expect((await authenticatedRequest('post', `/api/announcements/${ANN}/emails/retry`, mockTeacherUser())).status).toBe(403);
      const res = await authenticatedRequest('post', `/api/announcements/${ANN}/emails/retry`, mockAdminUser());
      expect(res.body.data.requeued).toBe(2);
      expect(r.ran("SET status = 'pending', attempts = 0")[0].params).toEqual([ANN]);
    });
  });

  describe('GET /, /targets, /preview', () => {
    it('lists with role, year and filters; staff items carry seen/audience, parent items carry children', async () => {
      const r = makeRouter({ 'AS children': [{ ...accessRow(), read: false, audience_count: 22, seen_count: 14, children: [{ studentId: 's1', name: 'Amina Test' }] }] });
      let res = await authenticatedRequest('get', `/api/announcements?classId=${CLASS}&mine=1&q=forms`, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(r.ran('AS children')[0].params).toEqual([TEACHER, SCHOOL, 'TEACHER', 'y1', CLASS, null, null, null, true, false, 'forms', null, 100]);
      expect(res.body.data[0]).toMatchObject({ seenCount: 14, audienceCount: 22, read: false, isPinned: false });
      expect(res.body.data[0].children).toBeUndefined();
      res = await authenticatedRequest('get', '/api/announcements?studentId=11111111-1111-4111-8111-111111111111', mockParentUser());
      expect(res.body.data[0].children).toEqual([{ studentId: 's1', name: 'Amina Test' }]);
      expect(res.body.data[0].seenCount).toBeUndefined();
      expect((await authenticatedRequest('get', '/api/announcements?classId=nope', mockParentUser())).status).toBe(400);
    });

    it('targets: a teacher gets their classes and homeroom grades, canSchool false; admin canSchool true', async () => {
      makeRouter({
        'AS student_count\n    FROM classes cl': [{ class_id: CLASS, subject: 'Math', grade: '6', student_count: 22 }],
        'GROUP BY s.grade': [{ grade: '6', student_count: 48 }],
      });
      let res = await authenticatedRequest('get', '/api/announcements/targets', mockTeacherUser());
      expect(res.body.data).toEqual({ classes: [{ classId: CLASS, subject: 'Math', grade: '6', studentCount: 22 }], grades: [{ grade: '6', studentCount: 48 }], canSchool: false });
      res = await authenticatedRequest('get', '/api/announcements/targets', mockAdminUser());
      expect(res.body.data.canSchool).toBe(true);
      expect((await authenticatedRequest('get', '/api/announcements/targets', mockParentUser())).status).toBe(403);
    });

    it('preview: counts for an allowed scope, 403 otherwise', async () => {
      const r = makeRouter({ 'AS students_without_email': [{ students: 22, guardians_with_account: 38, guardians_invite_pending: 1, guardians_email_only: 4, students_without_email: [{ studentId: 's9', name: 'Zayd Test' }] }] });
      const res = await authenticatedRequest('get', `/api/announcements/preview?scope=class&classId=${CLASS}`, mockTeacherUser());
      expect(res.body.data).toEqual({ students: 22, guardiansWithAccount: 38, guardiansInvitePending: 1, guardiansEmailOnly: 4, studentsWithoutEmail: [{ studentId: 's9', name: 'Zayd Test' }] });
      expect(r.ran('AS students_without_email')[0].params).toEqual([SCHOOL, 'class', CLASS, null, 'y1']);
      expect((await authenticatedRequest('get', '/api/announcements/preview?scope=school', mockTeacherUser())).status).toBe(403);
    });
  });
});
