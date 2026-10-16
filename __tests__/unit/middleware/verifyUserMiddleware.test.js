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
      code: 'ACCOUNT_NOT_VERIFIED',
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
      code: 'ACCOUNT_NOT_VERIFIED',
      message: 'Access denied: account not fully verified.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  describe('tokenOnly', () => {
    it('lets a pending (school-unverified) token through', () => {
      const token = jwt.sign(
        { userId: 'pending', isVerified: true, isVerifiedSchool: false },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      req.headers.authorization = `Bearer ${token}`;

      verifyUser.tokenOnly(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user.userId).toBe('pending');
      expect(res.status).not.toHaveBeenCalled();
    });

    it('still rejects a missing or invalid token', () => {
      verifyUser.tokenOnly(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);

      res.status.mockClear();
      req.headers.authorization = 'Bearer not-a-jwt';
      verifyUser.tokenOnly(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('keeps preview tokens read-only', () => {
      const token = jwt.sign(
        { userId: 'x', isVerified: true, isVerifiedSchool: true, impersonator: { userId: 'admin' } },
        JWT_SECRET,
        { expiresIn: '1h' }
      );
      req.headers.authorization = `Bearer ${token}`;
      req.method = 'DELETE';

      verifyUser.tokenOnly(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IMPERSONATION_READ_ONLY' }));
    });
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

describe('verifyUser: the student fence', () => {
  const SECRET = process.env.JWT_SECRET;
  const sign = (claims) => jwt.sign(
    { userId: 'student-1', school: 'ALHAADIACADEMY', isVerified: true, isVerifiedSchool: true, ...claims },
    SECRET,
    { expiresIn: '1h' }
  );

  const run = (token, { method = 'GET', originalUrl, verifier = verifyUser } = {}) => {
    const req = { method, originalUrl, url: originalUrl, headers: { authorization: `Bearer ${token}` } };
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    const next = jest.fn();
    verifier(req, res, next);
    return { req, res, next };
  };

  const FORBIDDEN = {
    success: false,
    status: 'failed',
    code: 'STUDENT_FORBIDDEN',
    message: 'This page is not available to student accounts.',
  };

  it('STUDENT token on /api/classes -> 403 STUDENT_FORBIDDEN and next not called', () => {
    const { res, next } = run(sign({ role: 'STUDENT' }), { originalUrl: '/api/classes' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual(FORBIDDEN);
  });

  it('STUDENT token on /api/student/me -> next called', () => {
    const { req, res, next } = run(sign({ role: 'STUDENT' }), { originalUrl: '/api/student/me' });
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
    expect(req.user.role).toBe('STUDENT');
  });

  it('STUDENT token on /api/students (prefix boundary) -> 403', () => {
    const { res, next } = run(sign({ role: 'STUDENT' }), { originalUrl: '/api/students/abc' });
    expect(next).not.toHaveBeenCalled();
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('TEACHER token on /api/classes -> next called', () => {
    const { next } = run(sign({ role: 'TEACHER' }), { originalUrl: '/api/classes' });
    expect(next).toHaveBeenCalledWith();
  });

  it('a token whose base role is STUDENT is fenced whatever its active view claims', () => {
    const { res, next } = run(sign({ role: 'TEACHER', baseRole: 'STUDENT' }), { originalUrl: '/api/classes' });
    expect(next).not.toHaveBeenCalled();
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('STUDENT preview token (impersonator) GET /api/student/home -> next called; POST -> 403 IMPERSONATION_READ_ONLY', () => {
    const preview = sign({ role: 'STUDENT', impersonator: { userId: 'admin-1', username: 'admin', fullName: 'Amal Haddad' } });

    const get = run(preview, { method: 'GET', originalUrl: '/api/student/home' });
    expect(get.next).toHaveBeenCalledWith();
    expect(get.req.user.impersonator.userId).toBe('admin-1');

    const post = run(preview, { method: 'POST', originalUrl: '/api/student/home' });
    expect(post.next).not.toHaveBeenCalled();
    expect(post.res.statusCode).toBe(403);
    expect(post.res.body.code).toBe('IMPERSONATION_READ_ONLY');
  });

  it('STUDENT preview token on a staff path is fenced, not merely read-only', () => {
    const preview = sign({ role: 'STUDENT', impersonator: { userId: 'admin-1' } });
    const { res, next } = run(preview, { method: 'GET', originalUrl: '/api/classes' });
    expect(next).not.toHaveBeenCalled();
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('unverified STUDENT token on a staff path -> STUDENT_FORBIDDEN (fence runs before the verified check)', () => {
    const { res, next } = run(sign({ role: 'STUDENT', isVerified: false, isVerifiedSchool: false }), { originalUrl: '/api/classes' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('tokenOnly fences students too (e.g. DELETE /api/auth/delete-user)', () => {
    const { res, next } = run(sign({ role: 'STUDENT' }), {
      method: 'DELETE', originalUrl: '/api/auth/delete-user', verifier: verifyUser.tokenOnly,
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('tokenOnly lets a STUDENT token post client error reports', () => {
    const { next } = run(sign({ role: 'STUDENT' }), {
      method: 'POST', originalUrl: '/api/observe/client-events', verifier: verifyUser.tokenOnly,
    });
    expect(next).toHaveBeenCalledWith();
  });
});
