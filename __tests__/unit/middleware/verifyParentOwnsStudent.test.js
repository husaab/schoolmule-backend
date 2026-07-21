const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const verifyParentOwnsStudent = require('../../../middleware/verifyParentOwnsStudent');

const STUDENT_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const makeReq = () => ({
  params: { studentId: STUDENT_ID },
  user: { userId: PARENT_ID, role: 'PARENT', school: 'ALHAADIACADEMY' },
});

describe('verifyParentOwnsStudent', () => {
  beforeEach(() => db._reset());

  it('calls next when the parent-student link exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ parent_student_link_id: 'link-1' }] });
    const next = jest.fn();
    await verifyParentOwnsStudent(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM parent_students'), [
      STUDENT_ID,
      PARENT_ID,
    ]);
  });

  it('rejects with 403 when no link exists', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const next = jest.fn();
    const res = makeRes();
    await verifyParentOwnsStudent(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects with 403 when the lookup throws (e.g. malformed UUID)', async () => {
    db.query.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
    const next = jest.fn();
    const res = makeRes();
    await verifyParentOwnsStudent(makeReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
