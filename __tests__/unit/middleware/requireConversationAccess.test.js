const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const requireConversationAccess = require('../../../middleware/requireConversationAccess');

const CONVO = '33333333-3333-4333-8333-333333333333';
const PARENT = '22222222-2222-4222-8222-222222222222';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const CO = '55555555-5555-4555-8555-555555555555';

const row = (over = {}) => ({
  conversation_id: CONVO, school: 'ALHAADIACADEMY', student_id: 's1', student_name: 'Amina Test',
  class_id: 'c1', class_subject: 'Math', assessment_id: 'a1', title: 'Quiz', status: 'open',
  lead_teacher_id: TEACHER, co_teacher_ids: [CO], guardian_ids: [PARENT], admin_participant_ids: [],
  school_year_id: 'y1', last_message_at: '2026-10-07T00:00:00Z', created_at: '2026-10-07T00:00:00Z', ...over,
});
const makeRes = () => {
  const r = {};
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const makeReq = (user) => ({ params: { id: CONVO }, user: { school: 'ALHAADIACADEMY', ...user } });

describe('requireConversationAccess', () => {
  beforeEach(() => db._reset());

  it('lets a linked guardian through and exposes membership', async () => {
    db.query.mockResolvedValueOnce({ rows: [row()] });
    const next = jest.fn();
    const req = makeReq({ userId: PARENT, role: 'PARENT' });
    await requireConversationAccess(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM conversations'), [CONVO]);
    expect(req.conversation.teacherIds).toEqual([TEACHER, CO]);
    expect(req.conversation.guardianIds).toEqual([PARENT]);
    expect(req.conversation.conversationId).toBe(CONVO);
  });

  it('newly linked guardian passes (membership is read live, not snapshotted)', async () => {
    db.query.mockResolvedValueOnce({ rows: [row({ guardian_ids: ['other', PARENT] })] });
    const next = jest.fn();
    await requireConversationAccess(makeReq({ userId: PARENT, role: 'PARENT' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('403s a parent who is not linked', async () => {
    db.query.mockResolvedValueOnce({ rows: [row({ guardian_ids: ['someone-else'] })] });
    const next = jest.fn();
    const res = makeRes();
    await requireConversationAccess(makeReq({ userId: PARENT, role: 'PARENT' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('lets lead and co-teachers through', async () => {
    db.query.mockResolvedValueOnce({ rows: [row()] });
    const next = jest.fn();
    await requireConversationAccess(makeReq({ userId: CO, role: 'TEACHER' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
    db.query.mockResolvedValueOnce({ rows: [row()] });
    const next2 = jest.fn();
    await requireConversationAccess(makeReq({ userId: TEACHER, role: 'TEACHER' }), makeRes(), next2);
    expect(next2).toHaveBeenCalled();
  });

  it('403s a teacher of another class', async () => {
    db.query.mockResolvedValueOnce({ rows: [row()] });
    const res = makeRes();
    const next = jest.fn();
    await requireConversationAccess(makeReq({ userId: 'stranger', role: 'TEACHER' }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('admin passes within the school', async () => {
    db.query.mockResolvedValueOnce({ rows: [row()] });
    const next = jest.fn();
    await requireConversationAccess(makeReq({ userId: 'adm', role: 'ADMIN' }), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('404s across schools so tenants cannot probe each other', async () => {
    db.query.mockResolvedValueOnce({ rows: [row({ school: 'OTHER' })] });
    const res = makeRes();
    await requireConversationAccess(makeReq({ userId: 'adm', role: 'ADMIN' }), res, jest.fn());
    expect(res.statusCode).toBe(404);
  });

  it('404s an unknown id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    await requireConversationAccess(makeReq({ userId: 'adm', role: 'ADMIN' }), res, jest.fn());
    expect(res.statusCode).toBe(404);
  });

  describe('students in conversations (T17)', () => {
    const STUDENT_USER = '66666666-6666-4666-8666-666666666666';
    const asStudent = { userId: STUDENT_USER, role: 'STUDENT' };

    it('a STUDENT is a member when the thread includes the student and lists their login', async () => {
      db.query.mockResolvedValueOnce({ rows: [row({ includes_student: true, student_user_ids: [STUDENT_USER] })] });
      const next = jest.fn();
      const req = makeReq(asStudent);
      await requireConversationAccess(req, makeRes(), next);
      expect(next).toHaveBeenCalledWith();
      expect(req.conversation).toMatchObject({ includesStudent: true, studentUserIds: [STUDENT_USER], classworkItemId: null });
    });

    it('a STUDENT is never a member of a thread that does not include the student (an older parent–teacher thread)', async () => {
      // Even if a login id were listed, includes_student = false wins.
      db.query.mockResolvedValueOnce({ rows: [row({ includes_student: false, student_user_ids: [STUDENT_USER] })] });
      const res = makeRes();
      const next = jest.fn();
      await requireConversationAccess(makeReq(asStudent), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("a STUDENT whose login is not listed (another student's thread) is refused", async () => {
      db.query.mockResolvedValueOnce({ rows: [row({ includes_student: true, student_user_ids: ['someone-else'] })] });
      const res = makeRes();
      await requireConversationAccess(makeReq(asStudent), res, jest.fn());
      expect(res.statusCode).toBe(403);
    });

    it('a PARENT loses access to an item thread the school keeps from guardians (guardians_hidden)', async () => {
      db.query.mockResolvedValueOnce({
        rows: [row({ includes_student: true, classwork_item_id: 'item-1', student_user_ids: [STUDENT_USER], guardians_hidden: true })],
      });
      const res = makeRes();
      const next = jest.fn();
      await requireConversationAccess(makeReq({ userId: PARENT, role: 'PARENT' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);

      // The teacher and the student still pass; the guardians are dropped from membership (and emails).
      db.query.mockResolvedValueOnce({
        rows: [row({ includes_student: true, classwork_item_id: 'item-1', student_user_ids: [STUDENT_USER], guardians_hidden: true })],
      });
      const req = makeReq({ userId: TEACHER, role: 'TEACHER' });
      const next2 = jest.fn();
      await requireConversationAccess(req, makeRes(), next2);
      expect(next2).toHaveBeenCalled();
      expect(req.conversation).toMatchObject({ guardianIds: [], guardiansHidden: true, classworkItemId: 'item-1' });
    });

    it('a PARENT keeps access to an item thread while guardians may read it', async () => {
      db.query.mockResolvedValueOnce({
        rows: [row({ includes_student: true, classwork_item_id: 'item-1', student_user_ids: [STUDENT_USER], guardians_hidden: false })],
      });
      const next = jest.fn();
      await requireConversationAccess(makeReq({ userId: PARENT, role: 'PARENT' }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
  });

  it('403s on a malformed id (db throws)', async () => {
    db.query.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
    const res = makeRes();
    await requireConversationAccess(makeReq({ userId: PARENT, role: 'PARENT' }), res, jest.fn());
    expect(res.statusCode).toBe(403);
  });

  describe('with RBAC roles', () => {
    const { giveRole } = require('../../helpers/mockAccess');
    const OFFICE = '66666666-6666-4666-8666-666666666666';

    it('keeps an admin without messages.all out of threads they are not in', async () => {
      giveRole(OFFICE, ['forms']);
      db.query.mockResolvedValueOnce({ rows: [row()] });
      const res = makeRes();
      const next = jest.fn();
      await requireConversationAccess(makeReq({ userId: OFFICE, role: 'ADMIN' }), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('lets them into a thread they joined', async () => {
      giveRole(OFFICE, ['forms']);
      db.query.mockResolvedValueOnce({ rows: [row({ admin_participant_ids: [OFFICE] })] });
      const next = jest.fn();
      await requireConversationAccess(makeReq({ userId: OFFICE, role: 'ADMIN' }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });

    it('opens every thread of the school to messages.all, even for a teacher', async () => {
      giveRole(OFFICE, ['messages.all']);
      db.query.mockResolvedValueOnce({ rows: [row()] });
      const next = jest.fn();
      await requireConversationAccess(makeReq({ userId: OFFICE, role: 'TEACHER' }), makeRes(), next);
      expect(next).toHaveBeenCalled();
    });
  });
});
