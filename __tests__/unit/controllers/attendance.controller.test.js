const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildGeneralAttendanceRow, buildClassAttendanceRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

// The class guard looks the class up first (requireClassOwnership).
const mockClass = () => mockQueryResponse([{ class_id: 'class-123', school: TEST_SCHOOL, teacher_id: 'someone', is_co_teacher: false }]);

// Attendance routes are behind verifyUser middleware (mounted after app.use(verifyUser))
const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── POST /api/attendance/general ───────────────────────────────
describe('POST /api/attendance/general', () => {
  const url = '/api/attendance/general';

  it('records general attendance successfully', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        attendanceDate: '2025-10-15',
        entries: [
          { studentId: 'student-1', status: 'PRESENT' },
          { studentId: 'student-2', status: 'ABSENT' },
        ],
        school: TEST_SCHOOL,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toBe('Attendance recorded');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ attendanceDate: '2025-10-15' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Missing required fields');
  });

  it('returns 400 when entries is not an array', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        attendanceDate: '2025-10-15',
        entries: 'not-an-array',
        school: TEST_SCHOOL,
      });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('Connection failed');

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        attendanceDate: '2025-10-15',
        entries: [{ studentId: 's1', status: 'PRESENT' }],
        school: TEST_SCHOOL,
      });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toBe('Database error');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .post(url)
      .send({ attendanceDate: '2025-10-15', entries: [], school: TEST_SCHOOL });

    expect(res.status).toBe(401);
  });
});

// ─── POST /api/attendance/class ─────────────────────────────────
describe('POST /api/attendance/class', () => {
  const url = '/api/attendance/class';

  it('records class attendance successfully', async () => {
    mockClass();
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        classId: 'class-123',
        attendanceDate: '2025-10-15',
        entries: [
          { studentId: 'student-1', status: 'PRESENT' },
          { studentId: 'student-2', status: 'LATE' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toBe('Class attendance recorded');
  });

  it('returns 400 when required fields are missing', async () => {
    mockClass();
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ classId: 'class-123' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockClass();
    mockQueryError('DB error');

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        classId: 'class-123',
        attendanceDate: '2025-10-15',
        entries: [{ studentId: 's1', status: 'PRESENT' }],
      });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/attendance/general ────────────────────────────────
describe('GET /api/attendance/general', () => {
  const url = '/api/attendance/general';

  it('returns general attendance by date', async () => {
    const rows = [
      buildGeneralAttendanceRow({ student_id: 'student-1', status: 'PRESENT' }),
      buildGeneralAttendanceRow({ student_id: 'student-2', status: 'ABSENT' }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ date: '2025-10-15', school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('studentId');
    expect(res.body.data[0]).toHaveProperty('status');
  });

  it('returns 400 when date is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it("reads the caller's school, never the query's", async () => {
    mockQueryResponse([]);
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ date: '2025-10-15', school: 'PLAYGROUND' });

    expect(res.status).toBe(200);
    const db = require('../../__mocks__/config/database');
    const call = db.query.mock.calls.find(([sql]) => /general_attendance/.test(sql));
    expect(call[1]).toEqual(['2025-10-15', TEST_SCHOOL]);
  });

  it('returns empty array when no attendance records', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ date: '2025-10-15', school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ date: '2025-10-15', school: TEST_SCHOOL });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/attendance/class/:classId ─────────────────────────
describe('GET /api/attendance/class/:classId', () => {
  it('returns class attendance by date', async () => {
    mockClass();
    const rows = [
      buildClassAttendanceRow({ student_id: 's1', status: 'PRESENT' }),
      buildClassAttendanceRow({ student_id: 's2', status: 'LATE' }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/attendance/class/class-123')
      .set(authHeader())
      .query({ date: '2025-10-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('studentId');
  });

  it('returns 400 when date query param is missing', async () => {
    mockClass();
    const res = await request(app)
      .get('/api/attendance/class/class-123')
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockClass();
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/attendance/class/class-123')
      .set(authHeader())
      .query({ date: '2025-10-15' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

describe('RBAC on attendance', () => {
  const { giveRole } = require('../../helpers/mockAccess');
  const { TEST_ADMIN_USER_ID, mockTeacherUser } = require('../../helpers/mockAuth');

  it('lets office staff with attendance.classes mark a class they do not teach', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['attendance.daily', 'attendance.classes']);
    mockClass();
    mockQueryResponse([]);
    const res = await request(app).post('/api/attendance/class').set(authHeader())
      .send({ classId: 'class-123', attendanceDate: '2025-10-15', entries: [] });
    expect(res.status).toBe(200);
  });

  it("keeps a teacher out of another teacher's class attendance", async () => {
    mockClass();
    const res = await request(app).get('/api/attendance/class/class-123').set({ Authorization: `Bearer ${mockTeacherUser()}` }).query({ date: '2025-10-15' });
    expect(res.status).toBe(403);
  });

  it('needs attendance.daily for general attendance', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['attendance.classes']);
    const res = await request(app).get('/api/attendance/general').set(authHeader()).query({ date: '2025-10-15' });
    expect(res.status).toBe(403);
  });
});
