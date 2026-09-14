jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_ADMIN_USER_ID, TEST_TEACHER_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError, mockTransactionSequence, mockTransactionError } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');

const app = getApp();

function authGet(url) {
  const token = mockAdminUser();
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}
function authPut(url) {
  const token = mockAdminUser();
  return request(app).put(url).set('Authorization', `Bearer ${token}`);
}
function authDelete(url) {
  const token = mockAdminUser();
  return request(app).delete(url).set('Authorization', `Bearer ${token}`);
}

describe('User Controller', () => {
  // ── getAllUser ──────────────────────────────────────────────
  describe('GET /api/users', () => {
    it('should return 200 with all users', async () => {
      const row = buildUserRow();
      mockQueryResponse([row]);
      const res = await authGet('/api/users');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userId).toBe(row.user_id);
      expect(res.body.data[0].email).toBe(row.email);
      expect(res.body.data[0]).not.toHaveProperty('emailToken');
    });

    it('should return 403 for non-admins', async () => {
      const res = await request(app).get('/api/users').set('Authorization', `Bearer ${mockTeacherUser()}`);
      expect(res.status).toBe(403);
    });

    it('should return 200 with empty array when no users', async () => {
      mockQueryResponse([]);
      const res = await authGet('/api/users');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet('/api/users');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getUsersBySchool ──────────────────────────────────────────────
  describe('GET /api/users/school/:school', () => {
    it('should return 200 with users for the school', async () => {
      const row = buildUserRow({ school: TEST_SCHOOL });
      mockQueryResponse([row]);
      const res = await authGet(`/api/users/school/${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].school).toBe(TEST_SCHOOL);
    });

    it('should return 403 for another school', async () => {
      const res = await authGet('/api/users/school/PLAYGROUND');
      expect(res.status).toBe(403);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/users/school/${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getUserByEmail ──────────────────────────────────────────────
  describe('GET /api/users/email/:email', () => {
    it('should return 200 with user data', async () => {
      const row = buildUserRow({ email: 'found@test.com' });
      mockQueryResponse([row]);
      const res = await authGet('/api/users/email/found@test.com');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.email).toBe('found@test.com');
    });

    it('should return 404 when user not found', async () => {
      mockQueryResponse([]);
      const res = await authGet('/api/users/email/notfound@test.com');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet('/api/users/email/error@test.com');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getUser ──────────────────────────────────────────────
  describe('GET /api/users/:id', () => {
    it('should return 200 with user data', async () => {
      const row = buildUserRow({ user_id: TEST_ADMIN_USER_ID });
      mockQueryResponse([row]);
      const res = await authGet(`/api/users/${TEST_ADMIN_USER_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.userId).toBe(TEST_ADMIN_USER_ID);
    });

    it('should return 404 when user not found', async () => {
      mockQueryResponse([]);
      const res = await authGet('/api/users/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet('/api/users/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteUser ──────────────────────────────────────────────
  describe('DELETE /api/users/:id', () => {
    it('should return 200 on successful deletion', async () => {
      mockQueryResponse([buildUserRow({ user_id: '00000000-0000-0000-0000-000000000001' })]);
      mockQueryResponse([], 1);
      const res = await authDelete('/api/users/00000000-0000-0000-0000-000000000001');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 403 when the user belongs to another school', async () => {
      mockQueryResponse([buildUserRow({ school: 'PLAYGROUND' })]);
      const res = await authDelete('/api/users/00000000-0000-0000-0000-000000000001');
      expect(res.status).toBe(403);
    });

    it('should return 403 for non-admins', async () => {
      mockQueryResponse([buildUserRow()]);
      const res = await request(app)
        .delete('/api/users/00000000-0000-0000-0000-000000000001')
        .set('Authorization', `Bearer ${mockTeacherUser()}`);
      expect(res.status).toBe(403);
    });

    it('should return 404 when user not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete('/api/users/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete('/api/users/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateUser ──────────────────────────────────────────────
  describe('PUT /api/users/:id', () => {
    it('should return 200 on successful update', async () => {
      mockQueryResponse([buildUserRow({ user_id: '00000000-0000-0000-0000-000000000001' })]);
      mockQueryResponse([], 1);
      const res = await authPut('/api/users/00000000-0000-0000-0000-000000000001').send({
        email: 'updated@test.com',
        username: 'Updated User',
        school: TEST_SCHOOL,
        role: 'TEACHER',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await authPut('/api/users/00000000-0000-0000-0000-000000000001').send({
        email: 'test@test.com',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when user not found', async () => {
      mockQueryResponse([], 0);
      const res = await authPut('/api/users/00000000-0000-0000-0000-000000000099').send({
        email: 'test@test.com',
        username: 'Test',
        school: TEST_SCHOOL,
        role: 'TEACHER',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 403 when a non-admin changes their own role', async () => {
      mockQueryResponse([buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'TEACHER' })]);
      const res = await request(app)
        .put(`/api/users/${TEST_TEACHER_USER_ID}`)
        .set('Authorization', `Bearer ${mockTeacherUser()}`)
        .send({ email: 'user@test.com', username: 'Test User', school: TEST_SCHOOL, role: 'ADMIN' });
      expect(res.status).toBe(403);
    });

    it('should let a non-admin update their own username', async () => {
      mockQueryResponse([buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'TEACHER' })]);
      mockQueryResponse([], 1);
      const res = await request(app)
        .put(`/api/users/${TEST_TEACHER_USER_ID}`)
        .set('Authorization', `Bearer ${mockTeacherUser()}`)
        .send({ email: 'user@test.com', username: 'New Name', school: TEST_SCHOOL, role: 'TEACHER' });
      expect(res.status).toBe(200);
    });

    it('should return 403 when a non-admin edits someone else', async () => {
      mockQueryResponse([buildUserRow()]);
      const res = await request(app)
        .put('/api/users/00000000-0000-0000-0000-000000000001')
        .set('Authorization', `Bearer ${mockTeacherUser()}`)
        .send({ email: 'user@test.com', username: 'Test User', school: TEST_SCHOOL, role: 'TEACHER' });
      expect(res.status).toBe(403);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPut('/api/users/00000000-0000-0000-0000-000000000001').send({
        email: 'test@test.com',
        username: 'Test User',
        school: TEST_SCHOOL,
        role: 'TEACHER',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updatePassword ──────────────────────────────────────────────
  describe('PUT /api/users/:id/password', () => {
    it('should return 200 on successful password change', async () => {
      const bcrypt = require('bcrypt');
      const hashedOld = await bcrypt.hash('OldPassword1!', 10);

      // Transaction: BEGIN, SELECT password, UPDATE, COMMIT
      mockTransactionSequence([
        { rows: [{ password: hashedOld }] },
        { rows: [] },
      ]);

      const res = await authPut(`/api/users/${TEST_ADMIN_USER_ID}/password`).send({
        oldPassword: 'OldPassword1!',
        newPassword: 'NewPassword1!',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 403 when changing someone else\'s password', async () => {
      const res = await authPut('/api/users/00000000-0000-0000-0000-000000000099/password').send({
        oldPassword: 'OldPassword1!',
        newPassword: 'NewPassword1!',
      });
      expect(res.status).toBe(403);
    });

    it('should return 404 when user not found', async () => {
      // Transaction: BEGIN, SELECT password returns empty
      mockTransactionSequence([
        { rows: [] },
      ]);
      const res = await authPut(`/api/users/${TEST_ADMIN_USER_ID}/password`).send({
        oldPassword: 'OldPassword1!',
        newPassword: 'NewPassword1!',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 401 when old password is incorrect', async () => {
      const bcrypt = require('bcrypt');
      const hashedOld = await bcrypt.hash('CorrectPassword1!', 10);

      mockTransactionSequence([
        { rows: [{ password: hashedOld }] },
      ]);

      const res = await authPut(`/api/users/${TEST_ADMIN_USER_ID}/password`).send({
        oldPassword: 'WrongPassword1!',
        newPassword: 'NewPassword1!',
      });
      expect(res.status).toBe(401);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockTransactionError(0, 'DB error');
      const res = await authPut(`/api/users/${TEST_ADMIN_USER_ID}/password`).send({
        oldPassword: 'OldPassword1!',
        newPassword: 'NewPassword1!',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
