jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildAssessmentRow, buildCreateAssessmentBody } = require('../../helpers/factories');
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
function authPatch(url) {
  const token = mockAdminUser();
  return request(app).patch(url).set('Authorization', `Bearer ${token}`);
}
function authDelete(url) {
  const token = mockAdminUser();
  return request(app).delete(url).set('Authorization', `Bearer ${token}`);
}

describe('Assessment Controller', () => {
  // ── getAssessmentById ──────────────────────────────────────────────
  describe('GET /api/assessments/:id', () => {
    it('should return 200 with the assessment', async () => {
      const row = buildAssessmentRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/assessments/${row.assessment_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.assessmentId).toBe(row.assessment_id);
      expect(res.body.data.name).toBe(row.name);
    });

    it('should return 404 when assessment not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/assessments/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/assessments/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getAssessmentsByClass ──────────────────────────────────────────────
  describe('GET /api/assessments/class/:classId', () => {
    it('should return 200 with assessments for the class', async () => {
      const classId = uuidv4();
      const row1 = buildAssessmentRow({ class_id: classId });
      const row2 = buildAssessmentRow({ class_id: classId, name: 'Final Exam' });
      mockQueryResponse([row1, row2]);
      const res = await authGet(`/api/assessments/class/${classId}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('should return 200 with empty array when no assessments', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/assessments/class/${uuidv4()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/assessments/class/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createAssessment ──────────────────────────────────────────────
  describe('POST /api/assessments', () => {
    it('should return 201 on successful creation (standalone)', async () => {
      const row = buildAssessmentRow();
      mockQueryResponse([row]);
      const body = buildCreateAssessmentBody();
      const res = await authPost('/api/assessments').send(body);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.assessmentId).toBe(row.assessment_id);
    });

    it('should return 400 when classId is missing', async () => {
      const res = await authPost('/api/assessments').send({ name: 'Test' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/classId/);
    });

    it('should return 400 when name is missing', async () => {
      const res = await authPost('/api/assessments').send({ classId: uuidv4() });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const body = buildCreateAssessmentBody();
      const res = await authPost('/api/assessments').send(body);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateAssessment ──────────────────────────────────────────────
  describe('PATCH /api/assessments/:id', () => {
    it('should return 200 on successful update', async () => {
      const row = buildAssessmentRow({ name: 'Updated Assessment' });
      mockQueryResponse([row], 1);
      const res = await authPatch(`/api/assessments/${row.assessment_id}`).send({
        name: 'Updated Assessment',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('Updated Assessment');
    });

    it('should return 404 when assessment not found', async () => {
      mockQueryResponse([], 0);
      const res = await authPatch(`/api/assessments/${uuidv4()}`).send({ name: 'Test' });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPatch(`/api/assessments/${uuidv4()}`).send({ name: 'Test' });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteAssessment ──────────────────────────────────────────────
  describe('DELETE /api/assessments/:id', () => {
    it('should return 200 on successful deletion', async () => {
      mockQueryResponse([], 1);
      const res = await authDelete(`/api/assessments/${uuidv4()}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 404 when assessment not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete(`/api/assessments/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/assessments/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── batchUpdateAssessments ──────────────────────────────────────────────
  describe('PATCH /api/assessments/batch', () => {
    it('should return 200 on successful batch update', async () => {
      const row1 = buildAssessmentRow({ name: 'A1' });
      const row2 = buildAssessmentRow({ name: 'A2' });
      mockQueryResponse([row1, row2]);
      const res = await authPatch('/api/assessments/batch').send({
        updates: [
          { assessmentId: row1.assessment_id, name: 'A1' },
          { assessmentId: row2.assessment_id, name: 'A2' },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('should return 400 when updates array is empty', async () => {
      const res = await authPatch('/api/assessments/batch').send({ updates: [] });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when updates is not an array', async () => {
      const res = await authPatch('/api/assessments/batch').send({ updates: 'invalid' });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when an update is missing assessmentId', async () => {
      const res = await authPatch('/api/assessments/batch').send({
        updates: [{ name: 'No ID' }],
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('batch failed');
      const res = await authPatch('/api/assessments/batch').send({
        updates: [{ assessmentId: uuidv4(), name: 'Test' }],
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
