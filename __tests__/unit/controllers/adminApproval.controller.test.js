// One shared send mock so tests can see the email a request sent.
jest.mock('resend', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    Resend: jest.fn(() => ({ emails: { send } })),
    __send: send,
  };
});

const { __send: mockSend } = require('resend');
const db = require('../../__mocks__/config/database');
const queries = require('../../../queries/adminApproval.queries');
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockTransactionSequence } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');

const USER_ID = '550e8400-e29b-41d4-a716-446655440777';

const signupRow = (over = {}) =>
  buildUserRow({
    user_id: USER_ID,
    email: 'parent@family.com',
    first_name: 'Pat',
    last_name: 'Parent',
    role: 'PARENT',
    is_verified: false,
    is_verified_school: false,
    is_archived: false,
    archived_at: null,
    declined_at: null,
    invite_pending: false,
    ...over,
  });

const clientCallsTo = (sql) => db._mockClient.query.mock.calls.filter((c) => c[0] === sql);

// ─── GET /api/admin/approvals ───────────────────────────────────
describe('GET /api/admin/approvals', () => {
  it('includes unverified signups, flagged by isVerified', async () => {
    mockQueryResponse([
      { ...signupRow({ user_id: 'a', is_verified: true }), matched_children: [] },
      { ...signupRow({ user_id: 'b', is_verified: false }), matched_children: [] },
    ]);

    const res = await authenticatedRequest('get', '/api/admin/approvals');

    expect(res.status).toBe(200);
    expect(res.body.data.map((u) => [u.userId, u.isVerified])).toEqual([['a', true], ['b', false]]);
    const call = db.query.mock.calls.find((c) => c[0] === queries.selectApprovalUsers);
    expect(call[1]).toEqual([TEST_SCHOOL]);
  });

  it('no longer filters on is_verified = true, but keeps the school pin', () => {
    expect(queries.selectApprovalUsers).not.toMatch(/AND is_verified = true\s/);
    expect(queries.selectApprovalUsers).toMatch(/WHERE school = \$1/);
    expect(queries.selectApprovalUsers).toMatch(/is_verified_school = false/);
  });
});

// ─── POST /api/admin/approvals/:id/resend-verification ──────────
// Behind adminVerificationResendLimiter (20 per 15 minutes per admin).
describe('POST /api/admin/approvals/:id/resend-verification', () => {
  const url = `/api/admin/approvals/${USER_ID}/resend-verification`;

  it('resends the same link as the public resend, pinned to the admin school', async () => {
    mockTransactionSequence([
      { rows: [signupRow()] },
      { rows: [{ user_id: USER_ID, email: 'parent@family.com', first_name: 'Pat', school: TEST_SCHOOL, email_token: 'tok-123' }] },
    ]);

    const res = await authenticatedRequest('post', url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', message: 'Verification email sent', data: { emailSent: true } });
    expect(clientCallsTo(queries.selectUserForUpdate)[0][1]).toEqual([USER_ID, TEST_SCHOOL]);
    // Mints a token when it was cleared, keeps the existing one otherwise.
    expect(queries.ensureEmailToken).toMatch(/COALESCE\(email_token, gen_random_uuid\(\)::text\)/);
    expect(clientCallsTo(queries.ensureEmailToken)[0][1]).toEqual([USER_ID, TEST_SCHOOL]);
    // Commit first, then email.
    const sqls = db._mockClient.query.mock.calls.map((c) => c[0]);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = mockSend.mock.calls[0][0];
    expect(sent.to).toBe('parent@family.com');
    expect(sent.subject).toBe('Verify your email at School Mule');
    expect(sent.html).toContain(`${process.env.FRONTEND_URL}/verify-email-token?token=tok-123`);
  });

  it('still answers 200 when the email is rejected', async () => {
    mockTransactionSequence([
      { rows: [signupRow()] },
      { rows: [{ user_id: USER_ID, email: 'parent@family.com', first_name: 'Pat', school: TEST_SCHOOL, email_token: 'tok-123' }] },
    ]);
    mockSend.mockResolvedValueOnce({ error: { message: 'rejected' } });

    const res = await authenticatedRequest('post', url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', message: "Couldn't send the email", data: { emailSent: false } });
  });

  it('returns 409 for a signup that already verified', async () => {
    mockTransactionSequence([{ rows: [signupRow({ is_verified: true })] }]);

    const res = await authenticatedRequest('post', url);

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('failed');
    expect(res.body.data).toEqual({ state: 'pending' });
    expect(clientCallsTo(queries.ensureEmailToken)).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ─── POST /api/admin/approvals/:id/verify-email ─────────────────
describe('POST /api/admin/approvals/:id/verify-email', () => {
  const url = `/api/admin/approvals/${USER_ID}/verify-email`;

  it('marks the email verified and returns the user', async () => {
    mockTransactionSequence([
      { rows: [signupRow()] },
      { rows: [signupRow({ is_verified: true })] },
    ]);

    const res = await authenticatedRequest('post', url);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toBe('Email marked as verified');
    expect(res.body.data).toMatchObject({ userId: USER_ID, isVerified: true, isVerifiedSchool: false });
    expect(clientCallsTo(queries.markEmailVerified)[0][1]).toEqual([USER_ID, TEST_SCHOOL]);
    expect(queries.markEmailVerified).toMatch(/is_verified = false AND is_archived = false/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 409 when the signup is not unverified', async () => {
    mockTransactionSequence([{ rows: [signupRow({ is_verified: true, is_verified_school: true })] }]);

    const res = await authenticatedRequest('post', url);

    expect(res.status).toBe(409);
    expect(res.body.data).toEqual({ state: 'approved' });
    expect(clientCallsTo(queries.markEmailVerified)).toHaveLength(0);
  });

  it("returns 404 for a user outside the admin's school", async () => {
    // selectUserForUpdate is pinned to the token's school, so a row from
    // another school simply isn't found.
    mockTransactionSequence([{ rows: [] }]);

    const res = await authenticatedRequest('post', url, mockAdminUser({ school: 'OTHERSCHOOL' }));

    expect(res.status).toBe(404);
    expect(clientCallsTo(queries.selectUserForUpdate)[0][1]).toEqual([USER_ID, 'OTHERSCHOOL']);
    expect(clientCallsTo(queries.markEmailVerified)).toHaveLength(0);
  });

  it('is admin-only', async () => {
    const res = await authenticatedRequest('post', url, mockTeacherUser());
    expect(res.status).toBe(403);
  });

  it('404s a malformed id before touching the database', async () => {
    const res = await authenticatedRequest('post', '/api/admin/approvals/not-a-uuid/verify-email');
    expect(res.status).toBe(404);
    expect(db.connect).not.toHaveBeenCalled();
  });
});
