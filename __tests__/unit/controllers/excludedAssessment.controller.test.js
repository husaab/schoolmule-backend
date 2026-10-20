const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildExcludedAssessmentRow } = require('../../helpers/factories');

// RBAC: the class guard (requireClassOwnership / requireGradebookAccess) looks
// the class up first. Its lead is the test teacher (a full admin passes any
// class of the school anyway); the counts cover every id a test names.
const mockGradebookGuard = () => require('../../helpers/mockDb').mockQueryResponse([{
  class_id: '11111111-1111-4111-8111-111111111111', school: 'ALHAADIACADEMY', teacher_id: require('../../helpers/mockAuth').TEST_TEACHER_USER_ID,
  is_co_teacher: false, classes_found: 99, assessments_found: 99,
}]);


const app = getApp();

describe('Excluded Assessment Controller', () => {
  // ─── POST /api/excluded-assessments ────────────────────────────
  describe('POST /api/excluded-assessments', () => {
    const url = '/api/excluded-assessments';

    it('should create an exclusion successfully', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();
      const row = buildExcludedAssessmentRow();
      mockQueryResponse([{ assessment_id: row.assessment_id }]); // target leaf lookup
      mockQueryResponse([]); // no turn-in columns among them (D3/D17)
      mockQueryResponse([{ student_id: row.student_id, assessment_id: row.assessment_id, score: 7, status: 'excused' }]); // upsert

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

    it('should return 404 when the assessment is not in the class', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryResponse([]); // no matching leaf assessments

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: 'sid',
          classId: 'cid',
          assessmentId: 'aid',
        });

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when studentId is missing', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ classId: 'cid', assessmentId: 'aid' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when classId is missing', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', assessmentId: 'aid' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when assessmentId is missing', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', classId: 'cid' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
    mockGradebookGuard();
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
    mockGradebookGuard();
      const res = await request(app)
        .post(url)
        .send({ studentId: 'sid', classId: 'cid', assessmentId: 'aid' });

      expect(res.status).toBe(401);
    });

    it('should work with teacher role', async () => {
    mockGradebookGuard();
      const token = mockTeacherUser();
      const row = buildExcludedAssessmentRow();
      mockQueryResponse([{ assessment_id: row.assessment_id }]);
      mockQueryResponse([]); // no turn-in columns
      mockQueryResponse([{ student_id: row.student_id, assessment_id: row.assessment_id, score: null, status: 'excused' }]);

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
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryResponse([{ assessment_id: 'aid' }]); // target leaf lookup
      mockQueryResponse([]); // no turn-in columns
      mockQueryResponse([{ student_id: 'sid', assessment_id: 'aid', score: 7, status: 'graded' }]); // upsert

      const res = await request(app)
        .delete('/api/excluded-assessments/sid/cid/aid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Assessment exclusion deleted successfully');
    });

    it('should return 404 when exclusion not found', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryResponse([]); // no matching leaf assessments

      const res = await request(app)
        .delete('/api/excluded-assessments/sid/cid/aid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toBe('Exclusion not found');
    });

    it('should return 500 on database error', async () => {
    mockGradebookGuard();
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
    mockGradebookGuard();
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
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return 500 on database error', async () => {
    mockGradebookGuard();
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
    mockGradebookGuard();
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
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/excluded-assessments/sid/cid/aid/check')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.isExcluded).toBe(false);
    });

    it('should return 500 on database error', async () => {
    mockGradebookGuard();
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
    mockGradebookGuard();
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
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/excluded-assessments/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return 500 on database error', async () => {
    mockGradebookGuard();
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/excluded-assessments/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });
});
