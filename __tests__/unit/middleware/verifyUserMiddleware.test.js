const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-unit-tests';

// Import the middleware directly (not through the app)
const verifyUser = require('../../../middleware/verifyUserMiddleware');

describe('verifyUserMiddleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('returns 401 when no Authorization header is present', () => {
    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access denied: no token provided.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with Bearer', () => {
    req.headers.authorization = 'Basic sometoken';

    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access denied: no token provided.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid JWT token', () => {
    req.headers.authorization = 'Bearer invalid-token-here';

    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access denied: invalid token.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired JWT token', () => {
    const token = jwt.sign(
      { userId: 'test', isVerified: true, isVerifiedSchool: true },
      JWT_SECRET,
      { expiresIn: '-1s' }
    );
    req.headers.authorization = `Bearer ${token}`;

    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access denied: token expired.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when isVerified is false', () => {
    const token = jwt.sign(
      { userId: 'test', isVerified: false, isVerifiedSchool: true },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    req.headers.authorization = `Bearer ${token}`;

    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access denied: account not fully verified.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when isVerifiedSchool is false', () => {
    const token = jwt.sign(
      { userId: 'test', isVerified: true, isVerifiedSchool: false },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    req.headers.authorization = `Bearer ${token}`;

    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Access denied: account not fully verified.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches req.user when token is valid and fully verified', () => {
    const payload = {
      userId: 'user-123',
      username: 'Test User',
      email: 'test@test.com',
      school: 'ALHAADIACADEMY',
      role: 'ADMIN',
      isVerified: true,
      isVerifiedSchool: true,
      activeTerm: 'Term 1',
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
    req.headers.authorization = `Bearer ${token}`;

    verifyUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeDefined();
    expect(req.user.userId).toBe('user-123');
    expect(req.user.school).toBe('ALHAADIACADEMY');
    expect(req.user.role).toBe('ADMIN');
    expect(req.user.isVerified).toBe(true);
    expect(req.user.isVerifiedSchool).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when token is signed with wrong secret', () => {
    const token = jwt.sign(
      { userId: 'test', isVerified: true, isVerifiedSchool: true },
      'wrong-secret',
      { expiresIn: '1h' }
    );
    req.headers.authorization = `Bearer ${token}`;

    verifyUser(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('verifyUser: admin "view as" preview tokens are read-only', () => {
  const jwt = require('jsonwebtoken');
  const SECRET = process.env.JWT_SECRET;
  const previewToken = jwt.sign(
    {
      userId: 'teacher-1',
      role: 'TEACHER',
      school: 'ALHAADIACADEMY',
      isVerified: true,
      isVerifiedSchool: true,
      impersonator: { userId: 'admin-1', username: 'amira', fullName: 'Amira Admin' },
    },
    SECRET,
    { expiresIn: '1h' }
  );

  const run = (method) => {
    const verifyUser = require('../../../middleware/verifyUserMiddleware');
    const req = { method, headers: { authorization: `Bearer ${previewToken}` } };
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const next = jest.fn();
    verifyUser(req, res, next);
    return { req, res, next };
  };

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets %s through and exposes the impersonator on req.user', (method) => {
    const { req, next } = run(method);
    expect(next).toHaveBeenCalledWith();
    expect(req.user.impersonator.userId).toBe('admin-1');
    expect(req.user.role).toBe('TEACHER');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks %s with 403 IMPERSONATION_READ_ONLY', (method) => {
    const { res, next } = run(method);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
  });

  it('does not block writes for a normal token', () => {
    const verifyUser = require('../../../middleware/verifyUserMiddleware');
    const token = jwt.sign(
      { userId: 'admin-1', role: 'ADMIN', isVerified: true, isVerifiedSchool: true },
      SECRET,
      { expiresIn: '1h' }
    );
    const next = jest.fn();
    verifyUser({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, {}, next);
    expect(next).toHaveBeenCalledWith();
  });
});
