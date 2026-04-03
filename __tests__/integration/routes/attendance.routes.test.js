jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Integration: Attendance Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEACHER_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
    );
  });

  // Helper to seed students
  const seedStudents = async () => {
    const { rows: s1 } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Alice', 'ALHAADIACADEMY', '5') RETURNING student_id`
    );
    const { rows: s2 } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Bob', 'ALHAADIACADEMY', '5') RETURNING student_id`
    );
    return [s1[0].student_id, s2[0].student_id];
  };

  // Helper to seed a class
  const seedClass = async () => {
    const { rows: termRows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`
    );
    const { rows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', 5, 'Math', 'Teacher One', $1, $2, 'Term 1') RETURNING class_id`,
      [TEACHER_USER_ID, termRows[0].term_id]
    );
    return rows[0].class_id;
  };

  describe('POST /api/attendance/general', () => {
    it('submits general attendance for multiple students', async () => {
      const [studentId1, studentId2] = await seedStudents();

      const res = await authenticatedRequest('post', '/api/attendance/general')
        .send({
          attendanceDate: '2025-10-15',
          school: 'ALHAADIACADEMY',
          entries: [
            { studentId: studentId1, status: 'PRESENT' },
            { studentId: studentId2, status: 'ABSENT' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query(
        'SELECT * FROM general_attendance WHERE attendance_date = $1',
        ['2025-10-15']
      );
      expect(dbResult.rows).toHaveLength(2);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/attendance/general')
        .send({ attendanceDate: '2025-10-15' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('returns 400 when entries is not an array', async () => {
      const res = await authenticatedRequest('post', '/api/attendance/general')
        .send({
          attendanceDate: '2025-10-15',
          school: 'ALHAADIACADEMY',
          entries: 'not an array',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/attendance/general?date=&school=', () => {
    it('returns general attendance for a date and school', async () => {
      const [studentId1, studentId2] = await seedStudents();

      await pool.query(
        `INSERT INTO general_attendance (student_id, attendance_date, status, school)
         VALUES ($1, '2025-10-15', 'PRESENT', 'ALHAADIACADEMY'),
                ($2, '2025-10-15', 'ABSENT', 'ALHAADIACADEMY')`,
        [studentId1, studentId2]
      );

      const res = await authenticatedRequest('get', '/api/attendance/general?date=2025-10-15&school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toHaveProperty('studentId');
      expect(res.body.data[0]).toHaveProperty('status');
    });

    it('returns 400 when date is missing', async () => {
      const res = await authenticatedRequest('get', '/api/attendance/general?school=ALHAADIACADEMY');

      expect(res.status).toBe(400);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/attendance/general?date=2025-10-15');

      expect(res.status).toBe(400);
    });

    it('returns empty array for a date with no attendance', async () => {
      const res = await authenticatedRequest('get', '/api/attendance/general?date=2025-01-01&school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('POST /api/attendance/class', () => {
    it('submits class attendance for multiple students', async () => {
      const classId = await seedClass();
      const [studentId1, studentId2] = await seedStudents();

      // Enroll students
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2), ($1, $3)', [classId, studentId1, studentId2]);

      const res = await authenticatedRequest('post', '/api/attendance/class')
        .send({
          classId,
          attendanceDate: '2025-10-15',
          entries: [
            { studentId: studentId1, status: 'PRESENT' },
            { studentId: studentId2, status: 'LATE' },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query(
        'SELECT * FROM class_attendance WHERE class_id = $1 AND attendance_date = $2',
        [classId, '2025-10-15']
      );
      expect(dbResult.rows).toHaveLength(2);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/attendance/class')
        .send({ classId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/attendance/class/:classId?date=', () => {
    it('returns class attendance for a date', async () => {
      const classId = await seedClass();
      const [studentId1] = await seedStudents();

      await pool.query(
        `INSERT INTO class_attendance (class_id, student_id, attendance_date, status)
         VALUES ($1, $2, '2025-10-15', 'PRESENT')`,
        [classId, studentId1]
      );

      const res = await authenticatedRequest('get', `/api/attendance/class/${classId}?date=2025-10-15`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].studentId).toBe(studentId1);
      expect(res.body.data[0].status).toBe('PRESENT');
    });

    it('returns 400 when date is missing', async () => {
      const classId = await seedClass();

      const res = await authenticatedRequest('get', `/api/attendance/class/${classId}`);

      expect(res.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/attendance/general?date=2025-10-15&school=ALHAADIACADEMY');

      expect(res.status).toBe(401);
    });
  });
});
