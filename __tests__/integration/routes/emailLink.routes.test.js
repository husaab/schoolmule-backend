// One-tap sign-in from a parent email (utils/emailLoginLink): the token's
// parent, child and address must all still hold. Synthetic people only.
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { signEmailLoginToken } = require('../../../utils/emailLoginLink');

const PARENT_ID = '660e8400-e29b-41d4-a716-446655440001';
const OTHER_PARENT_ID = '660e8400-e29b-41d4-a716-446655440002';
const TEACHER_ID = '660e8400-e29b-41d4-a716-446655440003';

describe('Integration: POST /api/auth/email-link', () => {
  let app;
  let pool;
  let studentId;

  const user = (id, email, role, { archived = false } = {}) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
     VALUES ($1, $2, $3, 'x', 'Test', 'Person', 'ALHAADIACADEMY', $4, TRUE, TRUE, $5)`,
    [id, email, email.split('@')[0], role, archived],
  );
  const link = (parentId) => pool.query(
    `INSERT INTO parent_students (student_id, parent_id, parent_email, school) VALUES ($1, $2, 'x@example.test', 'ALHAADIACADEMY')`,
    [studentId, parentId],
  );
  const post = (token) => request(app).post('/api/auth/email-link').send({ token });

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school) VALUES ('Child Test', '5', 'ALHAADIACADEMY') RETURNING student_id`,
    );
    studentId = rows[0].student_id;
  });

  it("signs a linked parent in, with the same response as a password sign-in", async () => {
    await user(PARENT_ID, 'Sam.Parent@example.test', 'PARENT');
    await link(PARENT_ID);
    const res = await post(signEmailLoginToken({ userId: PARENT_ID, studentId, email: 'sam.parent@example.test' }));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: PARENT_ID, role: 'PARENT' });
    expect(res.body.data.token).toEqual(expect.any(String));
  });

  it('refuses a parent no longer linked to the child, or whose email changed', async () => {
    await user(PARENT_ID, 'sam.parent@example.test', 'PARENT');
    const unlinked = await post(signEmailLoginToken({ userId: PARENT_ID, studentId, email: 'sam.parent@example.test' }));
    expect(unlinked.status).toBe(401);
    expect(unlinked.body.code).toBe('EMAIL_LINK_INVALID');

    await link(PARENT_ID);
    const moved = await post(signEmailLoginToken({ userId: PARENT_ID, studentId, email: 'old.address@example.test' }));
    expect(moved.status).toBe(401);
  });

  it('never signs a staff account in, even one linked as a parent', async () => {
    await user(TEACHER_ID, 'teacher.parent@example.test', 'TEACHER');
    await link(TEACHER_ID);
    const res = await post(signEmailLoginToken({ userId: TEACHER_ID, studentId, email: 'teacher.parent@example.test' }));
    expect(res.status).toBe(401);
  });

  it('refuses an archived parent, and a token that is not an email link', async () => {
    await user(OTHER_PARENT_ID, 'archived.parent@example.test', 'PARENT', { archived: true });
    await link(OTHER_PARENT_ID);
    const archived = await post(signEmailLoginToken({ userId: OTHER_PARENT_ID, studentId, email: 'archived.parent@example.test' }));
    expect(archived.status).toBe(403);

    expect((await post('not-a-token')).status).toBe(401);
    expect((await post(undefined)).status).toBe(401);
  });
});
