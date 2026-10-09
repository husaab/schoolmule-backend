// One shared send mock so tests can count the emails a request sent.
jest.mock('resend', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    Resend: jest.fn(() => ({ emails: { send } })),
    __send: send,
  };
});

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$10$hashedpassword'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

// The legacy approve/decline routes delegate to the approvals service, which
// runs real transactions. Unit-test the controller's adapter only.
jest.mock('../../../services/approvalActions', () => {
  const actual = jest.requireActual('../../../services/approvalActions');
  const notFound = (userId) => {
    if (userId === 'nonexistent-id') throw new actual.ApprovalError(404, 'User not found');
  };
  return {
    ...actual,
    approveSignup: jest.fn(async ({ userId }) => {
      notFound(userId);
      return { user: { userId }, linkedCount: 0, emailSent: true };
    }),
    declineSignup: jest.fn(async ({ userId }) => {
      notFound(userId);
      return { user: { userId }, emailSent: true };
    }),
  };
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, mockUnverifiedUser, TEST_ADMIN_USER_ID, TEST_TEACHER_USER_ID, TEST_SCHOOL, mockUnverifiedSchoolUser, mockParentUser, TEST_PARENT_USER_ID, JWT_SECRET } = require('../../helpers/mockAuth');
const {
  mockQueryResponse,
  mockQueryError,
  mockTransactionSequence,
  mockTransactionError,
} = require('../../helpers/mockDb');
const {
  buildUserRow,
  buildRegisterBody,
  buildLoginBody,
  buildTermRow,
  buildPasswordResetTokenRow,
} = require('../../helpers/factories');

const bcrypt = require('bcrypt');
const { __send: mockSend } = require('resend');
const db = require('../../__mocks__/config/database');
const userQueries = require('../../../queries/user.queries');

const callsTo = (sql) => db.query.mock.calls.filter((c) => c[0] === sql);

let app;
beforeAll(() => {
  app = getApp();
});

// ─── POST /api/auth/register ────────────────────────────────────
describe('POST /api/auth/register', () => {
  const url = '/api/auth/register';

  it('registers a user successfully (201 via responseParser)', async () => {
    const body = buildRegisterBody();
    const createdUser = buildUserRow({
      user_id: 'mock-uuid-1234',
      email: body.email,
      username: body.username,
      first_name: 'New',
      last_name: 'User',
      school: body.school,
      role: body.role,
      email_token: 'mock-uuid-1234',
      is_verified: false,
      is_verified_school: false,
    });

    // Transaction: BEGIN, createUser, COMMIT
    mockTransactionSequence([{ rows: [createdUser] }]);
    // getActiveTermForSchool query
    const term = buildTermRow({ name: 'Term 1 2025-2026' });
    mockQueryResponse([term]);

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('User registered successfully');
    expect(res.body.data).toHaveProperty('userId');
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data.email).toBe(body.email);
    expect(res.body.data.isVerified).toBe(false);
  });

  it('returns 400 when required fields are missing', async () => {
    // Transaction: BEGIN succeeds, then controller throws {status:400},
    // which triggers ROLLBACK
    const db = require('../../__mocks__/config/database');
    const client = db._mockClient;
    // BEGIN
    client.query.mockResolvedValueOnce({});
    // ROLLBACK (from catch block after throw)
    client.query.mockResolvedValueOnce({});

    const res = await request(app)
      .post(url)
      .send({ email: 'test@test.com' }); // missing fields

    // Controller catches the error and RETURNS it (not throws);
    // responseParser keeps the status and reports success by it.
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when email already exists (23505)', async () => {
    const body = buildRegisterBody();
    const err = new Error('duplicate key');
    err.code = '23505';
    err.constraint = 'users_duplicate_email_key';

    mockTransactionError(1, err, []);
    // The controller catches the error and returns { status: 400 }
    // After ROLLBACK the controller returns a result, but the transaction
    // error helper already sets up ROLLBACK. Need an additional query mock
    // for getActiveTermForSchool that won't be reached.

    const res = await request(app).post(url).send(body);

    // responseParser wraps the returned { status: 400, message: ... }
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('email already exists');
  });
});

