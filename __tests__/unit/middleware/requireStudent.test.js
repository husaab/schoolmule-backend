const db = require('../../../config/database');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const requireStudent = require('../../../middleware/requireStudent');

const USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const STUDENT_ID = '660e8400-e29b-41d4-a716-446655440020';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';

const run = async ({ user = { role: 'STUDENT', userId: USER_ID, school: 'ALHAADIACADEMY' }, schoolYear = { schoolYearId: YEAR_ID, label: '2025-2026' } } = {}) => {
  const req = { user, schoolYear };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await requireStudent(req, res, next);
  return { req, res, next };
};

const row = (overrides = {}) => ({
  student_id: STUDENT_ID, name: '  Amal Noor Haddad', grade: '2', school_year_id: YEAR_ID,
  user_archived: false, classrooms_enabled: true, ...overrides,
});

describe('requireStudent', () => {
  it('refuses any other role without touching the database', async () => {
    for (const role of ['ADMIN', 'TEACHER', 'PARENT', undefined]) {
      const { res, next } = await run({ user: { role, userId: USER_ID, school: 'ALHAADIACADEMY' } });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it("keys the lookup on the token's user, the request year and the token's school", async () => {
    mockQueryResponse([row()]);
    const { req, next } = await run();
    expect(db.query.mock.calls[0][1]).toEqual([USER_ID, YEAR_ID, 'ALHAADIACADEMY']);
    expect(next).toHaveBeenCalled();
    expect(req.student).toEqual({
      studentId: STUDENT_ID, name: '  Amal Noor Haddad', firstName: 'Amal', grade: '2', schoolYearId: YEAR_ID, userId: USER_ID,
    });
  });

  it('is 403 NO_STUDENT_LINK without a link for the year (or without a year)', async () => {
    mockQueryResponse([]);
    const linkless = await run();
    expect(linkless.res.status).toHaveBeenCalledWith(403);
    expect(linkless.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_STUDENT_LINK' }));

    const yearless = await run({ schoolYear: null });
    expect(yearless.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_STUDENT_LINK' }));
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('is 401 for an archived login', async () => {
    mockQueryResponse([row({ user_archived: true })]);
    const { res, next } = await run();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('is 403 CLASSROOM_DISABLED once the school turns classrooms off', async () => {
    mockQueryResponse([row({ classrooms_enabled: null })]);
    const { res, next } = await run();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CLASSROOM_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed on a database error', async () => {
    mockQueryError('DB down');
    const { res, next } = await run();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
