const requireClassOwnership = require('../../../middleware/requireClassOwnership');
const db = require('../../__mocks__/config/database');
const { mockQueryResponse } = require('../../helpers/mockDb');

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const makeReq = (user) => ({ params: { classId: 'c1' }, user });

const classRow = (overrides = {}) => ({
  class_id: 'c1',
  school: 'ALHAADIACADEMY',
  teacher_id: 'teacher-1',
  is_co_teacher: false,
  ...overrides,
});

const TEACHER = { userId: 'teacher-1', role: 'TEACHER', school: 'ALHAADIACADEMY' };
const OTHER_TEACHER = { userId: 'teacher-2', role: 'TEACHER', school: 'ALHAADIACADEMY' };
const ADMIN = { userId: 'admin-1', role: 'ADMIN', school: 'ALHAADIACADEMY' };

beforeEach(() => {
  db._reset();
});

describe('requireClassOwnership', () => {
  it('allows the teacher who owns the class', async () => {
    mockQueryResponse([classRow()]);
    const req = makeReq(TEACHER);
    const next = jest.fn();
    await requireClassOwnership(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.class).toEqual({
      classId: 'c1',
      school: 'ALHAADIACADEMY',
      teacherId: 'teacher-1',
    });
  });

  it('allows a co-teacher', async () => {
    mockQueryResponse([classRow({ is_co_teacher: true })]);
    const next = jest.fn();
    await requireClassOwnership(makeReq(OTHER_TEACHER), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a teacher who neither owns nor co-teaches the class', async () => {
    mockQueryResponse([classRow()]);
    const res = makeRes();
    const next = jest.fn();
    await requireClassOwnership(makeReq(OTHER_TEACHER), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('allows an admin from the same school without owning the class', async () => {
    mockQueryResponse([classRow()]);
    const next = jest.fn();
    await requireClassOwnership(makeReq(ADMIN), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a cross-school admin', async () => {
    mockQueryResponse([classRow({ school: 'JCC' })]);
    const res = makeRes();
    const next = jest.fn();
    await requireClassOwnership(makeReq(ADMIN), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects a parent outright', async () => {
    mockQueryResponse([classRow()]);
    const res = makeRes();
    const next = jest.fn();
    await requireClassOwnership(
      makeReq({ userId: 'p1', role: 'PARENT', school: 'ALHAADIACADEMY' }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown class', async () => {
    mockQueryResponse([]);
    const res = makeRes();
    const next = jest.fn();
    await requireClassOwnership(makeReq(TEACHER), res, next);
    expect(res.statusCode).toBe(404);
  });

  it('403s rather than 500s on a malformed classId', async () => {
    db.query.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
    const res = makeRes();
    const next = jest.fn();
    await requireClassOwnership(makeReq(TEACHER), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
