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
