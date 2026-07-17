jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL, TEST_PARENT_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');
const { v4: uuidv4 } = require('uuid');

const app = getApp();

function authGet(url) {
  const token = mockAdminUser();
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}

describe('Parent Controller', () => {
  // ── getAllParents ──────────────────────────────────────────────
  describe('GET /api/parents', () => {
    it('should return 200 with parents for the school', async () => {
      const row = buildUserRow({
        user_id: TEST_PARENT_USER_ID,
        role: 'PARENT',
        first_name: 'Parent',
        last_name: 'User',
        email: 'parent@test.com',
        school: TEST_SCHOOL,
      });
      mockQueryResponse([row]);
      const res = await authGet(`/api/parents?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].userId).toBe(TEST_PARENT_USER_ID);
      expect(res.body.data[0].firstName).toBe('Parent');
      expect(res.body.data[0].lastName).toBe('User');
      expect(res.body.data[0].email).toBe('parent@test.com');
    });

    it('should return 200 with empty array when no parents', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/parents?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildUserRow({
        user_id: TEST_PARENT_USER_ID,
        role: 'PARENT',
        first_name: 'Parent',
        last_name: 'User',
        email: 'parent@test.com',
        school: TEST_SCHOOL,
      });
      mockQueryResponse([row]);
      const res = await authGet('/api/parents');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/parents?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getParentById ──────────────────────────────────────────────
  describe('GET /api/parents/:id', () => {
    it('should return 200 with parent data', async () => {
      const row = buildUserRow({
        user_id: TEST_PARENT_USER_ID,
        first_name: 'Parent',
        last_name: 'User',
        email: 'parent@test.com',
        school: TEST_SCHOOL,
      });
      mockQueryResponse([row]);
      const res = await authGet(`/api/parents/${TEST_PARENT_USER_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.userId).toBe(TEST_PARENT_USER_ID);
      expect(res.body.data.firstName).toBe('Parent');
      expect(res.body.data.email).toBe('parent@test.com');
    });

    it('should return 404 when parent not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/parents/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/parents/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
