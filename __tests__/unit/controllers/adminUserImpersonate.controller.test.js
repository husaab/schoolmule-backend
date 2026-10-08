jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { getApp } = require('../../helpers/testApp');
const {
  JWT_SECRET,
  mockAdminUser,
  mockTeacherUser,
  generateTestToken,
  TEST_ADMIN_USER_ID,
  TEST_TEACHER_USER_ID,
  TEST_SCHOOL,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');

const app = getApp();

const adminRow = buildUserRow({
  user_id: TEST_ADMIN_USER_ID,
  role: 'ADMIN',
  first_name: 'Amira',
  last_name: 'Admin',
  username: 'amira',
});

const teacherRow = (overrides = {}) =>
  buildUserRow({
    user_id: TEST_TEACHER_USER_ID,
    role: 'TEACHER',
    first_name: 'Tariq',
    last_name: 'Teacher',
    is_archived: false,
    ...overrides,
  });

// Query order inside impersonateUser: target lookup, then (in parallel) admin
// lookup and active term. Every `school_years` lookup (resolveSchoolYear and
// the session's year list) is answered by the db mock without consuming a slot.
const mockHappyPath = (target) => {
  mockQueryResponse([target]); // target in school
  mockQueryResponse([adminRow]); // admin row
  mockQueryResponse([{ name: 'Term 1' }]); // active term
};

const post = (id, token = mockAdminUser()) =>
  request(app).post(`/api/admin/users/${id}/impersonate`).set('Authorization', `Bearer ${token}`);

describe('POST /api/admin/users/:id/impersonate', () => {
  it('issues a read-only preview token for a teacher in the school', async () => {
    mockHappyPath(teacherRow());
    const res = await post(TEST_TEACHER_USER_ID);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.userId).toBe(TEST_TEACHER_USER_ID);
    expect(res.body.data.role).toBe('TEACHER');
    expect(res.body.data.fullName).toBe('Tariq Teacher');
    expect(res.body.data.impersonator).toEqual({
      userId: TEST_ADMIN_USER_ID,
      username: 'amira',
      fullName: 'Amira Admin',
    });

    const decoded = jwt.verify(res.body.data.token, JWT_SECRET);
    expect(decoded.userId).toBe(TEST_TEACHER_USER_ID);
    expect(decoded.role).toBe('TEACHER');
    expect(decoded.school).toBe(TEST_SCHOOL);
    expect(decoded.impersonator.userId).toBe(TEST_ADMIN_USER_ID);
    // 2h TTL
    expect(decoded.exp - decoded.iat).toBe(2 * 60 * 60);
  });

  it('issues a preview token for a parent', async () => {
    const parent = teacherRow({ role: 'PARENT', first_name: 'Pia', last_name: 'Parent' });
    mockHappyPath(parent);
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('PARENT');
  });

  it('still works for an invited user who has not set a password yet', async () => {
    mockHappyPath(teacherRow({ password: '!' }));
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(200);
  });

  it('refuses non-admins', async () => {
    const res = await post(TEST_ADMIN_USER_ID, mockTeacherUser());
    expect(res.status).toBe(403);
  });

  it('refuses previewing yourself', async () => {
    const res = await post(TEST_ADMIN_USER_ID);
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user is not in the admin school', async () => {
    mockQueryResponse([]); // no target row
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(404);
  });

  it('refuses previewing another admin', async () => {
    mockQueryResponse([teacherRow({ role: 'ADMIN' })]);
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/teachers and parents/i);
  });

  it('refuses archived users', async () => {
    mockQueryResponse([teacherRow({ is_archived: true })]);
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/archived/i);
  });

  it('refuses users without school access', async () => {
    mockQueryResponse([teacherRow({ is_verified_school: false })]);
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(409);
  });

  it('refuses starting a preview from inside a preview (and any write with a preview token)', async () => {
    const previewToken = generateTestToken({
      userId: TEST_TEACHER_USER_ID,
      role: 'TEACHER',
      impersonator: { userId: TEST_ADMIN_USER_ID, username: 'amira', fullName: 'Amira Admin' },
    });
    const res = await post(TEST_TEACHER_USER_ID, previewToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IMPERSONATION_READ_ONLY');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB down');
    const res = await post(TEST_TEACHER_USER_ID);
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
