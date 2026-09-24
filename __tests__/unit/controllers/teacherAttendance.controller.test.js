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

/**
 * Rows shaped like teacherAttendanceQueries.selectOpenSchoolDays returns: the
 * first `count` weekdays of the month, all elapsed. (The real query never
 * returns weekends, and work days default to Mon–Fri.)
 */
const openSchoolDayRows = (month, count) => {
  const [y, m] = month.split('-').map(Number);
  const rows = [];
  for (let d = 1; rows.length < count; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) continue;
    rows.push({ day: `${month}-${String(d).padStart(2, '0')}`, is_elapsed: true });
  }
  return rows;
};

/** A staff_pay_schedules row: monthly on the 25th, 7-hour days. */
const payScheduleRow = (overrides = {}) => ({
  school: TEST_SCHOOL,
  frequency: 'MONTHLY',
  pay_day_of_month: 25,
  second_pay_day_of_month: null,
  anchor_pay_date: null,
  default_hours_per_day: '7.00',
  updated_at: '2026-09-01T00:00:00Z',
  ...overrides,
});

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
      // Open school days query — 22 elapsed weekdays, none assumed-present
      // because October 2025 predates ASSUMED_PRESENT_FROM.
      db.query.mockResolvedValueOnce({
        rows: openSchoolDayRows('2025-10', 22),
        rowCount: 22,
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

    it('should assume present on elapsed open school days with no record', async () => {
      const token = mockTeacherUser();
      const db = require('../../__mocks__/config/database');

      // The teacher only ever recorded one day — an absence.
      db.query.mockResolvedValueOnce({
        rows: [{ attendance_date: '2026-09-10', status: 'ABSENT', notes: 'Sick' }],
        rowCount: 1,
      });
      // Sept 8-11 are open; Sept 14 has not happened yet.
      db.query.mockResolvedValueOnce({
        rows: [
          { day: '2026-09-08', is_elapsed: true },
          { day: '2026-09-09', is_elapsed: true },
          { day: '2026-09-10', is_elapsed: true },
          { day: '2026-09-11', is_elapsed: true },
          { day: '2026-09-14', is_elapsed: false },
        ],
        rowCount: 5,
      });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2026-09' });

      expect(res.status).toBe(200);

      const byDate = Object.fromEntries(
        res.body.data.records.map((r) => [r.attendanceDate.substring(0, 10), r.status])
      );

      // Gaps fill in as present, the explicit absence survives, and a day that
      // has not happened yet is left alone.
      expect(byDate['2026-09-08']).toBe('PRESENT');
      expect(byDate['2026-09-09']).toBe('PRESENT');
      expect(byDate['2026-09-10']).toBe('ABSENT');
      expect(byDate['2026-09-11']).toBe('PRESENT');
      expect(byDate['2026-09-14']).toBeUndefined();

      expect(res.body.data.records).toHaveLength(4);
      expect(res.body.data.presentDays).toBe(3);
      expect(res.body.data.absentDays).toBe(1);
      // Working days counts every open school day, elapsed or not.
      expect(res.body.data.workingDays).toBe(5);
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
      // Open school days query — 22 elapsed weekdays, none assumed-present
      // because October 2025 predates ASSUMED_PRESENT_FROM.
      db.query.mockResolvedValueOnce({
        rows: openSchoolDayRows('2025-10', 22),
        rowCount: 22,
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
      // Open school days
      db.query.mockResolvedValueOnce({
        rows: openSchoolDayRows('2025-10', 22),
        rowCount: 22,
      });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2025-10' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });

    it('should include hours worked up to each pay day when a schedule exists', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      // The mocked puppeteer page receives the rendered HTML.
      const page = await (await require('puppeteer').launch()).newPage();

      // Month build: records, open days, work days, pay schedule
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      db.query.mockResolvedValueOnce({ rows: openSchoolDayRows('2026-09', 5), rowCount: 5 });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });
      // Pay-period build (Aug 26 – Sept 25): same four queries
      db.query.mockResolvedValueOnce({
        rows: [
          {
            teacher_id: TEST_TEACHER_USER_ID,
            first_name: 'Teacher',
            last_name: 'User',
            username: 'teacher',
            attendance_date: '2026-09-09',
            status: 'PRESENT',
            notes: null,
            hours: '3.50',
          },
        ],
        rowCount: 1,
      });
      db.query.mockResolvedValueOnce({
        rows: [
          { day: '2026-09-08', is_elapsed: true },
          { day: '2026-09-09', is_elapsed: true },
        ],
        rowCount: 2,
      });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ school: TEST_SCHOOL, month: '2026-09' });

      expect(res.status).toBe(200);
      const html = page.setContent.mock.calls.at(-1)[0];
      expect(html).toMatch(/Pay day Sept? 25, 2026/);
      expect(html).toContain('Aug 26, 2026');
      // Sept 8 assumed present (7h) + Sept 9 overridden to 3.5h
      expect(html).toContain('<strong>10.5</strong>');
    });
  });

  // ─── School-year guard on writes ───────────────────────────────
  describe('school-year guard', () => {
    it('rejects a check-in on a date outside every school year', async () => {
      const token = mockTeacherUser();
      // The guarded INSERT … SELECT … WHERE EXISTS inserts nothing.
      mockQueryResponse([]);

      const res = await request(app)
        .post('/api/teacher-attendance/checkin')
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', date: '2026-07-02' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/outside the school year/);
    });

    it('rejects an admin edit on a date outside every school year', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .patch(`/api/teacher-attendance/${TEST_TEACHER_USER_ID}/2026-09-03`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT' });

      expect(res.status).toBe(400);
    });
  });

  // ─── Admin hours override on a record ──────────────────────────
  describe('PATCH /api/teacher-attendance/:teacherId/:date hours', () => {
    const url = `/api/teacher-attendance/${TEST_TEACHER_USER_ID}/2026-09-10`;

    it('passes an hours override through and echoes it back', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      const row = buildTeacherAttendanceRow({ teacher_id: TEST_TEACHER_USER_ID, status: 'PRESENT', hours: '3.50' });
      mockQueryResponse([row]);

      const res = await request(app)
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', hours: 3.5 });

      expect(res.status).toBe(200);
      expect(res.body.data.hours).toBe(3.5);
      const params = db.query.mock.calls.find((c) => c[0].includes('INSERT INTO teacher_attendance'))[1];
      expect(params[5]).toBe(3.5);
    });

    it('clears the override when hours is null', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      mockQueryResponse([buildTeacherAttendanceRow({ teacher_id: TEST_TEACHER_USER_ID, hours: null })]);

      const res = await request(app)
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', hours: null });

      expect(res.status).toBe(200);
      expect(res.body.data.hours).toBeNull();
      const params = db.query.mock.calls.find((c) => c[0].includes('INSERT INTO teacher_attendance'))[1];
      expect(params[5]).toBeNull();
    });

    it('rejects hours outside 0–24', async () => {
      const token = mockAdminUser();
      const res = await request(app)
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'PRESENT', hours: 30 });
      expect(res.status).toBe(400);
    });
  });

  // ─── Hours per day ─────────────────────────────────────────────
  describe('PUT/DELETE /api/teacher-attendance/hours-per-day/:teacherId', () => {
    const url = `/api/teacher-attendance/hours-per-day/${TEST_TEACHER_USER_ID}`;

    it('saves hours per day for a staff member', async () => {
      const token = mockAdminUser();
      mockQueryResponse([{ user_id: TEST_TEACHER_USER_ID }]); // selectStaffMember
      mockQueryResponse([{ user_id: TEST_TEACHER_USER_ID, hours_per_day: '6.50' }]); // upsert

      const res = await request(app)
        .put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ hoursPerDay: 6.5 });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ teacherId: TEST_TEACHER_USER_ID, hoursPerDay: 6.5, hoursPerDaySource: 'custom' });
    });

    it('rejects a bad value and an unknown staff member', async () => {
      const token = mockAdminUser();
      const bad = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ hoursPerDay: 0 });
      expect(bad.status).toBe(400);

      mockQueryResponse([]); // selectStaffMember → nobody
      const missing = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ hoursPerDay: 7 });
      expect(missing.status).toBe(404);
    });

    it('is admin-only', async () => {
      const token = mockTeacherUser();
      const res = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ hoursPerDay: 7 });
      expect(res.status).toBe(403);
    });

    it('resets to the school default', async () => {
      const token = mockAdminUser();
      const res = await request(app).delete(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.teacherId).toBe(TEST_TEACHER_USER_ID);
    });
  });

  // ─── Pay schedule ──────────────────────────────────────────────
  describe('/api/teacher-attendance/pay-schedule', () => {
    const url = '/api/teacher-attendance/pay-schedule';

    it('returns the schedule and the current period to any staff member', async () => {
      const token = mockTeacherUser();
      mockQueryResponse([payScheduleRow()]);

      const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.schedule).toMatchObject({
        frequency: 'MONTHLY',
        payDayOfMonth: 25,
        defaultHoursPerDay: 7,
        description: 'Monthly on the 25th',
      });
      expect(res.body.data.currentPeriod.payDate).toMatch(/-25$/);
      expect(res.body.data.currentPeriod.startDate).toMatch(/-26$/);
    });

    it('returns null when the school has no schedule', async () => {
      const token = mockTeacherUser();
      mockQueryResponse([]);
      const res = await request(app).get(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.schedule).toBeNull();
      expect(res.body.data.currentPeriod).toBeNull();
    });

    it('lets an admin save a biweekly schedule', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      mockQueryResponse([
        payScheduleRow({ frequency: 'BIWEEKLY', pay_day_of_month: null, anchor_pay_date: '2026-09-11', default_hours_per_day: '8.00' }),
      ]);

      const res = await request(app)
        .put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ frequency: 'biweekly', anchorPayDate: '2026-09-11', defaultHoursPerDay: 8 });

      expect(res.status).toBe(200);
      expect(res.body.data.schedule.description).toBe('Every second Friday');
      const params = db.query.mock.calls.find((c) => c[0].includes('INSERT INTO staff_pay_schedules'))[1];
      expect(params.slice(0, 6)).toEqual([TEST_SCHOOL, 'BIWEEKLY', null, null, '2026-09-11', 8]);
    });

    it('validates the payload', async () => {
      const token = mockAdminUser();
      const res = await request(app)
        .put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ frequency: 'MONTHLY', payDayOfMonth: 40 });
      expect(res.status).toBe(400);
    });

    it('is admin-only to write and delete', async () => {
      const token = mockTeacherUser();
      const put = await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ frequency: 'MONTHLY', payDayOfMonth: 25 });
      expect(put.status).toBe(403);
      const del = await request(app).delete(url).set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(403);
    });

    it('deletes the schedule', async () => {
      const token = mockAdminUser();
      const res = await request(app).delete(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.schedule).toBeNull();
    });
  });

  // ─── Pay periods ───────────────────────────────────────────────
  describe('GET /api/teacher-attendance/pay-periods', () => {
    const url = '/api/teacher-attendance/pay-periods';

    it('returns every period paid in the month with hours per teacher', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      // Schedule lookup
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });
      // Period build (Aug 26 – Sept 25): records, open days, work days, schedule
      db.query.mockResolvedValueOnce({
        rows: [
          { teacher_id: TEST_TEACHER_USER_ID, first_name: 'Teacher', last_name: 'User', username: 'teacher', attendance_date: '2026-09-10', status: 'ABSENT', notes: null, hours: null },
        ],
        rowCount: 1,
      });
      db.query.mockResolvedValueOnce({
        rows: [
          { day: '2026-09-08', is_elapsed: true },
          { day: '2026-09-09', is_elapsed: true },
          { day: '2026-09-10', is_elapsed: true },
          { day: '2026-09-11', is_elapsed: false },
        ],
        rowCount: 4,
      });
      db.query.mockResolvedValueOnce({
        rows: [{ user_id: TEST_TEACHER_USER_ID, custom_days: null, planner_days: null, hours_per_day: '6.00' }],
        rowCount: 1,
      });
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ month: '2026-09' });

      expect(res.status).toBe(200);
      expect(res.body.data.periods).toHaveLength(1);
      const [period] = res.body.data.periods;
      expect(period).toMatchObject({ payDate: '2026-09-25', startDate: '2026-08-26', endDate: '2026-09-25' });
      const [teacher] = period.teachers;
      // Two assumed-present days at the person's own 6h, one absence, one day still ahead.
      expect(teacher).toMatchObject({
        presentDays: 2,
        absentDays: 1,
        workingDays: 4,
        elapsedWorkingDays: 3,
        hoursPerDay: 6,
        hoursPerDaySource: 'custom',
        hoursWorked: 12,
      });
    });

    it('returns no periods when the school has no schedule', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);
      const res = await request(app).get(url).set('Authorization', `Bearer ${token}`).query({ month: '2026-09' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ schedule: null, periods: [] });
    });

    it('is admin-only', async () => {
      const token = mockTeacherUser();
      const res = await request(app).get(url).set('Authorization', `Bearer ${token}`).query({ month: '2026-09' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/teacher-attendance/me/:date and /:teacherId/:date', () => {
    it('lets me remove my own record for a day', async () => {
      const token = mockTeacherUser();
      const db = require('../../__mocks__/config/database');
      db.query.mockResolvedValueOnce({ rows: [{ teacher_id: TEST_TEACHER_USER_ID, attendance_date: '2026-09-10' }], rowCount: 1 });

      const res = await request(app).delete('/api/teacher-attendance/me/2026-09-10').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ teacherId: TEST_TEACHER_USER_ID, attendanceDate: '2026-09-10', deleted: true });
      const call = db.query.mock.calls.find((c) => c[0].includes('DELETE FROM teacher_attendance'));
      expect(call[1]).toEqual([TEST_TEACHER_USER_ID, '2026-09-10', TEST_SCHOOL]);
    });

    it('reports deleted: false when there was nothing recorded (an assumed-present day)', async () => {
      const token = mockTeacherUser();
      mockQueryResponse([]);
      const res = await request(app).delete('/api/teacher-attendance/me/2026-09-10').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(false);
    });

    it('rejects a malformed date', async () => {
      const token = mockTeacherUser();
      const res = await request(app).delete('/api/teacher-attendance/me/2026-9-1').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('lets an admin remove anyone\'s record, scoped to the admin\'s school', async () => {
      const token = mockAdminUser();
      const db = require('../../__mocks__/config/database');
      db.query.mockResolvedValueOnce({ rows: [{ teacher_id: TEST_TEACHER_USER_ID, attendance_date: '2026-09-10' }], rowCount: 1 });

      const res = await request(app)
        .delete(`/api/teacher-attendance/${TEST_TEACHER_USER_ID}/2026-09-10`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ teacherId: TEST_TEACHER_USER_ID, attendanceDate: '2026-09-10', deleted: true });
      const call = db.query.mock.calls.find((c) => c[0].includes('DELETE FROM teacher_attendance'));
      expect(call[1]).toEqual([TEST_TEACHER_USER_ID, '2026-09-10', TEST_SCHOOL]);
    });

    it('is admin-only for other people and validates the id', async () => {
      const teacher = mockTeacherUser();
      const forbidden = await request(app)
        .delete(`/api/teacher-attendance/${TEST_ADMIN_USER_ID}/2026-09-10`)
        .set('Authorization', `Bearer ${teacher}`);
      expect(forbidden.status).toBe(403);

      const admin = mockAdminUser();
      const bad = await request(app).delete('/api/teacher-attendance/not-a-uuid/2026-09-10').set('Authorization', `Bearer ${admin}`);
      expect(bad.status).toBe(404);
    });
  });

  describe('GET /api/teacher-attendance/me/pay-period', () => {
    it('returns my hours so far in the current period', async () => {
      const token = mockTeacherUser();
      const db = require('../../__mocks__/config/database');
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });
      db.query.mockResolvedValueOnce({
        rows: [{ teacher_id: TEST_TEACHER_USER_ID, first_name: 'Teacher', last_name: 'User', username: 'teacher', attendance_date: null }],
        rowCount: 1,
      });
      db.query.mockResolvedValueOnce({ rows: [{ day: '2026-09-08', is_elapsed: true }], rowCount: 1 });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });

      const res = await request(app).get('/api/teacher-attendance/me/pay-period').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.schedule.frequency).toBe('MONTHLY');
      expect(res.body.data.period.payDate).toMatch(/-25$/);
      expect(res.body.data.period.hoursWorked).toBe(7);
      expect(res.body.data.period.hoursPerDaySource).toBe('school');
    });

    it('returns null without a schedule', async () => {
      const token = mockTeacherUser();
      mockQueryResponse([]);
      const res = await request(app).get('/api/teacher-attendance/me/pay-period').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ schedule: null, period: null });
    });

    it('returns the period containing ?date= so a past pay day can be reviewed', async () => {
      const token = mockTeacherUser();
      const db = require('../../__mocks__/config/database');
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });
      db.query.mockResolvedValueOnce({
        rows: [
          { teacher_id: TEST_TEACHER_USER_ID, first_name: 'Teacher', last_name: 'User', username: 'teacher', attendance_date: '2026-08-10', status: 'ABSENT', notes: null, hours: null },
          { teacher_id: TEST_TEACHER_USER_ID, first_name: 'Teacher', last_name: 'User', username: 'teacher', attendance_date: '2026-08-11', status: 'PRESENT', notes: null, hours: null },
        ],
        rowCount: 2,
      });
      db.query.mockResolvedValueOnce({
        rows: [
          { day: '2026-08-10', is_elapsed: true },
          { day: '2026-08-11', is_elapsed: true },
        ],
        rowCount: 2,
      });
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      db.query.mockResolvedValueOnce({ rows: [payScheduleRow()], rowCount: 1 });

      const res = await request(app)
        .get('/api/teacher-attendance/me/pay-period')
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '2026-08-01' });

      expect(res.status).toBe(200);
      // Aug 1 falls in the period paid Aug 25 (Jul 26 – Aug 25), which is over.
      // (Before Sept 2026 nothing is assumed present, so both days are explicit.)
      expect(res.body.data.period).toMatchObject({
        payDate: '2026-08-25',
        startDate: '2026-07-26',
        endDate: '2026-08-25',
        throughDate: '2026-08-25',
        isComplete: true,
        presentDays: 1,
        absentDays: 1,
        hoursWorked: 7,
      });
      // The range queried is the period, not the month.
      const rangeCall = db.query.mock.calls.find((c) => Array.isArray(c[1]) && c[1].includes('2026-07-26'));
      expect(rangeCall).toBeDefined();
      expect(rangeCall[1]).toEqual(expect.arrayContaining(['2026-07-26', '2026-08-25']));
    });

    it('rejects a malformed ?date=', async () => {
      const token = mockTeacherUser();
      const res = await request(app)
        .get('/api/teacher-attendance/me/pay-period')
        .set('Authorization', `Bearer ${token}`)
        .query({ date: '2026/08/01' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('date must be YYYY-MM-DD');
    });
  });
});
