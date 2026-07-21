const requireParent = require('../../../middleware/requireParent');

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

describe('requireParent', () => {
  it('calls next for PARENT users', () => {
    const next = jest.fn();
    requireParent({ user: { role: 'PARENT' } }, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each(['ADMIN', 'TEACHER', undefined])('rejects role %s with 403', (role) => {
    const next = jest.fn();
    const res = makeRes();
    requireParent({ user: role ? { role } : undefined }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.status).toBe('failed');
  });
});
