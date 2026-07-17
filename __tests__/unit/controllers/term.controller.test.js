jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildTermRow } = require('../../helpers/factories');
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

describe('Term Controller', () => {
  // ── getTermsBySchool ──────────────────────────────────────────────
  describe('GET /api/terms?school=', () => {
    it('should return 200 with terms', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].termId).toBe(row.term_id);
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authGet('/api/terms');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getTermsBySchoolId ──────────────────────────────────────────────
  describe('GET /api/terms/school-id/:schoolId', () => {
    it('should return 200 with terms', async () => {
      const schoolId = uuidv4();
      const row = buildTermRow({ school_id: schoolId });
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms/school-id/${schoolId}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms/school-id/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getTermByNameAndSchool ──────────────────────────────────────────────
  describe('GET /api/terms/by-name', () => {
    it('should return 200 with the term', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms/by-name?termName=Term%201%202025-2026&school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.termId).toBe(row.term_id);
    });

    it('should return 400 when termName or school is missing', async () => {
      const res = await authGet(`/api/terms/by-name?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when term not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/terms/by-name?termName=Nonexistent&school=${TEST_SCHOOL}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms/by-name?termName=Term%201&school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getActiveTermBySchool ──────────────────────────────────────────────
  describe('GET /api/terms/active', () => {
    it('should return 200 with the active term', async () => {
      const row = buildTermRow({ is_active: true });
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms/active?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.isActive).toBe(true);
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildTermRow({ is_active: true });
      mockQueryResponse([row]);
      const res = await authGet('/api/terms/active');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when no active term', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/terms/active?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms/active?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getCurrentTermBySchool ──────────────────────────────────────────────
  describe('GET /api/terms/current', () => {
    it('should return 200 with current term', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms/current?school=${TEST_SCHOOL}&date=2025-10-15`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authGet('/api/terms/current?date=2025-10-15');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when no current term found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/terms/current?school=${TEST_SCHOOL}&date=2020-01-01`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms/current?school=${TEST_SCHOOL}&date=2025-10-15`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getTermsByAcademicYear ──────────────────────────────────────────────
  describe('GET /api/terms/academic-year', () => {
    it('should return 200 with terms for the year', async () => {
      const row = buildTermRow({ academic_year: '2025-2026' });
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms/academic-year?school=${TEST_SCHOOL}&year=2025-2026`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildTermRow({ academic_year: '2025-2026' });
      mockQueryResponse([row]);
      const res = await authGet('/api/terms/academic-year?year=2025-2026');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when year is missing', async () => {
      const res = await authGet(`/api/terms/academic-year?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms/academic-year?school=${TEST_SCHOOL}&year=2025-2026`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getTermById ──────────────────────────────────────────────
  describe('GET /api/terms/:id', () => {
    it('should return 200 with the term', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/terms/${row.term_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.termId).toBe(row.term_id);
    });

    it('should return 404 when term not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/terms/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/terms/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createTerm ──────────────────────────────────────────────
  describe('POST /api/terms', () => {
    it('should return 201 on successful creation', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authPost('/api/terms').send({
        schoolId: row.school_id,
        name: 'Term 1 2025-2026',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
        isActive: false,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
    });

    it('should deactivate other terms when isActive is true', async () => {
      const row = buildTermRow({ is_active: true });
      // deactivateAllTermsForSchool
      mockQueryResponse([]);
      // insertTerm
      mockQueryResponse([row]);
      const res = await authPost('/api/terms').send({
        schoolId: row.school_id,
        name: 'Term 1 2025-2026',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
        isActive: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
    });

    it('uses the JWT school even without a school field in the body', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authPost('/api/terms').send({
        schoolId: row.school_id,
        name: 'Term 1 2025-2026',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when name is missing', async () => {
      const res = await authPost('/api/terms').send({
        school: TEST_SCHOOL,
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when dates are missing', async () => {
      const res = await authPost('/api/terms').send({
        school: TEST_SCHOOL,
        name: 'Term 1',
        academicYear: '2025-2026',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when academicYear is missing', async () => {
      const res = await authPost('/api/terms').send({
        school: TEST_SCHOOL,
        name: 'Term 1',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const res = await authPost('/api/terms').send({
        school: TEST_SCHOOL,
        name: 'Term 1',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateTerm ──────────────────────────────────────────────
  describe('PUT /api/terms/:id', () => {
    it('should return 200 on successful update', async () => {
      const row = buildTermRow({ name: 'Updated Term' });
      mockQueryResponse([row]);
      const res = await authPut(`/api/terms/${row.term_id}`).send({
        name: 'Updated Term',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
        isActive: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should deactivate others and update when setting active', async () => {
      const row = buildTermRow({ is_active: true });
      // selectTermById (to get school)
      mockQueryResponse([row]);
      // deactivateAllTermsForSchool
      mockQueryResponse([]);
      // updateTerm
      mockQueryResponse([row]);
      const res = await authPut(`/api/terms/${row.term_id}`).send({
        name: 'Active Term',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
        isActive: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when name is missing', async () => {
      const res = await authPut(`/api/terms/${uuidv4()}`).send({
        startDate: '2025-09-01',
        endDate: '2025-12-20',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when term not found', async () => {
      mockQueryResponse([]);
      const res = await authPut(`/api/terms/${uuidv4()}`).send({
        name: 'Test Term',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPut(`/api/terms/${uuidv4()}`).send({
        name: 'Term',
        startDate: '2025-09-01',
        endDate: '2025-12-20',
        academicYear: '2025-2026',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── activateTerm ──────────────────────────────────────────────
  describe('PUT /api/terms/:id/activate', () => {
    it('should return 200 on successful activation', async () => {
      const row = buildTermRow({ is_active: true });
      // selectTermById
      mockQueryResponse([row]);
      // deactivateAllTermsForSchool
      mockQueryResponse([]);
      // setTermActive
      mockQueryResponse([row]);
      const res = await authPut(`/api/terms/${row.term_id}/activate`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when term not found', async () => {
      mockQueryResponse([]);
      const res = await authPut(`/api/terms/${uuidv4()}/activate`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('activate failed');
      const res = await authPut(`/api/terms/${uuidv4()}/activate`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateTermStatus ──────────────────────────────────────────────
  describe('PUT /api/terms/:id/status', () => {
    it('should return 200 when activating', async () => {
      const row = buildTermRow({ is_active: true });
      // selectTermById
      mockQueryResponse([row]);
      // deactivateAllTermsForSchool
      mockQueryResponse([]);
      // setTermActive
      mockQueryResponse([row]);
      const res = await authPut(`/api/terms/${row.term_id}/status`).send({ isActive: true });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 200 when deactivating', async () => {
      const row = buildTermRow({ is_active: false });
      // selectTermById
      mockQueryResponse([row]);
      // setTermInactive
      mockQueryResponse([row]);
      const res = await authPut(`/api/terms/${row.term_id}/status`).send({ isActive: false });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when isActive is not boolean', async () => {
      const res = await authPut(`/api/terms/${uuidv4()}/status`).send({ isActive: 'yes' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when term not found', async () => {
      mockQueryResponse([]);
      const res = await authPut(`/api/terms/${uuidv4()}/status`).send({ isActive: true });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('status failed');
      const res = await authPut(`/api/terms/${uuidv4()}/status`).send({ isActive: true });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteTerm ──────────────────────────────────────────────
  describe('DELETE /api/terms/:id', () => {
    it('should return 200 on successful deletion', async () => {
      const row = buildTermRow();
      mockQueryResponse([row]);
      const res = await authDelete(`/api/terms/${row.term_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 404 when term not found', async () => {
      mockQueryResponse([]);
      const res = await authDelete(`/api/terms/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/terms/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
