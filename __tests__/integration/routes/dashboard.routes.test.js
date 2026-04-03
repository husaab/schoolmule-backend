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

describe('Integration: Dashboard Routes', () => {
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

  // Helper to seed data for dashboard
  const seedDashboardData = async () => {
    // Seed students
    await pool.query(
      `INSERT INTO students (name, school, grade) VALUES
       ('Alice', 'ALHAADIACADEMY', '5'),
       ('Bob', 'ALHAADIACADEMY', '5'),
       ('Charlie', 'ALHAADIACADEMY', '3')`
    );

    // Seed a term
    const { rows: termRows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true) RETURNING term_id`
    );

    // Seed a class
    await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', 5, 'Math', 'Teacher One', $1, $2, 'Term 1 2025-2026')`,
      [TEACHER_USER_ID, termRows[0].term_id]
    );
  };

  describe('GET /api/dashboard/summary', () => {
    it('returns dashboard summary with all expected fields', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/summary?school=ALHAADIACADEMY&term=Term 1 2025-2026&date=2025-10-15');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('totalStudents');
      expect(res.body.data).toHaveProperty('totalTeachers');
      expect(res.body.data).toHaveProperty('totalClasses');
      expect(res.body.data).toHaveProperty('todaysAttendance');
      expect(res.body.data).toHaveProperty('weeklyAttendance');
      expect(res.body.data).toHaveProperty('monthlyAttendance');
      expect(res.body.data).toHaveProperty('reportCardsCount');
      expect(res.body.data).toHaveProperty('avgClassSize');
    });

    it('returns correct student count', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/summary?school=ALHAADIACADEMY&term=Term 1 2025-2026&date=2025-10-15');

      expect(res.status).toBe(200);
      // 3 students were seeded
      expect(parseInt(res.body.data.totalStudents)).toBe(3);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/summary?term=Term 1&date=2025-10-15');

      expect(res.status).toBe(400);
    });

    it('returns 400 when term is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/summary?school=ALHAADIACADEMY&date=2025-10-15');

      expect(res.status).toBe(400);
    });

    it('returns 400 when date is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/summary?school=ALHAADIACADEMY&term=Term 1');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/dashboard/attendance/today', () => {
    it('returns today attendance rate', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/attendance/today?school=ALHAADIACADEMY&date=2025-10-15');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('rate');
      expect(typeof res.body.data.rate).toBe('number');
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/attendance/today?date=2025-10-15');

      expect(res.status).toBe(400);
    });

    it('returns 400 when date is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/attendance/today?school=ALHAADIACADEMY');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/dashboard/attendance/weekly', () => {
    it('returns weekly attendance rate', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/attendance/weekly?school=ALHAADIACADEMY&endDate=2025-10-15');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('rate');
    });

    it('returns 400 when endDate is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/attendance/weekly?school=ALHAADIACADEMY');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/dashboard/attendance/monthly', () => {
    it('returns monthly attendance rate', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/attendance/monthly?school=ALHAADIACADEMY&referenceDate=2025-10-15');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('rate');
    });

    it('returns 400 when referenceDate is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/attendance/monthly?school=ALHAADIACADEMY');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/dashboard/attendance/trend', () => {
    it('returns attendance trend data', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/attendance/trend?school=ALHAADIACADEMY&days=7&endDate=2025-10-15');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(7);
      expect(res.body.data[0]).toHaveProperty('date');
      expect(res.body.data[0]).toHaveProperty('rate');
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/attendance/trend');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/dashboard/financial', () => {
    it('returns financial overview', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('get', '/api/dashboard/financial?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('totalRevenue');
      expect(res.body.data).toHaveProperty('totalOutstanding');
      expect(res.body.data).toHaveProperty('statusCounts');
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/dashboard/financial');

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/dashboard/refresh-grade-cache', () => {
    it('refreshes grade cache for a school', async () => {
      await seedDashboardData();

      const res = await authenticatedRequest('post', '/api/dashboard/refresh-grade-cache?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body).toHaveProperty('data');
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('post', '/api/dashboard/refresh-grade-cache');

      expect(res.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/dashboard/summary?school=ALHAADIACADEMY&term=Term 1&date=2025-10-15');

      expect(res.status).toBe(401);
    });
  });
});
