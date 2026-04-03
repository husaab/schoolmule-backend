jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError, mockPgError } = require('../../helpers/mockDb');
const { buildSchoolRow } = require('../../helpers/factories');
const { v4: uuidv4 } = require('uuid');

const app = getApp();

function authGet(url) {
  const token = mockAdminUser();
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}
function authPost(url) {
  const token = mockAdminUser();
  return request(app).post(url).set('Authorization', `Bearer ${token}`);
}
function authPut(url) {
  const token = mockAdminUser();
  return request(app).put(url).set('Authorization', `Bearer ${token}`);
}
function authDelete(url) {
  const token = mockAdminUser();
  return request(app).delete(url).set('Authorization', `Bearer ${token}`);
}

describe('School Controller', () => {
  // ── getAllSchools ──────────────────────────────────────────────
  describe('GET /api/schools', () => {
    it('should return 200 with all schools', async () => {
      const row = buildSchoolRow();
      mockQueryResponse([row]);
      const res = await authGet('/api/schools');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].schoolId).toBe(row.school_id);
      expect(res.body.data[0].schoolCode).toBe(row.school_code);
    });

    it('should return 200 with empty array when no schools', async () => {
      mockQueryResponse([]);
      const res = await authGet('/api/schools');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet('/api/schools');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getSchoolByCode ──────────────────────────────────────────────
  describe('GET /api/schools/:code', () => {
    it('should return 200 with school data', async () => {
      const row = buildSchoolRow({ school_code: TEST_SCHOOL });
      mockQueryResponse([row]);
      const res = await authGet(`/api/schools/${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.schoolCode).toBe(TEST_SCHOOL);
    });

    it('should return 404 when school not found', async () => {
      mockQueryResponse([]);
      const res = await authGet('/api/schools/NONEXISTENT');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/schools/${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getSchoolById ──────────────────────────────────────────────
  describe('GET /api/schools/id/:id', () => {
    it('should return 200 with school data', async () => {
      const row = buildSchoolRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/schools/id/${row.school_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.schoolId).toBe(row.school_id);
    });

    it('should return 404 when school not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/schools/id/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/schools/id/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createSchool ──────────────────────────────────────────────
  describe('POST /api/schools', () => {
    it('should return 201 on successful creation', async () => {
      const row = buildSchoolRow({ school_code: 'NEWSCHOOL', name: 'New School' });
      mockQueryResponse([row]);
      const res = await authPost('/api/schools').send({
        schoolCode: 'NEWSCHOOL',
        name: 'New School',
        address: '456 School Ave',
        phone: '555-1234',
        email: 'info@newschool.com',
        timezone: 'America/Toronto',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.schoolCode).toBe('NEWSCHOOL');
    });

    it('should return 400 when schoolCode is missing', async () => {
      const res = await authPost('/api/schools').send({ name: 'Test' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/school code/i);
    });

    it('should return 400 when name is missing', async () => {
      const res = await authPost('/api/schools').send({ schoolCode: 'TEST' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/name/i);
    });

    it('should return 409 on duplicate school code', async () => {
      mockPgError('23505', 'unique constraint violation');
      const res = await authPost('/api/schools').send({
        schoolCode: TEST_SCHOOL,
        name: 'Duplicate School',
      });
      expect(res.status).toBe(409);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/already exists/i);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const res = await authPost('/api/schools').send({
        schoolCode: 'NEWSCHOOL',
        name: 'New School',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateSchool ──────────────────────────────────────────────
  describe('PUT /api/schools/:id', () => {
    it('should return 200 on successful update', async () => {
      const row = buildSchoolRow({ name: 'Updated School' });
      mockQueryResponse([row]);
      const res = await authPut(`/api/schools/${row.school_id}`).send({
        name: 'Updated School',
        address: '789 Updated Ave',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('Updated School');
    });

    it('should return 400 when name is missing', async () => {
      const res = await authPut(`/api/schools/${uuidv4()}`).send({
        address: '789 Updated Ave',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when school not found', async () => {
      mockQueryResponse([]);
      const res = await authPut(`/api/schools/${uuidv4()}`).send({
        name: 'Test School',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPut(`/api/schools/${uuidv4()}`).send({
        name: 'Test School',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteSchool ──────────────────────────────────────────────
  describe('DELETE /api/schools/:id', () => {
    it('should return 200 on successful deletion', async () => {
      const row = buildSchoolRow();
      mockQueryResponse([row]);
      const res = await authDelete(`/api/schools/${row.school_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 404 when school not found', async () => {
      mockQueryResponse([]);
      const res = await authDelete(`/api/schools/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/schools/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