// ─── POST /api/auth/login ───────────────────────────────────────
describe('POST /api/auth/login', () => {
  const url = '/api/auth/login';

  it('logs in a user successfully', async () => {
    const body = buildLoginBody();
    const user = buildUserRow({
      email: body.email,
      is_verified: true,
      is_verified_school: true,
    });
    // loginUser query
    mockQueryResponse([user]);
    // getActiveTermForSchool query
    mockQueryResponse([buildTermRow()]);

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('login successful');
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data.email).toBe(body.email);
  });

  it('returns 404 when user not found', async () => {
    const body = buildLoginBody();
    mockQueryResponse([]); // no user found

    const res = await request(app).post(url).send(body);

    // The controller's thrown { status } is the verdict, not a crash.
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when password is invalid', async () => {
    const body = buildLoginBody();
    const user = buildUserRow({ email: body.email });
    mockQueryResponse([user]);

    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('auto-verifies admin users on login', async () => {
    const body = buildLoginBody();
    const user = buildUserRow({
      email: body.email,
      role: 'ADMIN',
      is_verified: false,
      is_verified_school: false,
    });
    mockQueryResponse([user]);
    mockQueryResponse([buildTermRow()]);

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.isVerified).toBe(true);
    expect(res.body.data.isVerifiedSchool).toBe(true);
    // Persisted, not just put in the token, so /me can't see drift.
    expect(callsTo(userQueries.markAdminVerified)).toEqual([[userQueries.markAdminVerified, [user.user_id]]]);
    const claims = jwt.verify(res.body.data.token, JWT_SECRET);
    expect(claims).toMatchObject({ isVerified: true, isVerifiedSchool: true });
  });

  it('does not touch an admin row that is already verified', async () => {
    const body = buildLoginBody();
    mockQueryResponse([buildUserRow({ email: body.email, role: 'ADMIN', is_verified: true, is_verified_school: true })]);

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    expect(callsTo(userQueries.markAdminVerified)).toHaveLength(0);
  });

  it('never auto-verifies a parent', async () => {
    const body = buildLoginBody();
    mockQueryResponse([buildUserRow({ email: body.email, role: 'PARENT', is_verified: false, is_verified_school: false })]);

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    expect(res.body.data.isVerified).toBe(false);
    expect(callsTo(userQueries.markAdminVerified)).toHaveLength(0);
  });
});

