const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildExcludedAssessmentRow } = require('../../helpers/factories');

const app = getApp();

describe('Excluded Assessment Controller', () => {
  // ─── POST /api/excluded-assessments ────────────────────────────
  describe('POST /api/excluded-assessments', () => {
    const url = '/api/excluded-assessments';

    it('should create an exclusion successfully', async () => {
      const token = mockAdminUser();
      const row = buildExcludedAssessmentRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: row.student_id,
          classId: row.class_id,
          assessmentId: row.assessment_id,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(row.student_id);
      expect(res.body.data.classId).toBe(row.class_id);
      expect(res.body.data.assessmentId).toBe(row.assessment_id);
    });

    it('should return 200 when exclusion already exists (ON CONFLICT DO NOTHING)', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // empty rows = already exists

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: 'sid',
          classId: 'cid',
          assessmentId: 'aid',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Exclusion already exists');
    });

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ classId: 'cid', assessmentId: 'aid' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when classId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', assessmentId: 'aid' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when assessmentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', classId: 'cid' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', classId: 'cid', assessmentId: 'aid' });

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .post(url)
        .send({ studentId: 'sid', classId: 'cid', assessmentId: 'aid' });

      expect(res.status).toBe(401);
    });

    it('should work with teacher role', async () => {
      const token = mockTeacherUser();
      const row = buildExcludedAssessmentRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: row.student_id,
          classId: row.class_id,
          assessmentId: row.assessment_id,
        });

      expect(res.status).toBe(201);
    });
  });

  // ─── DELETE /api/excluded-assessments/:studentId/:classId/:assessmentId ────
  describe('DELETE /api/excluded-assessments/:studentId/:classId/:assessmentId', () => {
    it('should delete an exclusion successfully', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 1); // rowCount=1

      const res = await request(app)
        .delete('/api/excluded-assessments/sid/cid/aid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Assessment exclusion deleted successfully');
    });

    it('should return 404 when exclusion not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 0); // rowCount=0

      const res = await request(app)
        .delete('/api/excluded-assessments/sid/cid/aid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toBe('Exclusion not found');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .delete('/api/excluded-assessments/sid/cid/aid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/excluded-assessments/:studentId/:classId ─────────
  describe('GET /api/excluded-assessments/:studentId/:classId', () => {
    it('should return exclusions for a student in a class', async () => {
      const token = mockAdminUser();
      const rows = [
        buildExcludedAssessmentRow(),
        buildExcludedAssessmentRow(),
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toHaveProperty('studentId');
      expect(res.body.data[0]).toHaveProperty('classId');
      expect(res.body.data[0]).toHaveProperty('assessmentId');
    });

    it('should return empty array when no exclusions exist', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/excluded-assessments/:studentId/:classId/:assessmentId/check ─
  describe('GET /api/excluded-assessments/:studentId/:classId/:assessmentId/check', () => {
    it('should return isExcluded true when exclusion exists', async () => {
      const token = mockAdminUser();
      const row = buildExcludedAssessmentRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid/aid/check')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.isExcluded).toBe(true);
    });

    it('should return isExcluded false when no exclusion exists', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid/aid/check')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isExcluded).toBe(false);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid/aid/check')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/excluded-assessments/class/:classId ──────────────
  describe('GET /api/excluded-assessments/class/:classId', () => {
    it('should return all exclusions for a class', async () => {
      const token = mockAdminUser();
      const rows = [
        buildExcludedAssessmentRow(),
        buildExcludedAssessmentRow(),
        buildExcludedAssessmentRow(),
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/excluded-assessments/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(3);
    });

    it('should return empty array when class has no exclusions', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/excluded-assessments/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/excluded-assessments/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });
});
