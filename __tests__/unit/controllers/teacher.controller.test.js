jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL, TEST_TEACHER_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');
const { v4: uuidv4 } = require('uuid');

const app = getApp();

function authGet(url) {
  const token = mockAdminUser();
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}

describe('Teacher Controller', () => {
  // ── getTeachersBySchool ──────────────────────────────────────────────
  describe('GET /api/teachers', () => {
    it('should return 200 with teachers for the school', async () => {
      const row = buildUserRow({
        user_id: TEST_TEACHER_USER_ID,
        role: 'TEACHER',
        first_name: 'Teacher',
        last_name: 'User',
        email: 'teacher@test.com',
        school: TEST_SCHOOL,
      });
      mockQueryResponse([row]);
      const res = await authGet(`/api/teachers?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userId).toBe(TEST_TEACHER_USER_ID);
      expect(res.body.data[0].fullName).toBe('Teacher User');
      expect(res.body.data[0].email).toBe('teacher@test.com');
    });

    it('should return 200 with empty array when no teachers', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/teachers?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildUserRow({
        user_id: TEST_TEACHER_USER_ID,
        role: 'TEACHER',
        first_name: 'Teacher',
        last_name: 'User',
        email: 'teacher@test.com',
        school: TEST_SCHOOL,
      });
      mockQueryResponse([row]);
      const res = await authGet('/api/teachers');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/teachers?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getTeacherById ──────────────────────────────────────────────
  describe('GET /api/teachers/:id', () => {
    it('should return 200 with teacher data', async () => {
      const row = buildUserRow({
        user_id: TEST_TEACHER_USER_ID,
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane.doe@test.com',
      });
      mockQueryResponse([row]);
      const res = await authGet(`/api/teachers/${TEST_TEACHER_USER_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.userId).toBe(TEST_TEACHER_USER_ID);
      expect(res.body.data.fullName).toBe('Jane Doe');
      expect(res.body.data.email).toBe('jane.doe@test.com');
    });

    it('should return 404 when teacher not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/teachers/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/teachers/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