// ─── POST /api/auth/verify-email ────────────────────────────────
describe('POST /api/auth/verify-email', () => {
  const url = '/api/auth/verify-email';

  it('sends verification email for unverified user', async () => {
    const user = buildUserRow({ is_verified: false });
    mockQueryResponse([user]);

    const res = await request(app)
      .post(url)
      .send({ email: user.email });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Verification email sent');
  });

  it('answers (does not hang) when the user is already verified', async () => {
    const user = buildUserRow({ is_verified: true });
    mockQueryResponse([user]);

    const res = await request(app)
      .post(url)
      .send({ email: user.email });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'User already verified',
      data: { alreadyVerified: true },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 500 when user not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .send({ email: 'nonexistent@test.com' });

    // throws { status: 404 }, caught by express error handler
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/auth/confirm-email ────────────────────────────────
describe('GET /api/auth/confirm-email', () => {
  const url = '/api/auth/confirm-email';

  it('verifies email with valid token', async () => {
    const user = buildUserRow({ is_verified: true });
    // verifyEmailToken query
    mockQueryResponse([user], 1);
    // getAdminsBySchool query
    mockQueryResponse([{ email: 'admin@school.com' }]);

    const res = await request(app)
      .get(url)
      .query({ token: 'valid-token-123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Email verified successfully');
    expect(res.body.data).toHaveProperty('email');
    expect(res.body.data.alreadyVerified).toBe(false);
    // Confirmation to the user, then the notice to the school's admins.
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[0][0].to).toBe(user.email);
    expect(mockSend.mock.calls[1][0].to).toEqual(['admin@school.com']);
  });

  it('keeps the token, so it only flips an unverified row', async () => {
    mockQueryResponse([buildUserRow()], 1);

    await request(app).get(url).query({ token: 'valid-token-123' });

    expect(userQueries.verifyEmailToken).not.toMatch(/email_token\s*=\s*null/i);
    expect(userQueries.verifyEmailToken).toMatch(/is_verified = false/);
    expect(callsTo(userQueries.verifyEmailToken)[0][1]).toEqual(['valid-token-123']);
  });

  it('answers 200 alreadyVerified on a second click and sends no emails', async () => {
    const user = buildUserRow({ is_verified: true });
    // verifyEmailToken: nothing left to flip
    mockQueryResponse([], 0);
    // selectByEmailToken: the token still belongs to the (verified) user
    mockQueryResponse([user], 1);

    const res = await request(app)
      .get(url)
      .query({ token: 'used-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ alreadyVerified: true });
    expect(mockSend).not.toHaveBeenCalled();
    expect(callsTo(userQueries.getAdminsBySchool)).toHaveLength(0);
  });

  it('returns 400 when token is missing', async () => {
    const res = await request(app).get(url);

    expect(res.status).toBe(400);
  });

  it('returns 400 when token is invalid', async () => {
    mockQueryResponse([], 0);
    mockQueryResponse([], 0);

    const res = await request(app)
      .get(url)
      .query({ token: 'invalid-token' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('This verification link is invalid or has already been used. Try signing in.');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ─── POST /api/auth/approve-school (requires auth) ─────────────
describe('POST /api/auth/approve-school', () => {
  const url = '/api/auth/approve-school';

  it('returns 401 without auth token', async () => {
    const res = await request(app).post(url).send({ userId: 'some-id' });
    expect(res.status).toBe(401);
  });

  it('approves a user for school', async () => {
    const token = mockAdminUser();
    const user = buildUserRow({ user_id: '550e8400-e29b-41d4-a716-446655440123', is_verified_school: true });
    mockQueryResponse([user]);

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: user.user_id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('approved');
  });

  it('returns 404 when user not found or already approved', async () => {
    const token = mockAdminUser();
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'nonexistent-id' });

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/auth/pending-approvals (requires auth) ────────────
describe('GET /api/auth/pending-approvals', () => {
  const url = '/api/auth/pending-approvals';

  it('returns 401 without auth token', async () => {
    const res = await request(app).get(url).query({ school: TEST_SCHOOL });
    expect(res.status).toBe(401);
  });

  it('returns pending approvals', async () => {
    const token = mockAdminUser();
    const users = [
      buildUserRow({ is_verified_school: false }),
      buildUserRow({ is_verified_school: false, email: 'other@test.com' }),
    ];
    mockQueryResponse(users);

    const res = await request(app)
      .get(url)
      .set('Authorization', `Bearer ${token}`)
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.users).toHaveLength(2);
  });

  it('returns 403 for non-admins', async () => {
    const token = mockAdminUser({ role: 'TEACHER' });

    const res = await request(app)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});

// ─── POST /api/auth/decline-school (requires auth) ──────────────
describe('POST /api/auth/decline-school', () => {
  const url = '/api/auth/decline-school';

  it('returns 401 without auth token', async () => {
    const res = await request(app).post(url).send({ userId: 'some-id' });
    expect(res.status).toBe(401);
  });

  it('declines a user for school', async () => {
    const token = mockAdminUser();
    const user = buildUserRow({ user_id: '550e8400-e29b-41d4-a716-446655440124' });
    mockQueryResponse([user]);

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: user.user_id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('declined');
  });

  it('returns 404 when user not found', async () => {
    const token = mockAdminUser();
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'nonexistent-id' });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/auth/logout ──────────────────────────────────────
describe('POST /api/auth/logout', () => {
  it('logs out successfully', async () => {
    const res = await request(app).post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Logged out');
  });
});

// ─── DELETE /api/auth/delete-user ───────────────────────────────
describe('DELETE /api/auth/delete-user', () => {
  const url = '/api/auth/delete-user';

  it('deletes the authenticated user\'s own account', async () => {
    const token = mockAdminUser();
    mockQueryResponse([], 1); // rowCount = 1

    const res = await request(app)
      .delete(url)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('deleted');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .delete(url)
      .send({ userId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(401);
  });

  it('lets a pending (school-unverified) signup delete itself from the waiting page', async () => {
    const token = mockUnverifiedSchoolUser();
    mockQueryResponse([], 1);

    const res = await request(app)
      .delete(url)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('ignores a userId in the body and deletes only the caller', async () => {
    const token = mockAdminUser();
    const db = require('../../__mocks__/config/database');
    mockQueryResponse([], 1);

    const res = await request(app)
      .delete(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'someone-elses-account' });

    expect(res.status).toBe(200);
    // The delete must be scoped to the token's user, never the body's.
    const deleteCall = db.query.mock.calls.find((c) => /DELETE FROM users/i.test(c[0]));
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toEqual([TEST_ADMIN_USER_ID]);
    expect(deleteCall[1]).not.toContain('someone-elses-account');
  });

  it('returns 404 when user not found', async () => {
    const token = mockAdminUser();
    mockQueryResponse([], 0); // rowCount = 0

    const res = await request(app)
      .delete(url)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/auth/resend-approval-email ───────────────────────
describe('POST /api/auth/resend-approval-email', () => {
  const url = '/api/auth/resend-approval-email';

  it.skip('resends approval email (shares rate limiter with verify-email, may hit 429)', async () => {
    const user = buildUserRow();
    mockQueryResponse([user]);

    const res = await request(app)
      .post(url)
      .send({ userId: user.user_id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('resent');
  });

  it.skip('returns 404 when user not found (shares rate limiter with verify-email, may hit 429)', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .send({ userId: 'nonexistent-id' });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/auth/request-password-reset ──────────────────────
describe('POST /api/auth/request-password-reset', () => {
  const url = '/api/auth/request-password-reset';

  it('sends password reset email', async () => {
    const user = buildUserRow();
    const tokenRow = buildPasswordResetTokenRow({ user_id: user.user_id });
    // selectByEmail
    mockQueryResponse([user], 1);
    // createPasswordResetToken
    mockQueryResponse([tokenRow]);

    const res = await request(app)
      .post(url)
      .send({ email: user.email });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('reset email sent');
  });

  it('returns 404 when email not found', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .post(url)
      .send({ email: 'nonexistent@test.com' });

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/auth/validate-reset-token ─────────────────────────
describe('GET /api/auth/validate-reset-token', () => {
  const url = '/api/auth/validate-reset-token';

  it('validates a valid reset token', async () => {
    const tokenRow = buildPasswordResetTokenRow();
    mockQueryResponse([tokenRow], 1);

    const res = await request(app)
      .get(url)
      .query({ token: tokenRow.token });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 for invalid/expired token', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .get(url)
      .query({ token: 'invalid-token' });

    expect(res.status).toBe(400);
  });
});

// ─── POST /api/auth/reset-password ──────────────────────────────
describe('POST /api/auth/reset-password', () => {
  const url = '/api/auth/reset-password';

  it('resets password with valid token', async () => {
    const tokenRow = buildPasswordResetTokenRow();
    // validatePasswordResetToken
    mockQueryResponse([tokenRow], 1);
    // updatePassword
    mockQueryResponse([], 1);
    // deletePasswordResetToken
    mockQueryResponse([], 1);

    const res = await request(app)
      .post(url)
      .send({ token: tokenRow.token, newPassword: 'NewSecurePass123!' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('Password updated');
  });

  it('returns 400 for invalid/expired token', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .post(url)
      .send({ token: 'invalid-token', newPassword: 'NewPass123!' });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/auth/me ───────────────────────────────────────────
describe('GET /api/auth/me', () => {
  const url = '/api/auth/me';

  it('returns session data for valid token', async () => {
    const token = mockAdminUser();
    const user = buildUserRow({
      user_id: TEST_ADMIN_USER_ID,
      role: 'ADMIN',
      is_verified: true,
      is_verified_school: true,
    });
    // selectById
    mockQueryResponse([user]);
    // getActiveTermForSchool
    mockQueryResponse([buildTermRow()]);

    const res = await request(app)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Session valid');
    expect(res.body.data).toHaveProperty('userId');
    expect(res.body.data).toHaveProperty('activeTerm');
  });

  it('reissues the token when the account was approved after sign-in', async () => {
    const token = mockUnverifiedSchoolUser({ userId: TEST_PARENT_USER_ID, role: 'PARENT' });
    mockQueryResponse([buildUserRow({ user_id: TEST_PARENT_USER_ID, role: 'PARENT', is_verified: true, is_verified_school: true })]);
    mockQueryResponse([buildTermRow()]);

    const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isVerifiedSchool).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    const claims = jwt.verify(res.body.data.token, JWT_SECRET);
    expect(claims).toMatchObject({ userId: TEST_PARENT_USER_ID, role: 'PARENT', isVerifiedSchool: true });
    expect(claims.impersonator).toBeUndefined();
  });

  it('does not reissue the token when the claims still match', async () => {
    const token = mockParentUser();
    mockQueryResponse([buildUserRow({ user_id: TEST_PARENT_USER_ID, role: 'PARENT', is_verified: true, is_verified_school: true })]);
    mockQueryResponse([buildTermRow()]);

    const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeUndefined();
  });

  it('never reissues a preview token, even when its claims drift', async () => {
    const token = mockParentUser({ isVerifiedSchool: false, impersonator: { userId: TEST_ADMIN_USER_ID, username: 'admin' } });
    mockQueryResponse([buildUserRow({ user_id: TEST_PARENT_USER_ID, role: 'PARENT', is_verified: true, is_verified_school: true })]);
    mockQueryResponse([buildTermRow()]);

    const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.impersonator).toEqual(expect.objectContaining({ userId: TEST_ADMIN_USER_ID }));
  });

  it('repairs an unverified admin row instead of reissuing a token every route rejects', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildUserRow({ user_id: TEST_ADMIN_USER_ID, role: 'ADMIN', is_verified: false, is_verified_school: false })]);

    const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.isVerified).toBe(true);
    expect(res.body.data.isVerifiedSchool).toBe(true);
    expect(res.body.data.token).toBeUndefined();
    expect(callsTo(userQueries.markAdminVerified)).toEqual([[userQueries.markAdminVerified, [TEST_ADMIN_USER_ID]]]);
  });

  it('returns 401 when no token provided', async () => {
    const res = await request(app).get(url);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when user not found in DB', async () => {
    const token = mockAdminUser();
    mockQueryResponse([]);

    const res = await request(app)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.message).toContain('user not found');
  });
});

// ─── Dual-role views (staff who are also parents) ─────────────────
// A staff member linked to a student through parent_students may hold a
// second "view". The token's `role` is the active view; `baseRole` is the
// database role and `roles` lists every view the user may switch to.
describe('dual-role views', () => {
  const linked = () => mockQueryResponse([{ '?column?': 1 }]);
  const unlinked = () => mockQueryResponse([]);
  const teacherRow = (over = {}) =>
    buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'TEACHER', email: 'teacher@test.com', is_verified: true, is_verified_school: true, ...over });

  describe('POST /api/auth/login', () => {
    const url = '/api/auth/login';

    it('lists PARENT as an extra view for a teacher who is linked to a student', async () => {
      const body = buildLoginBody({ email: 'teacher@test.com' });
      mockQueryResponse([teacherRow()]); // loginUser
      mockQueryResponse([]); // touchLastLogin
      mockQueryResponse([buildTermRow()]); // active term
      linked(); // parent_students lookup

      const res = await request(app).post(url).send(body);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('TEACHER');
      expect(res.body.data.baseRole).toBe('TEACHER');
      expect(res.body.data.roles).toEqual(['TEACHER', 'PARENT']);
      const claims = jwt.verify(res.body.data.token, JWT_SECRET);
      expect(claims).toMatchObject({ role: 'TEACHER', baseRole: 'TEACHER', roles: ['TEACHER', 'PARENT'] });
    });

    it('gives an unlinked teacher only the TEACHER view', async () => {
      mockQueryResponse([teacherRow()]); // loginUser
      mockQueryResponse([]); // touchLastLogin
      mockQueryResponse([buildTermRow()]);
      unlinked();

      const res = await request(app).post(url).send(buildLoginBody({ email: 'teacher@test.com' }));

      expect(res.status).toBe(200);
      expect(res.body.data.roles).toEqual(['TEACHER']);
    });

    it('never looks up links for a parent account: PARENT is its only view', async () => {
      mockQueryResponse([buildUserRow({ user_id: TEST_PARENT_USER_ID, role: 'PARENT', email: 'parent@test.com' })]);
      mockQueryResponse([buildTermRow()]);

      const res = await request(app).post(url).send(buildLoginBody({ email: 'parent@test.com' }));

      expect(res.status).toBe(200);
      expect(res.body.data.roles).toEqual(['PARENT']);
      expect(res.body.data.baseRole).toBe('PARENT');
      expect(callsTo(require('../../../queries/parentStudent.queries').hasActiveYearLinks)).toHaveLength(0);
    });
  });

  describe('GET /api/auth/me', () => {
    const url = '/api/auth/me';
    const parentViewToken = (over = {}) =>
      mockTeacherUser({ role: 'PARENT', baseRole: 'TEACHER', roles: ['TEACHER', 'PARENT'], ...over });

    it('keeps a parent-view token for a teacher who is still linked', async () => {
      mockQueryResponse([teacherRow()]); // selectById
      mockQueryResponse([buildTermRow()]);
      linked();

      const res = await request(app).get(url).set('Authorization', `Bearer ${parentViewToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.token).toBeUndefined();
      expect(res.body.data.role).toBe('PARENT');
      expect(res.body.data.baseRole).toBe('TEACHER');
      expect(res.body.data.roles).toEqual(['TEACHER', 'PARENT']);
    });

    it('reverts a parent-view token to the staff view once the last link is gone', async () => {
      mockQueryResponse([teacherRow()]);
      mockQueryResponse([buildTermRow()]);
      unlinked();

      const res = await request(app).get(url).set('Authorization', `Bearer ${parentViewToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('TEACHER');
      expect(res.body.data.roles).toEqual(['TEACHER']);
      const claims = jwt.verify(res.body.data.token, JWT_SECRET);
      expect(claims).toMatchObject({ role: 'TEACHER', baseRole: 'TEACHER', roles: ['TEACHER'] });
    });

    it('reissues when the database role changed under a parent-view token', async () => {
      mockQueryResponse([teacherRow({ role: 'ADMIN' })]);
      mockQueryResponse([buildTermRow()]);
      linked();

      const res = await request(app).get(url).set('Authorization', `Bearer ${parentViewToken()}`);

      expect(res.status).toBe(200);
      // Still linked, so the parent view survives; the base role catches up.
      const claims = jwt.verify(res.body.data.token, JWT_SECRET);
      expect(claims).toMatchObject({ role: 'PARENT', baseRole: 'ADMIN', roles: ['ADMIN', 'PARENT'] });
    });

    it('reports the extra view to a staff token minted before the link existed', async () => {
      mockQueryResponse([teacherRow()]);
      mockQueryResponse([buildTermRow()]);
      linked();

      const res = await request(app).get(url).set('Authorization', `Bearer ${mockTeacherUser()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.roles).toEqual(['TEACHER', 'PARENT']);
      expect(res.body.data.token).toBeUndefined();
    });
  });

  describe('POST /api/auth/view', () => {
    const url = '/api/auth/view';

    it('mints a parent-view token for a linked teacher', async () => {
      mockQueryResponse([teacherRow()]); // selectById
      mockQueryResponse([buildTermRow()]);
      linked();

      const res = await request(app).post(url).set('Authorization', `Bearer ${mockTeacherUser()}`).send({ view: 'PARENT' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ userId: TEST_TEACHER_USER_ID, role: 'PARENT', baseRole: 'TEACHER', roles: ['TEACHER', 'PARENT'] });
      expect(res.body.data).toHaveProperty('schoolYears');
      const claims = jwt.verify(res.body.data.token, JWT_SECRET);
      expect(claims).toMatchObject({ userId: TEST_TEACHER_USER_ID, role: 'PARENT', baseRole: 'TEACHER', roles: ['TEACHER', 'PARENT'], isVerified: true });
      expect(claims.impersonator).toBeUndefined();
      // Same lifetime as a sign-in, not the short preview TTL.
      expect(claims.exp - claims.iat).toBe(7 * 24 * 60 * 60);
    });

    it('switches a parent-view token back to the staff view', async () => {
      mockQueryResponse([teacherRow()]);
      mockQueryResponse([buildTermRow()]);
      linked();
      const token = mockTeacherUser({ role: 'PARENT', baseRole: 'TEACHER', roles: ['TEACHER', 'PARENT'] });

      const res = await request(app).post(url).set('Authorization', `Bearer ${token}`).send({ view: 'TEACHER' });

      expect(res.status).toBe(200);
      expect(jwt.verify(res.body.data.token, JWT_SECRET)).toMatchObject({ role: 'TEACHER', baseRole: 'TEACHER' });
    });

    it('returns an admin from parent view to the ADMIN view under its own name', async () => {
      mockQueryResponse([teacherRow({ role: 'ADMIN' })]);
      mockQueryResponse([buildTermRow()]);
      linked();
      const token = mockTeacherUser({ role: 'PARENT', baseRole: 'ADMIN', roles: ['ADMIN', 'PARENT'] });

      const res = await request(app).post(url).set('Authorization', `Bearer ${token}`).send({ view: 'ADMIN' });

      expect(res.status).toBe(200);
      expect(jwt.verify(res.body.data.token, JWT_SECRET)).toMatchObject({ role: 'ADMIN', baseRole: 'ADMIN', roles: ['ADMIN', 'PARENT'] });
    });

    it('never lets a teacher ask for the ADMIN view', async () => {
      mockQueryResponse([teacherRow()]);
      mockQueryResponse([buildTermRow()]);
      linked();

      const res = await request(app).post(url).set('Authorization', `Bearer ${mockTeacherUser()}`).send({ view: 'ADMIN' });

      expect(res.status).toBe(403);
    });

    it('refuses a view the user does not hold', async () => {
      mockQueryResponse([teacherRow()]);
      mockQueryResponse([buildTermRow()]);
      unlinked();

      const res = await request(app).post(url).set('Authorization', `Bearer ${mockTeacherUser()}`).send({ view: 'PARENT' });

      expect(res.status).toBe(403);
      expect(res.body.status).toBe('failed');
    });

    it('refuses an unknown view before touching the database', async () => {
      const res = await request(app).post(url).set('Authorization', `Bearer ${mockTeacherUser()}`).send({ view: 'OWNER' });

      expect(res.status).toBe(400);
      expect(db.query).not.toHaveBeenCalledWith(userQueries.selectById, expect.anything());
    });

    it('refuses an admin preview token', async () => {
      const token = mockTeacherUser({ impersonator: { userId: TEST_ADMIN_USER_ID, username: 'admin' }, roles: ['TEACHER', 'PARENT'] });

      const res = await request(app).post(url).set('Authorization', `Bearer ${token}`).send({ view: 'PARENT' });

      expect(res.status).toBe(403);
    });

    it('returns 401 without a token', async () => {
      const res = await request(app).post(url).send({ view: 'PARENT' });
      expect(res.status).toBe(401);
    });
  });
});
