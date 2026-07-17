jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_ADMIN_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildStudentRow, buildCreateStudentBody } = require('../../helpers/factories');

const app = getApp();

function authGet(url) {
  const token = mockAdminUser();
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}
function authPost(url) {
  const token = mockAdminUser();
  return request(app).post(url).set('Authorization', `Bearer ${token}`);
}
function authPatch(url) {
  const token = mockAdminUser();
  return request(app).patch(url).set('Authorization', `Bearer ${token}`);
}
function authDelete(url) {
  const token = mockAdminUser();
  return request(app).delete(url).set('Authorization', `Bearer ${token}`);
}

describe('Student Controller', () => {
  // ── getAllStudents ──────────────────────────────────────────────
  describe('GET /api/students', () => {
    it('should return 200 with students', async () => {
      const row = buildStudentRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/students?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].studentId).toBe(row.student_id);
    });

    it('should return 200 with empty array when no students', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/students?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildStudentRow();
      mockQueryResponse([row]);
      const res = await authGet('/api/students');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB connection lost');
      const res = await authGet(`/api/students?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getStudentById ──────────────────────────────────────────────
  describe('GET /api/students/:id', () => {
    it('should return 200 with the student', async () => {
      const row = buildStudentRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/students/${row.student_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(row.student_id);
      expect(res.body.data.mother.name).toBe(row.mother_name);
    });

    it('should return 404 when student not found', async () => {
      mockQueryResponse([]);
      const res = await authGet('/api/students/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('timeout');
      const res = await authGet('/api/students/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createStudent ──────────────────────────────────────────────
  describe('POST /api/students', () => {
    it('should return 201 on successful creation', async () => {
      const row = buildStudentRow();
      mockQueryResponse([row]);
      const body = buildCreateStudentBody();
      const res = await authPost('/api/students').send(body);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(row.student_id);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await authPost('/api/students').send({});
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/name/i);
    });

    it('should return 400 when name is missing', async () => {
      const body = buildCreateStudentBody({ name: undefined });
      delete body.name;
      const res = await authPost('/api/students').send(body);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const body = buildCreateStudentBody();
      const res = await authPost('/api/students').send(body);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateStudent ──────────────────────────────────────────────
  describe('PATCH /api/students/:id', () => {
    it('should return 200 on successful update', async () => {
      const row = buildStudentRow({ name: 'Updated Name' });
      mockQueryResponse([row], 1);
      const res = await authPatch(`/api/students/${row.student_id}`).send({
        name: 'Updated Name',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('Updated Name');
    });

    it('should return 404 when student not found', async () => {
      mockQueryResponse([], 0);
      const res = await authPatch('/api/students/00000000-0000-0000-0000-000000000099').send({
        name: 'Updated',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPatch('/api/students/00000000-0000-0000-0000-000000000099').send({
        name: 'Updated',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteStudent ──────────────────────────────────────────────
  describe('DELETE /api/students/:id', () => {
    it('should return 200 on successful deletion', async () => {
      mockQueryResponse([], 1);
      const res = await authDelete('/api/students/00000000-0000-0000-0000-000000000001');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 404 when student not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete('/api/students/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete('/api/students/00000000-0000-0000-0000-000000000099');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getArchivedStudents ──────────────────────────────────────────────
  describe('GET /api/students/archived', () => {
    it('should return 200 with archived students', async () => {
      const row = buildStudentRow({ is_archived: true, archived_at: new Date().toISOString() });
      mockQueryResponse([row]);
      const res = await authGet(`/api/students/archived?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].isArchived).toBe(true);
    });

    it('uses the JWT school even without a query param', async () => {
      const row = buildStudentRow({ is_archived: true, archived_at: new Date().toISOString() });
      mockQueryResponse([row]);
      const res = await authGet('/api/students/archived');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('db error');
      const res = await authGet(`/api/students/archived?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── archiveStudent ──────────────────────────────────────────────
  describe('POST /api/students/:id/archive', () => {
    it('should return 200 on successful archive', async () => {
      const row = buildStudentRow({ is_archived: false });
      const archivedRow = buildStudentRow({
        student_id: row.student_id,
        is_archived: true,
        archived_at: new Date().toISOString(),
        archived_by: TEST_ADMIN_USER_ID,
      });
      // First query: check student exists
      mockQueryResponse([row]);
      // Second query: archive the student
      mockQueryResponse([archivedRow]);
      const res = await authPost(`/api/students/${row.student_id}/archive`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/archived/i);
    });

    it('should return 404 when student not found', async () => {
      mockQueryResponse([]);
      const res = await authPost('/api/students/00000000-0000-0000-0000-000000000099/archive');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when student is already archived', async () => {
      const row = buildStudentRow({ is_archived: true });
      mockQueryResponse([row]);
      const res = await authPost(`/api/students/${row.student_id}/archive`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/already archived/i);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('archive failed');
      const res = await authPost('/api/students/00000000-0000-0000-0000-000000000099/archive');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── unarchiveStudent ──────────────────────────────────────────────
  describe('POST /api/students/:id/unarchive', () => {
    it('should return 200 on successful unarchive', async () => {
      const row = buildStudentRow({ is_archived: true });
      const unarchivedRow = buildStudentRow({
        student_id: row.student_id,
        is_archived: false,
        archived_at: null,
        archived_by: null,
      });
      mockQueryResponse([row]);
      mockQueryResponse([unarchivedRow]);
      const res = await authPost(`/api/students/${row.student_id}/unarchive`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/unarchived/i);
    });

    it('should return 404 when student not found', async () => {
      mockQueryResponse([]);
      const res = await authPost('/api/students/00000000-0000-0000-0000-000000000099/unarchive');
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when student is not archived', async () => {
      const row = buildStudentRow({ is_archived: false });
      mockQueryResponse([row]);
      const res = await authPost(`/api/students/${row.student_id}/unarchive`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/not archived/i);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('unarchive failed');
      const res = await authPost('/api/students/00000000-0000-0000-0000-000000000099/unarchive');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getAllStudentsWithArchived ──────────────────────────────────────────────
  describe('GET /api/students/all', () => {
    it('should return 200 with all students including archived', async () => {
      const active = buildStudentRow({ is_archived: false });
      const archived = buildStudentRow({ is_archived: true });
      mockQueryResponse([active, archived]);
      const res = await authGet(`/api/students/all?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('uses the JWT school even without a query param', async () => {
      const active = buildStudentRow({ is_archived: false });
      mockQueryResponse([active]);
      const res = await authGet('/api/students/all');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('db error');
      const res = await authGet(`/api/students/all?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
