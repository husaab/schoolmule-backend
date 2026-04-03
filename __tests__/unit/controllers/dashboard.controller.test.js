const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/dashboard/summary ─────────────────────────────────
describe('GET /api/dashboard/summary', () => {
  const url = '/api/dashboard/summary';

  it('returns dashboard summary data', async () => {
    // The controller runs 8 parallel DB queries + getSchoolAverageGrade
    // getSchoolAverageGrade internally runs 3 queries (enrollments, assessments, scores)
    // Total: 8 + 3 = 11 mockQueryResponse calls needed

    // selectTotalStudents
    mockQueryResponse([{ count: 120 }]);
    // selectTotalTeachers
    mockQueryResponse([{ count: 15 }]);
    // selectTotalClasses
    mockQueryResponse([{ count: 30 }]);
    // selectTodaysAttendanceRate
    mockQueryResponse([{ rate: 0.92 }]);
    // selectWeeklyAttendanceRate
    mockQueryResponse([{ rate: 0.89 }]);
    // selectMonthlyAttendanceRate
    mockQueryResponse([{ rate: 0.91 }]);
    // selectReportCardsCount
    mockQueryResponse([{ count: 100 }]);
    // selectAverageClassSize
    mockQueryResponse([{ avg_class_size: 25.5 }]);
    // getSchoolAverageGrade -> calculateSchoolAverageGrade:
    // selectStudentClassEnrollments
    mockQueryResponse([{ student_id: 's1', class_id: 'c1' }]);
    // selectAssessmentsBySchool
    mockQueryResponse([{
      assessment_id: 'a1',
      class_id: 'c1',
      weight_percent: 100,
      weight_points: 100,
      max_score: 100,
      is_parent: false,
      parent_assessment_id: null,
    }]);
    // selectStudentScoresBySchool
    mockQueryResponse([{
      student_id: 's1',
      class_id: 'c1',
      assessment_id: 'a1',
      score: 85,
      is_excluded: false,
    }]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, term: 'Term 1 2025-2026', date: '2025-10-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('totalStudents');
    expect(res.body.data).toHaveProperty('totalTeachers');
    expect(res.body.data).toHaveProperty('totalClasses');
    expect(res.body.data).toHaveProperty('todaysAttendance');
    expect(res.body.data).toHaveProperty('weeklyAttendance');
    expect(res.body.data).toHaveProperty('monthlyAttendance');
    expect(res.body.data).toHaveProperty('averageStudentGrade');
    expect(res.body.data).toHaveProperty('reportCardsCount');
    expect(res.body.data).toHaveProperty('avgClassSize');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ term: 'Term 1', date: '2025-10-15' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('school');
  });

  it('returns 400 when term is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, date: '2025-10-15' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('term');
  });

  it('returns 400 when date is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, term: 'Term 1 2025-2026' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('date');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, term: 'Term 1', date: '2025-10-15' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .get(url)
      .query({ school: TEST_SCHOOL, term: 'Term 1', date: '2025-10-15' });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/dashboard/attendance/today ────────────────────────
describe('GET /api/dashboard/attendance/today', () => {
  const url = '/api/dashboard/attendance/today';

  it('returns today attendance rate', async () => {
    mockQueryResponse([{ rate: 0.95 }]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, date: '2025-10-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('rate');
    expect(typeof res.body.data.rate).toBe('number');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ date: '2025-10-15' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 400 when date is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, date: '2025-10-15' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/dashboard/attendance/weekly ───────────────────────
describe('GET /api/dashboard/attendance/weekly', () => {
  const url = '/api/dashboard/attendance/weekly';

  it('returns weekly attendance rate', async () => {
    mockQueryResponse([{ rate: 0.88 }]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, endDate: '2025-10-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('rate');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ endDate: '2025-10-15' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when endDate is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/dashboard/attendance/monthly ──────────────────────
describe('GET /api/dashboard/attendance/monthly', () => {
  const url = '/api/dashboard/attendance/monthly';

  it('returns monthly attendance rate', async () => {
    mockQueryResponse([{ rate: 0.90 }]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, referenceDate: '2025-10-15' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('rate');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ referenceDate: '2025-10-15' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when referenceDate is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/dashboard/attendance/trend ────────────────────────
describe('GET /api/dashboard/attendance/trend', () => {
  const url = '/api/dashboard/attendance/trend';

  it('returns attendance trend data', async () => {
    const rows = [
      { date: '2025-10-09', rate: 0.90 },
      { date: '2025-10-10', rate: 0.92 },
      { date: '2025-10-11', rate: 0.88 },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, days: 3, endDate: '2025-10-11' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toHaveProperty('date');
    expect(res.body.data[0]).toHaveProperty('rate');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/dashboard/financial ───────────────────────────────
describe('GET /api/dashboard/financial', () => {
  const url = '/api/dashboard/financial';

  it('returns financial overview data', async () => {
    // selectTotalRevenue
    mockQueryResponse([{ total_revenue: 50000 }]);
    // selectTotalOutstanding
    mockQueryResponse([{ total_outstanding: 12000 }]);
    // selectInvoiceStatusCounts
    mockQueryResponse([
      { status: 'pending', count: 10 },
      { status: 'paid', count: 50 },
      { status: 'overdue', count: 5 },
    ]);
    // selectStudentsWithInvoices
    mockQueryResponse([{ count: 80 }]);
    // selectMonthlyRevenueTrends
    mockQueryResponse([
      { month: '2025-09', revenue: 15000, invoice_count: 20 },
      { month: '2025-10', revenue: 18000, invoice_count: 25 },
    ]);
    // selectAveragePayment
    mockQueryResponse([{ average_payment: 500 }]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('totalRevenue');
    expect(res.body.data).toHaveProperty('totalOutstanding');
    expect(res.body.data).toHaveProperty('statusCounts');
    expect(res.body.data.statusCounts).toHaveProperty('pending');
    expect(res.body.data.statusCounts).toHaveProperty('paid');
    expect(res.body.data.statusCounts).toHaveProperty('overdue');
    expect(res.body.data.statusCounts).toHaveProperty('cancelled');
    expect(res.body.data).toHaveProperty('studentsWithInvoices');
    expect(res.body.data).toHaveProperty('monthlyTrends');
    expect(res.body.data).toHaveProperty('averagePayment');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/dashboard/refresh-grade-cache ────────────────────
describe('POST /api/dashboard/refresh-grade-cache', () => {
  const url = '/api/dashboard/refresh-grade-cache';

  it('refreshes grade cache successfully', async () => {
    // calculateSchoolAverageGrade queries:
    // selectStudentClassEnrollments
    mockQueryResponse([{ student_id: 's1', class_id: 'c1' }]);
    // selectAssessmentsBySchool
    mockQueryResponse([{
      assessment_id: 'a1',
      class_id: 'c1',
      weight_percent: 100,
      weight_points: 100,
      max_score: 100,
      is_parent: false,
      parent_assessment_id: null,
    }]);
    // selectStudentScoresBySchool
    mockQueryResponse([{
      student_id: 's1',
      class_id: 'c1',
      assessment_id: 'a1',
      score: 90,
      is_excluded: false,
    }]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('cache refreshed');
    expect(res.body.data).toHaveProperty('averageStudentGrade');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns null average when no enrollments', async () => {
    // selectStudentClassEnrollments returns empty
    mockQueryResponse([]);
    // selectAssessmentsBySchool
    mockQueryResponse([]);
    // selectStudentScoresBySchool
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.data.averageStudentGrade).toBeNull();
  });
});
