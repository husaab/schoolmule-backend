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

  describe('choosing the view for a dual-role teacher', () => {
    // Query order: target, admin, active term, then the parent-link check.
    const mockTeacherWithChildren = () => {
      mockHappyPath(teacherRow());
      mockQueryResponse([{ '?column?': 1 }]); // hasActiveYearLinks
    };

    it('previews the parent portal when asked, keeping the preview read-only', async () => {
      mockTeacherWithChildren();
      const res = await post(TEST_TEACHER_USER_ID).send({ view: 'PARENT' });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('PARENT');
      expect(res.body.data.baseRole).toBe('TEACHER');
      expect(res.body.data.roles).toEqual(['TEACHER', 'PARENT']);

      const decoded = jwt.verify(res.body.data.token, JWT_SECRET);
      expect(decoded.role).toBe('PARENT');
      expect(decoded.baseRole).toBe('TEACHER');
      expect(decoded.roles).toEqual(['TEACHER', 'PARENT']);
      expect(decoded.impersonator.userId).toBe(TEST_ADMIN_USER_ID);
    });

    it('defaults to the database role and still reports every view held', async () => {
      mockTeacherWithChildren();
      const res = await post(TEST_TEACHER_USER_ID);
      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe('TEACHER');
      expect(res.body.data.roles).toEqual(['TEACHER', 'PARENT']);
      expect(jwt.verify(res.body.data.token, JWT_SECRET).roles).toEqual(['TEACHER', 'PARENT']);
    });

    it('refuses the parent view for a teacher with no linked children', async () => {
      mockHappyPath(teacherRow());
      mockQueryResponse([]); // no links
      const res = await post(TEST_TEACHER_USER_ID).send({ view: 'PARENT' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/parent view/i);
    });

    it('refuses a view that is not a portal', async () => {
      mockHappyPath(teacherRow());
      const res = await post(TEST_TEACHER_USER_ID).send({ view: 'ADMIN' });
      expect(res.status).toBe(400);
    });
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
    expect(res.body.message).toMatch(/teachers, parents and students/i);
  });

  describe('a student', () => {
    const studentRow = (overrides = {}) =>
      teacherRow({ role: 'STUDENT', first_name: 'Amal', last_name: 'Haddad', ...overrides });
    // services/classroom/studentLogin SIGN_IN_CONTEXT: classrooms on, linked
    // to the active year, consent on file, Grade 2.
    const signInContext = (overrides = {}) => ({
      enabled: true, login_from_grade: '1', qr_until_grade: '3', consent_at: new Date(),
      qr_secret_hash: null, qr_voided_at: null, student_id: '660e8400-e29b-41d4-a716-446655440020', grade: '2',
      ...overrides,
    });

    it('previews a student linked to the active year, keeping role STUDENT', async () => {
      mockQueryResponse([studentRow()]); // target in school
      mockQueryResponse([signInContext()]); // sign-in gate
      mockQueryResponse([adminRow]); // admin row
      mockQueryResponse([{ name: 'Term 1' }]); // active term
      const res = await post(TEST_TEACHER_USER_ID);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ role: 'STUDENT', baseRole: 'STUDENT', roles: ['STUDENT'] });
      const decoded = jwt.verify(res.body.data.token, JWT_SECRET);
      expect(decoded).toMatchObject({ role: 'STUDENT', baseRole: 'STUDENT' });
      expect(decoded.impersonator.userId).toBe(TEST_ADMIN_USER_ID);
      expect(decoded.exp - decoded.iat).toBe(2 * 60 * 60);
    });

    it("refuses a student with no link to this school year (409)", async () => {
      mockQueryResponse([studentRow()]);
      mockQueryResponse([signInContext({ student_id: null, grade: null })]);
      const res = await post(TEST_TEACHER_USER_ID);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'NO_STUDENT_LINK', message: "This student account isn't linked to this school year.",
      });
    });

    it('refuses a student who could not sign in (classrooms off) with a reason for the admin', async () => {
      mockQueryResponse([studentRow()]);
      mockQueryResponse([signInContext({ enabled: false })]);
      const res = await post(TEST_TEACHER_USER_ID);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CLASSROOM_DISABLED');
      expect(res.body.message).toMatch(/turned off for your school/);
    });

    it('refuses the parent view for a student', async () => {
      mockQueryResponse([studentRow()]);
      mockQueryResponse([signInContext()]);
      mockQueryResponse([adminRow]);
      mockQueryResponse([{ name: 'Term 1' }]);
      const res = await post(TEST_TEACHER_USER_ID).send({ view: 'PARENT' });
      expect(res.status).toBe(400);
    });
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
