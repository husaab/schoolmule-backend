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
const {
  mockAdminUser,
  mockTeacherUser,
  TEST_ADMIN_USER_ID,
  TEST_TEACHER_USER_ID,
  TEST_SCHOOL,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildTeacherAttendanceRow } = require('../../helpers/factories');

const app = getApp();

describe('Teacher Attendance Controller', () => {
  // ─── GET /api/teacher-attendance/today ─────────────────────────
  describe('GET /api/teacher-attendance/today', () => {
    const url = '/api/teacher-attendance/today';

    it('should return checked-in status when record exists', async () => {
      const token = mockTeacherUser();
      const row = buildTeacherAttendanceRow({ teacher_id: TEST_TEACHER_USER_ID });
      mockQueryResponse([row]);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '2025-10-15' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.checkedIn).toBe(true);
      expect(res.body.data.status).toBe('present');
    });

    it('should return not checked-in when no record exists', async () => {
      const token = mockTeacherUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '2025-10-15' });

      expect(res.status).toBe(200);
      expect(res.body.data.checkedIn).toBe(false);
      expect(res.body.data.status).toBeNull();
    });

    it('should return 400 when date is missing', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('should return 400 when date format is invalid', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '15-10-2025' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockTeacherUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '2025-10-15' });

      expect(res.status).toBe(500);
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get(url).query({ date: '2025-10-15' });
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/teacher-attendance/checkin ──────────────────────
  describe('POST /api/teacher-attendance/checkin', () => {
    const url = '/api/teacher-attendance/checkin';

    it('should check in successfully', async () => {
      const token = mockTeacherUser();
      const row = buildTeacherAttendanceRow({
        teacher_id: TEST_TEACHER_USER_ID,
        status: 'PRESENT',
      });
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', date: '2025-10-15' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.teacherId).toBe(TEST_TEACHER_USER_ID);
    });

    it('should check in as ABSENT', async () => {
      const token = mockTeacherUser();
      const row = buildTeacherAttendanceRow({
        teacher_id: TEST_TEACHER_USER_ID,
        status: 'ABSENT',
      });
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ABSENT', date: '2025-10-15', notes: 'Sick day' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ABSENT');
    });

    it('should return 400 when status is invalid', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'LATE', date: '2025-10-15' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when status is missing', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ date: '2025-10-15' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when date is missing', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when date format is invalid', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', date: 'Oct 15 2025' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockTeacherUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', date: '2025-10-15' });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/teacher-attendance/me ────────────────────────────
  describe('GET /api/teacher-attendance/me', () => {
    const url = '/api/teacher-attendance/me';

    it('should return monthly records', async () => {
      const token = mockTeacherUser();
      const db = require('../../__mocks__/config/database');

      // Records query
      db.query.mockResolvedValueOnce({
        rows: [
          { attendance_date: '2025-10-01', status: 'PRESENT', notes: null },
          { attendance_date: '2025-10-02', status: 'ABSENT', notes: 'Sick' },
        ],
        rowCount: 2,
      });
      // Working days query
      db.query.mockResolvedValueOnce({
        rows: [{ working_days: 22 }],
        rowCount: 1,
      });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2025-10' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.records).toHaveLength(2);
      expect(res.body.data.workingDays).toBe(22);
      expect(res.body.data.presentDays).toBe(1);
      expect(res.body.data.absentDays).toBe(1);
    });

    it('should return 400 when month is missing', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('should return 400 when month format is invalid', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2025-13-01' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockTeacherUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2025-10' });

      expect(res.status).toBe(500);
    });
  });

  // ─── PATCH /api/teacher-attendance/me/:date ────────────────────
  describe('PATCH /api/teacher-attendance/me/:date', () => {
    it('should update a record', async () => {
      const token = mockTeacherUser();
      const row = buildTeacherAttendanceRow({
        teacher_id: TEST_TEACHER_USER_ID,
        status: 'ABSENT',
      });
      mockQueryResponse([row]);

      const res = await request(app)
        .patch('/api/teacher-attendance/me/2025-10-15')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ABSENT', notes: 'Was sick' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when status is invalid', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .patch('/api/teacher-attendance/me/2025-10-15')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'INVALID' });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockTeacherUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .patch('/api/teacher-attendance/me/2025-10-15')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT' });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/teacher-attendance (admin) ───────────────────────
  describe('GET /api/teacher-attendance', () => {
    const url = '/api/teacher-attendance';

    it('should return all teacher attendance for a school month', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');

      // Data query
      db.query.mockResolvedValueOnce({
        rows: [
          {
            teacher_id: TEST_TEACHER_USER_ID,
            first_name: 'Teacher',
            last_name: 'User',
            username: 'Teacher User',
            attendance_date: '2025-10-01',
            status: 'PRESENT',
            notes: null,
          },
        ],
        rowCount: 1,
      });
      // Working days query
      db.query.mockResolvedValueOnce({
        rows: [{ working_days: 22 }],
        rowCount: 1,
      });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2025-10' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.teachers).toHaveLength(1);
      expect(res.body.data.workingDays).toBe(22);
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2025-10' });

      expect(res.status).toBe(403);
    });

    it('should return 400 when school is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2025-10' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when month is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL });

      expect(res.status).toBe(400);
    });

    it('should return 400 when month format is invalid', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2025' });

      expect(res.status).toBe(400);
    });
  });

  // ─── PATCH /api/teacher-attendance/:teacherId/:date (admin) ────
  describe('PATCH /api/teacher-attendance/:teacherId/:date', () => {
    it('should update any teacher record as admin', async () => {
      const token = mockAdminUser();
      const row = buildTeacherAttendanceRow({
        teacher_id: TEST_TEACHER_USER_ID,
        status: 'ABSENT',
      });
      mockQueryResponse([row]);

      const res = await request(app)
        .patch(`/api/teacher-attendance/${TEST_TEACHER_USER_ID}/2025-10-15`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'ABSENT', notes: 'Excused absence' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .patch(`/api/teacher-attendance/${TEST_TEACHER_USER_ID}/2025-10-15`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT' });

      expect(res.status).toBe(403);
    });

    it('should return 400 when status is invalid', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .patch(`/api/teacher-attendance/${TEST_TEACHER_USER_ID}/2025-10-15`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'INVALID' });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/teacher-attendance/pdf (admin) ───────────────────
  describe('GET /api/teacher-attendance/pdf', () => {
    const url = '/api/teacher-attendance/pdf';

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2025-10' });

      expect(res.status).toBe(403);
    });

    it('should return 400 when school is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2025-10' });

      expect(res.status).toBe(400);
    });

    it('should return 400 when month format is invalid', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: 'bad-format' });

      expect(res.status).toBe(400);
    });

    it('should generate a PDF for admin', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');

      // Data query
      db.query.mockResolvedValueOnce({
        rows: [
          {
            teacher_id: TEST_TEACHER_USER_ID,
            first_name: 'Teacher',
            last_name: 'User',
            username: 'Teacher User',
            attendance_date: '2025-10-01',
            status: 'PRESENT',
            notes: null,
          },
        ],
        rowCount: 1,
      });
      // Working days
      db.query.mockResolvedValueOnce({
        rows: [{ working_days: 22 }],
        rowCount: 1,
      });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2025-10' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
  });
});
