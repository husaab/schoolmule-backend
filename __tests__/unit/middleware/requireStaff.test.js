const requireStaff = require('../../../middleware/requireStaff');

const run = (user) => {
  const req = user === undefined ? {} : { user };
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  const next = jest.fn();
  requireStaff(req, res, next);
  return { res, next };
};

describe('requireStaff', () => {
  it.each(['ADMIN', 'TEACHER'])('lets %s through', (role) => {
    const { res, next } = run({ role });
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
  });

  it.each(['PARENT', 'STUDENT', 'STAFF', '', 'admin'])('refuses role %p with 403', (role) => {
    const { res, next } = run({ role });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ status: 'failed', message: 'Staff access required' });
  });

  it('refuses a request with no user', () => {
    const { res, next } = run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('refuses a user with no role', () => {
    const { res, next } = run({ userId: 'x' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
