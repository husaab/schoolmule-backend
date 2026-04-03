jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ data: { id: 'email-123' }, error: null }),
    },
  })),
}));

// Mock global fetch for PDF download
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
});

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL, TEST_ADMIN_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const {
  buildStudentRow,
  buildReportEmailRow,
  buildReportCardRow,
  buildProgressReportRow,
  buildSchoolRow,
} = require('../../helpers/factories');

const app = getApp();

describe('Report Emails Controller', () => {
  // ─── POST /api/report-emails/send ──────────────────────────────
  describe('POST /api/report-emails/send', () => {
    const url = '/api/report-emails/send';

    it('should return 400 when required fields are missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ reportType: 'report_card' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });

    it('should return 400 for invalid reportType', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'invalid_type',
          studentId: 'sid',
          term: 'Term 1',
          emailAddresses: ['parent@test.com'],
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid report type');
    });

    it('should return 400 when emailAddresses is empty after cleaning', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'report_card',
          studentId: 'sid',
          term: 'Term 1',
          emailAddresses: ['not-an-email', ''],
        });

      expect(res.status).toBe(400);
    });

    it('should return 404 when student not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // student not found

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'report_card',
          studentId: 'nonexistent',
          term: 'Term 1',
          emailAddresses: ['parent@test.com'],
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Student not found');
    });

    it('should return 404 when report not found', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow();
      mockQueryResponse([student]); // student found
      mockQueryResponse([]); // report not found

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'report_card',
          studentId: student.student_id,
          term: 'Term 1',
          emailAddresses: ['parent@test.com'],
        });

      expect(res.status).toBe(404);
    });

    it('should send report card email successfully', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow({ school: TEST_SCHOOL });
      const report = buildReportCardRow({ student_id: student.student_id });
      const emailRecord = buildReportEmailRow();
      const school = buildSchoolRow();

      // 1. selectStudentById
      mockQueryResponse([student]);
      // 2. selectGeneratedReportCardsByStudentId (report query)
      mockQueryResponse([report]);
      // 3. selectSchoolByCode (school info)
      mockQueryResponse([school]);
      // 4. createReportEmail
      mockQueryResponse([emailRecord]);
      // 5. updateReportCardEmailStatus
      mockQueryResponse([], 1);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'report_card',
          studentId: student.student_id,
          term: 'Term 1 2025-2026',
          emailAddresses: ['parent@test.com'],
          customHeader: 'Report Card for Your Child',
          customMessage: 'Please find attached.',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.id).toBeDefined();
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .post(url)
        .send({
          reportType: 'report_card',
          studentId: 'sid',
          term: 'Term 1',
          emailAddresses: ['parent@test.com'],
        });

      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/report-emails/send/bulk ─────────────────────────
  describe('POST /api/report-emails/send/bulk', () => {
    const url = '/api/report-emails/send/bulk';

    it('should return 400 when required fields are missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ reportType: 'report_card' });

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid reportType', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'invalid',
          studentIds: ['s1'],
          term: 'Term 1',
        });

      expect(res.status).toBe(400);
    });

    it('should return 404 when no students found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // batch student query returns nothing

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          reportType: 'report_card',
          studentIds: ['nonexistent-id'],
          term: 'Term 1',
        });

      expect(res.status).toBe(404);
    });
  });

  // ─── GET /api/report-emails/history/student/:studentId ─────────
  describe('GET /api/report-emails/history/student/:studentId', () => {
    it('should return email history for a student', async () => {
      const token = mockAdminUser();
      const rows = [
        buildReportEmailRow({ email_addresses: ['parent@test.com'] }),
      ];
      mockQueryResponse(rows);

      const res = await request(app)
        .get('/api/report-emails/history/student/some-student-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
    });

    it('should return empty array when no history', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/report-emails/history/student/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/report-emails/history/student/sid')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/report-emails/history/term/:term/school/:school ──
  describe('GET /api/report-emails/history/term/:term/school/:school', () => {
    it('should return email history by term and school', async () => {
      const token = mockAdminUser();
      const rows = [buildReportEmailRow({ email_addresses: ['p@t.com'] })];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(`/api/report-emails/history/term/Term%201/school/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(`/api/report-emails/history/term/Term%201/school/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });
});
