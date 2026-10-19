// A QR-card student session ends on /api/profile too once the card is voided
// or reprinted (re-review N4); everyone else passes without a query.

const db = require('../../../config/database');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const requireLiveQrCard = require('../../../middleware/requireLiveQrCard');

const USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const HASH = 'a'.repeat(64);

const run = async (user) => {
  const req = { user };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  await requireLiveQrCard(req, res, next);
  return { res, next };
};

describe('requireLiveQrCard', () => {
  it('lets staff, parents and student sessions not from a card through without a query', async () => {
    for (const user of [
      { role: 'TEACHER', userId: USER_ID }, { role: 'PARENT', userId: USER_ID }, { role: 'STUDENT', userId: USER_ID },
    ]) expect((await run(user)).next).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('passes a live card and ends a voided or reprinted one (401 QR_INVALID)', async () => {
    const user = { role: 'STUDENT', baseRole: 'STUDENT', userId: USER_ID, qrCard: 'a'.repeat(16) };
    mockQueryResponse([{ qr_secret_hash: HASH, qr_voided_at: null }]);
    expect((await run(user)).next).toHaveBeenCalled();
    expect(db.query.mock.calls[0][1]).toEqual([USER_ID]);

    mockQueryResponse([{ qr_secret_hash: HASH, qr_voided_at: new Date() }]);
    let out = await run(user);
    expect(out.res.status).toHaveBeenCalledWith(401);
    expect(out.res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'QR_INVALID' }));
    expect(out.next).not.toHaveBeenCalled();

    mockQueryResponse([{ qr_secret_hash: 'b'.repeat(64), qr_voided_at: null }]);
    out = await run(user);
    expect(out.res.status).toHaveBeenCalledWith(401);

    mockQueryResponse([]);
    expect((await run(user)).res.status).toHaveBeenCalledWith(401);
  });

  it('fails closed on a database error', async () => {
    mockQueryError('DB down');
    const { res, next } = await run({ role: 'STUDENT', userId: USER_ID, qrCard: 'a'.repeat(16) });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
