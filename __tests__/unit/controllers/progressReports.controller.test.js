jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn(),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn(),
    }),
    close: jest.fn(),
  }),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const {
  buildProgressReportFeedbackRow,
  buildProgressReportRow,
  buildStudentRow,
} = require('../../helpers/factories');

const app = getApp();

describe('Progress Reports Controller', () => {
  // ─── GET /api/progress-reports/feedback/student/:studentId/class/:classId ──
  describe('GET /feedback/student/:studentId/class/:classId', () => {
    it('should return feedback for a student in a class', async () => {
      const token = mockAdminUser();
      const row = buildProgressReportFeedbackRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get(`/api/progress-reports/feedback/student/${row.student_id}/class/${row.class_id}`)
        .set('Authorization', `Bearer ${token}`)
        .query({ term: row.term });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).not.toBeNull();
      expect(res.body.data.studentId).toBe(row.student_id);
      expect(res.body.data.coreStandards).toBe(row.core_standards);
    });

    it('should return null data when feedback not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/progress-reports/feedback/student/sid/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('should use default term "General" when not provided', async () => {
      const token = mockAdminUser();
      const row = buildProgressReportFeedbackRow({ term: 'General' });
      mockQueryResponse([row]);

      const res = await request(app)
        .get(`/api/progress-reports/feedback/student/${row.student_id}/class/${row.class_id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/progress-reports/feedback/student/sid/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('error');
    });
  });

  // ─── POST /api/progress-reports/feedback/student/:studentId/class/:classId ─
  describe('POST /feedback/student/:studentId/class/:classId', () => {
    it('should upsert feedback successfully', async () => {
      const token = mockAdminUser();
      const row = buildProgressReportFeedbackRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(`/api/progress-reports/feedback/student/${row.student_id}/class/${row.class_id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          term: 'Term 1 2025-2026',
          coreStandards: 'Meeting expectations',
          workHabit: 'Good',
          behavior: 'Excellent',
          comment: 'Great work',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Progress report feedback saved successfully');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post('/api/progress-reports/feedback/student/sid/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1', coreStandards: 'Good' });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/progress-reports/feedback/student/:studentId ─────
  describe('GET /feedback/student/:studentId', () => {
    it('should return all feedback for a student', async () => {
      const token = mockAdminUser();
      const rows = [
        buildProgressReportFeedbackRow({ subject: 'Math' }),
        buildProgressReportFeedbackRow({ subject: 'Science' }),
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/progress-reports/feedback/student/some-student-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/progress-reports/feedback/student/sid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/progress-reports/feedback/class/:classId ─────────
  describe('GET /feedback/class/:classId', () => {
    it('should return all feedback for a class', async () => {
      const token = mockAdminUser();
      const rows = [buildProgressReportFeedbackRow()];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/progress-reports/feedback/class/some-class-id')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/progress-reports/feedback/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(500);
    });
  });

  // ─── DELETE /api/progress-reports/feedback/student/:studentId/class/:classId
  describe('DELETE /feedback/student/:studentId/class/:classId', () => {
    it('should delete feedback successfully', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 1); // rowCount=1

      const res = await request(app)
        .delete('/api/progress-reports/feedback/student/sid/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when feedback not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 0); // rowCount=0

      const res = await request(app)
        .delete('/api/progress-reports/feedback/student/sid/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('error');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .delete('/api/progress-reports/feedback/student/sid/class/cid')
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/progress-reports/feedback/bulk ──────────────────
  describe('POST /feedback/bulk', () => {
    const url = '/api/progress-reports/feedback/bulk';

    it('should bulk upsert feedback in a transaction', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');

      // BEGIN
      db.query.mockResolvedValueOnce({});
      // Two upsert queries
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      // COMMIT
      db.query.mockResolvedValueOnce({});

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          feedbackEntries: [
            { studentId: 's1', classId: 'c1', term: 'Term 1', coreStandards: 'Good' },
            { studentId: 's2', classId: 'c1', term: 'Term 1', workHabit: 'Excellent' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.updated).toBe(2);
    });

    it('should return 400 when feedbackEntries is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ feedbackEntries: [] });

      expect(res.status).toBe(400);
    });

    it('should return 400 when entries have validation errors', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          feedbackEntries: [{ classId: 'c1', term: 'Term 1' }], // missing studentId
        });

      expect(res.status).toBe(400);
      expect(res.body.data.errors).toHaveLength(1);
    });

    it('should rollback transaction on failure', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');

      db.query.mockResolvedValueOnce({}); // BEGIN
      db.query.mockRejectedValueOnce(new Error('DB failure'));
      db.query.mockResolvedValueOnce({}); // ROLLBACK

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          feedbackEntries: [{ studentId: 's1', classId: 'c1', term: 'Term 1' }],
        });

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ─── POST /api/progress-reports/reports ────────────────────────
  describe('POST /reports', () => {
    const url = '/api/progress-reports/reports';

    it('should create a progress report record', async () => {
      const token = mockAdminUser();
      const row = buildProgressReportRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: row.student_id,
          term: row.term,
          studentName: row.student_name,
          grade: row.grade,
          filePath: row.file_path,
          school: row.school,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/progress-reports/reports/student/:studentId ──────
  describe('GET /reports/student/:studentId', () => {
    it('should return progress reports for a student', async () => {
      const token = mockAdminUser();
      const rows = [buildProgressReportRow()];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/progress-reports/reports/student/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });
  });

  // ─── GET /api/progress-reports/reports/term/:term/school/:school
  describe('GET /reports/term/:term/school/:school', () => {
    it('should return progress reports by term and school', async () => {
      const token = mockAdminUser();
      const rows = [buildProgressReportRow()];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(`/api/progress-reports/reports/term/Term%201/school/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });
  });

  // ─── POST /api/progress-reports/generate ───────────────────────
  describe('POST /generate', () => {
    const url = '/api/progress-reports/generate';

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/progress-reports/generate/bulk ──────────────────
  describe('POST /generate/bulk', () => {
    const url = '/api/progress-reports/generate/bulk';

    it('should return 400 when studentIds is not an array', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: 'not-array', term: 'Term 1' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: ['s1'] });

      expect(res.status).toBe(400);
    });
  });

  // ─── DELETE /api/progress-reports/delete ───────────────────────
  describe('DELETE /delete', () => {
    const url = '/api/progress-reports/delete';

    it('should delete a progress report', async () => {
      const token = mockAdminUser();
      // supabase remove already mocked to succeed
      mockQueryResponse([], 1); // db DELETE

      const res = await request(app)
        .delete(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ filePath: 'ALHAADIACADEMY/test.pdf' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when filePath is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .delete(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('should return 500 when supabase delete fails', async () => {
      const token = mockAdminUser();
      const supabase = require('../../__mocks__/config/supabaseClient');
      supabase._mockStorage.remove.mockResolvedValueOnce({
        data: null,
        error: { message: 'Storage error' },
      });

      const res = await request(app)
        .delete(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ filePath: 'some/path.pdf' });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/progress-reports/signed-url ──────────────────────
  describe('GET /signed-url', () => {
    const url = '/api/progress-reports/signed-url';

    it('should return a signed URL', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ path: 'ALHAADIACADEMY/test.pdf' });

      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://mock-signed-url.com');
    });

    it('should return 400 when path is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });
  });
});
