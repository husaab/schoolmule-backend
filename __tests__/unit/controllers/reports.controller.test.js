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
  buildStudentRow,
  buildClassRow,
  buildAssessmentRow,
  buildStudentAssessmentRow,
  buildSchoolRow,
  buildTermRow,
} = require('../../helpers/factories');

const app = getApp();

describe('Reports Controller', () => {
  // ─── POST /api/reports/student-summary/:studentId/:classId ─────
  describe('POST /api/reports/student-summary/:studentId/:classId', () => {
    const buildUrl = (studentId, classId) =>
      `/api/reports/student-summary/${studentId}/${classId}`;

    it('should generate a student summary PDF', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow({ school: TEST_SCHOOL });
      const classInfo = buildClassRow({ term_id: 'term-1' });
      const school = buildSchoolRow({ school_code: TEST_SCHOOL });
      const term = buildTermRow({ term_id: 'term-1' });
      const assessment = buildAssessmentRow({ class_id: classInfo.class_id });
      const score = buildStudentAssessmentRow({
        student_id: student.student_id,
        assessment_id: assessment.assessment_id,
        is_excluded: false,
      });

      // 1. getStudentById
      mockQueryResponse([student]);
      // 2. getClassInfo
      mockQueryResponse([classInfo]);
      // 3. verifyStudentEnrollment
      mockQueryResponse([{ student_id: student.student_id, class_id: classInfo.class_id }]);
      // 4. getSchoolInfoByCode
      mockQueryResponse([school]);
      // 5. getTermById
      mockQueryResponse([term]);
      // 6. getAssessmentsByClass
      mockQueryResponse([assessment]);
      // 7. getStudentAssessmentScores
      mockQueryResponse([score]);
      // 8. attendance query
      mockQueryResponse([{ days_absent: '2' }]);

      const res = await request(app)
        .post(buildUrl(student.student_id, classInfo.class_id))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment');
    });

    it('should return 404 when student not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // student not found

      const res = await request(app)
        .post(buildUrl('nonexistent', 'some-class'))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Student not found');
    });

    it('should return 404 when class not found', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow();
      mockQueryResponse([student]); // student found
      mockQueryResponse([]); // class not found

      const res = await request(app)
        .post(buildUrl(student.student_id, 'nonexistent'))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Class not found');
    });

    it('should return 400 when student is not enrolled in class', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow();
      const classInfo = buildClassRow();

      mockQueryResponse([student]); // student found
      mockQueryResponse([classInfo]); // class found
      mockQueryResponse([]); // enrollment check fails

      const res = await request(app)
        .post(buildUrl(student.student_id, classInfo.class_id))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Student is not enrolled in this class');
    });

    it('should return 404 when school not found', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow();
      const classInfo = buildClassRow();

      mockQueryResponse([student]);
      mockQueryResponse([classInfo]);
      mockQueryResponse([{ student_id: student.student_id }]); // enrolled
      mockQueryResponse([]); // school not found

      const res = await request(app)
        .post(buildUrl(student.student_id, classInfo.class_id))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('School information not found');
    });

    it('should return 404 when term not found', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow({ school: TEST_SCHOOL });
      const classInfo = buildClassRow();
      const school = buildSchoolRow();

      mockQueryResponse([student]);
      mockQueryResponse([classInfo]);
      mockQueryResponse([{ student_id: student.student_id }]);
      mockQueryResponse([school]);
      mockQueryResponse([]); // term not found

      const res = await request(app)
        .post(buildUrl(student.student_id, classInfo.class_id))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Term information not found');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(buildUrl('sid', 'cid'))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('error');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).post(buildUrl('sid', 'cid'));
      expect(res.status).toBe(401);
    });

    it('should work with teacher role', async () => {
      const token = mockTeacherUser();
      const student = buildStudentRow({ school: TEST_SCHOOL });
      const classInfo = buildClassRow();
      const school = buildSchoolRow();
      const term = buildTermRow();
      const assessment = buildAssessmentRow();
      const score = buildStudentAssessmentRow({ is_excluded: false });

      mockQueryResponse([student]);
      mockQueryResponse([classInfo]);
      mockQueryResponse([{ student_id: student.student_id }]);
      mockQueryResponse([school]);
      mockQueryResponse([term]);
      mockQueryResponse([assessment]);
      mockQueryResponse([score]);
      mockQueryResponse([{ days_absent: '0' }]);

      const res = await request(app)
        .post(buildUrl(student.student_id, classInfo.class_id))
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });

    it('should gracefully handle attendance query failure', async () => {
      const token = mockAdminUser();
      const student = buildStudentRow({ school: TEST_SCHOOL });
      const classInfo = buildClassRow();
      const school = buildSchoolRow();
      const term = buildTermRow();
      const assessment = buildAssessmentRow();
      const score = buildStudentAssessmentRow({ is_excluded: false });

      mockQueryResponse([student]);
      mockQueryResponse([classInfo]);
      mockQueryResponse([{ student_id: student.student_id }]);
      mockQueryResponse([school]);
      mockQueryResponse([term]);
      mockQueryResponse([assessment]);
      mockQueryResponse([score]);
      // Attendance query fails
      mockQueryError('attendance table missing');

      const res = await request(app)
        .post(buildUrl(student.student_id, classInfo.class_id))
        .set('Authorization', `Bearer ${token}`);

      // Should still generate PDF with 0 days of absence
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
  });
});
