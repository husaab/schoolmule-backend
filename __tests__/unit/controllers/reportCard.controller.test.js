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
const { mockAdminUser, mockTeacherUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const {
  buildReportCardFeedbackRow,
  buildReportCardRow,
  buildStudentRow,
} = require('../../helpers/factories');

const app = getApp();

describe('Report Card Controller', () => {
  // ─── POST /api/report-cards/feedback ───────────────────────────
  describe('POST /api/report-cards/feedback', () => {
    const url = '/api/report-cards/feedback';

    it('should upsert feedback successfully (term derived from class)', async () => {
      const token = mockAdminUser();
      mockQueryResponse([{ term: 'Term 1 2025-2026' }]); // resolveClassTerm
      mockQueryResponse([]);                              // upsert

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          studentId: 'sid',
          classId: 'cid',
          workHabits: 'Excellent',
          behavior: 'Good',
          comment: 'Great work',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Feedback saved successfully');
    });

    it('ignores a client-sent term and stores under the class term', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      mockQueryResponse([{ term: 'Term 1' }]); // resolveClassTerm → class is Term 1
      mockQueryResponse([]);                    // upsert

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', classId: 'cid', term: 'Term 2', workHabits: 'G' });

      expect(res.status).toBe(200);
      // the upsert (2nd controller db.query call) must have been called with the CLASS
      // term, not 'Term 2'. Filter out the resolveSchoolYear middleware's own
      // (globally-mounted) lookup so this stays robust to that extra call.
      const controllerCalls = db.query.mock.calls.filter(([sql]) => !sql.includes('FROM school_years'));
      const upsertCall = controllerCalls[1];
      expect(upsertCall[1]).toEqual(['sid', 'cid', 'Term 1', 'G', null, null]);
    });

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ classId: 'cid' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when classId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when the class has no resolvable term', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // resolveClassTerm → no row

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', classId: 'cid' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/term/i);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid', classId: 'cid' });

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).post(url).send({
        studentId: 'sid',
        classId: 'cid',
      });

      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/report-cards/feedback ────────────────────────────
  describe('GET /api/report-cards/feedback', () => {
    const url = '/api/report-cards/feedback';

    it('should return feedback data', async () => {
      const token = mockAdminUser();
      const row = buildReportCardFeedbackRow();
      mockQueryResponse([{ term: row.term }]); // resolveClassTerm
      mockQueryResponse([row]);                // selectFeedback

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ studentId: row.student_id, classId: row.class_id });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentId).toBe(row.student_id);
      expect(res.body.data.workHabits).toBe(row.work_habits);
    });

    it('should return 404 when feedback not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([{ term: 'Term 1' }]); // resolveClassTerm
      mockQueryResponse([]);                    // selectFeedback → none

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ studentId: 'sid', classId: 'cid' });

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when query params missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ studentId: 'sid', classId: 'cid' });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/report-cards/feedback/class/:classId ─────────────
  describe('GET /api/report-cards/feedback/class/:classId', () => {
    it('should return class feedback (term derived from class)', async () => {
      const token = mockAdminUser();
      const row = {
        ...buildReportCardFeedbackRow(),
        student_name: 'John Smith',
      };
      mockQueryResponse([{ term: row.term }]); // resolveClassTerm
      mockQueryResponse([row]);                // selectFeedbackByClass

      const res = await request(app)
        .get(`/api/report-cards/feedback/class/${row.class_id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].studentName).toBe('John Smith');
    });

    it('should return 400 when the class has no resolvable term', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // resolveClassTerm → no row

      const res = await request(app)
        .get('/api/report-cards/feedback/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/report-cards/feedback/class/some-class-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/report-cards/feedback/bulk ──────────────────────
  describe('POST /api/report-cards/feedback/bulk', () => {
    const url = '/api/report-cards/feedback/bulk';

    it('should save bulk feedback in a transaction (term derived from class)', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');

      // resolveClassTerm (once per distinct class: c1)
      db.query.mockResolvedValueOnce({ rows: [{ term: 'Term 1' }] });
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
            { studentId: 's1', classId: 'c1', term: 'Term 2', workHabits: 'Good' },
            { studentId: 's2', classId: 'c1', behavior: 'Excellent' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.updated).toBe(2);
      expect(res.body.data.failed).toBe(0);
      // every upsert used the class term 'Term 1', never the client 'Term 2'
      const upsertTerms = db.query.mock.calls
        .filter(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO report_card_feedback'))
        .map(c => c[1][2]);
      expect(upsertTerms).toEqual(['Term 1', 'Term 1']);
    });

    it('should return 400 when a class has no resolvable term', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      db.query.mockResolvedValueOnce({ rows: [] }); // resolveClassTerm → none

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ feedbackEntries: [{ studentId: 's1', classId: 'c1', workHabits: 'Good' }] });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/term/i);
    });

    it('should return 400 when feedbackEntries is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ feedbackEntries: [] });

      expect(res.status).toBe(400);
    });

    it('should return 400 when feedbackEntries is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 400 when entries have validation errors', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          feedbackEntries: [
            { classId: 'c1', term: 'Term 1' }, // missing studentId
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.data.errors).toHaveLength(1);
    });

    it('should rollback transaction on failure', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');

      // resolveClassTerm
      db.query.mockResolvedValueOnce({ rows: [{ term: 'Term 1' }] });
      // BEGIN
      db.query.mockResolvedValueOnce({});
      // First upsert fails
      db.query.mockRejectedValueOnce(new Error('DB failure'));
      // ROLLBACK
      db.query.mockResolvedValueOnce({});

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          feedbackEntries: [
            { studentId: 's1', classId: 'c1' },
          ],
        });

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ─── GET /api/report-cards/view ────────────────────────────────
  describe('GET /api/report-cards/view', () => {
    const url = '/api/report-cards/view';

    it('should return generated report cards', async () => {
      const token = mockAdminUser();
      const row = buildReportCardRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ term: row.term, school: row.school });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL });

      expect(res.status).toBe(400);
    });

    it('uses the JWT school when no school param is sent', async () => {
      const token = mockAdminUser();
      mockQueryResponse({ rows: [] });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1' });

      expect(res.status).toBe(200);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ term: 'Term 1', school: TEST_SCHOOL });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/report-cards/view/student ────────────────────────
  describe('GET /api/report-cards/view/student', () => {
    const url = '/api/report-cards/view/student';

    it('should return report cards for a student', async () => {
      const token = mockAdminUser();
      const row = buildReportCardRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ studentId: row.student_id, term: row.term, school: row.school });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when params missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });
  });

  // ─── DELETE /api/report-cards/delete ───────────────────────────
  describe('DELETE /api/report-cards/delete', () => {
    const url = '/api/report-cards/delete';

    it('should delete a report card', async () => {
      const token = mockAdminUser();
      const supabase = require('../../__mocks__/config/supabaseClient');
      // supabase remove is already mocked to succeed
      // db.query for DELETE
      mockQueryResponse([], 1);

      const res = await request(app)
        .delete(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ filePath: 'ALHAADIACADEMY/test_report.pdf' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when filePath is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .delete(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
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

  // ─── GET /api/report-cards/signed-url ──────────────────────────
  describe('GET /api/report-cards/signed-url', () => {
    const url = '/api/report-cards/signed-url';

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

  // ─── POST /api/report-cards/generate ───────────────────────────
  describe('POST /api/report-cards/generate', () => {
    const url = '/api/report-cards/generate';

    it('should return 400 when studentId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ term: 'Term 1' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when term is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'sid' });

      expect(res.status).toBe(400);
    });

    it('should return 404 when student not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // student query returns empty

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentId: 'nonexistent', term: 'Term 1' });

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/report-cards/generate/bulk ──────────────────────
  describe('POST /api/report-cards/generate/bulk', () => {
    const url = '/api/report-cards/generate/bulk';

    it('should return 400 when studentIds is not an array', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ studentIds: 'not-an-array', term: 'Term 1' });

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
});
