const parentApiGate = require('../../../middleware/parentApiGate');

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const run = (view, url) => {
  const res = makeRes();
  const next = jest.fn();
  parentApiGate({ access: { view }, user: { userId: 'u1' }, originalUrl: url, method: 'GET' }, res, next);
  return { res, next };
};

describe('parentApiGate', () => {
  const original = process.env.RBAC_PARENT_GATE;
  afterEach(() => {
    if (original === undefined) delete process.env.RBAC_PARENT_GATE;
    else process.env.RBAC_PARENT_GATE = original;
  });

  it('never touches a staff view, in either mode', () => {
    process.env.RBAC_PARENT_GATE = 'enforce';
    const { res, next } = run('TEACHER', '/api/classes');
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
  });

  it('lets a parent reach the parent portal and its query strings', () => {
    process.env.RBAC_PARENT_GATE = 'enforce';
    expect(run('PARENT', '/api/parent-portal/summary?year=1').next).toHaveBeenCalledWith();
    expect(run('PARENT', '/api/messaging').next).toHaveBeenCalledWith();
  });

  it('only logs a parent on a staff route by default', () => {
    delete process.env.RBAC_PARENT_GATE;
    const { res, next } = run('PARENT', '/api/classes/123/students');
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
  });

  it('refuses a parent on a staff route when enforcing', () => {
    process.env.RBAC_PARENT_GATE = 'enforce';
    const { res, next } = run('PARENT', '/api/classes/123/students');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('matches whole path segments, not prefixes of a longer name', () => {
    expect(parentApiGate.allowedForParent('/api/users')).toBe(true);
    expect(parentApiGate.allowedForParent('/api/users/abc')).toBe(true);
    expect(parentApiGate.allowedForParent('/api/users-export')).toBe(false);
  });

  it('does not let a parent reach the assistant until it has a parent tool set', () => {
    expect(parentApiGate.allowedForParent('/api/assistant/turns')).toBe(false);
  });
});
