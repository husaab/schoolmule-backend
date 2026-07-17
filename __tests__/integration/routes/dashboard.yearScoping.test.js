jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

describe('dashboard metrics are year-scoped', () => {
  let pool, schoolId, year25, year26;

  beforeAll(async () => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    // setupTestDB's global beforeEach already seeds a baseline ALHAADIACADEMY
    // row (+ active school_year via trigger); look it up rather than
    // inserting a fresh school row.
    const { rows } = await pool.query(
      `SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    schoolId = rows[0].school_id;

    await pool.query(`DELETE FROM school_years WHERE school = 'ALHAADIACADEMY'`);
    const y = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active) VALUES
       ('ALHAADIACADEMY', $1, '2025-2026', '2025-09-01', '2026-06-30', TRUE),
       ('ALHAADIACADEMY', $1, '2026-2027', '2026-09-01', '2027-06-30', FALSE)
       RETURNING school_year_id, label`, [schoolId]);
    year25 = y.rows.find(r => r.label === '2025-2026').school_year_id;
    year26 = y.rows.find(r => r.label === '2026-2027').school_year_id;

    // Two students, one per year
    const s = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES
       ('Old Kid', '3', 'ALHAADIACADEMY', $1),
       ('New Kid', '4', 'ALHAADIACADEMY', $2)
       RETURNING student_id, name`, [year25, year26]);
    const oldKidId = s.rows.find(r => r.name === 'Old Kid').student_id;
    const newKidId = s.rows.find(r => r.name === 'New Kid').student_id;

    // Attendance on the same date for both students (different years)
    await pool.query(
      `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES
       ($1, '2025-10-15', 'PRESENT', 'ALHAADIACADEMY'),
       ($2, '2025-10-15', 'PRESENT', 'ALHAADIACADEMY')`,
      [oldKidId, newKidId]
    );

    // Report cards for the same term name in both years
    await pool.query(
      `INSERT INTO report_cards (student_id, term, school) VALUES
       ($1, 'Term 1', 'ALHAADIACADEMY'),
       ($2, 'Term 1', 'ALHAADIACADEMY')`,
      [oldKidId, newKidId]
    );
  });

  it('GET /api/dashboard/attendance/trend excludes the other year\'s students from the denominator', async () => {
    const res25 = await authenticatedRequest('get', '/api/dashboard/attendance/trend?days=1&endDate=2025-10-15')
      .set('X-School-Year', year25);
    expect(res25.status).toBe(200);
    // Only "Old Kid" (year25) counts toward the denominator, and they were
    // present, so rate should be 1 (not 0.5, which would mean New Kid's
    // year26 enrollment leaked into the total).
    expect(res25.body.data).toHaveLength(1);
    expect(res25.body.data[0].rate).toBe(1);

    const res26 = await authenticatedRequest('get', '/api/dashboard/attendance/trend?days=1&endDate=2025-10-15')
      .set('X-School-Year', year26);
    expect(res26.status).toBe(200);
    expect(res26.body.data[0].rate).toBe(1);
  });

  it('GET /api/dashboard/summary counts report cards only for the selected year', async () => {
    const res25 = await authenticatedRequest('get', '/api/dashboard/summary?term=Term 1&date=2025-10-15')
      .set('X-School-Year', year25);
    expect(res25.status).toBe(200);
    expect(parseInt(res25.body.data.reportCardsCount)).toBe(1);

    const res26 = await authenticatedRequest('get', '/api/dashboard/summary?term=Term 1&date=2025-10-15')
      .set('X-School-Year', year26);
    expect(res26.status).toBe(200);
    expect(parseInt(res26.body.data.reportCardsCount)).toBe(1);
  });
});

describe('dashboard metrics for a tenant with no school_years rows', () => {
  let pool, schoolId, studentId, classId;

  beforeAll(async () => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    const { rows } = await pool.query(
      `SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    schoolId = rows[0].school_id;

    // Simulate a tenant that has never been migrated onto school years:
    // no school_years rows at all, and all year-scoped columns NULL.
    // This is different from the "existing years but none active" case —
    // here resolveSchoolYear finds nothing at all and sets req.schoolYear
    // to null (GET requests proceed with no year filter).
    await pool.query(`DELETE FROM school_years WHERE school = 'ALHAADIACADEMY'`);

    const teacher = await pool.query(
      `INSERT INTO users (username, email, password, first_name, last_name, role, school, is_verified, is_verified_school)
       VALUES ('Teacher One', 'teacher-noyear@test.com', 'hashed', 'Teacher', 'One', 'TEACHER', 'ALHAADIACADEMY', true, true)
       RETURNING user_id`
    );
    const teacherId = teacher.rows[0].user_id;

    const s = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES
       ('Yearless Kid', '5', 'ALHAADIACADEMY', NULL)
       RETURNING student_id`
    );
    studentId = s.rows[0].student_id;

    const c = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id) VALUES
       ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, NULL)
       RETURNING class_id`,
      [teacherId]
    );
    classId = c.rows[0].class_id;

    await pool.query(
      `INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`,
      [classId, studentId]
    );

    await pool.query(
      `INSERT INTO general_attendance (student_id, attendance_date, status, school) VALUES
       ($1, '2025-10-15', 'PRESENT', 'ALHAADIACADEMY')`,
      [studentId]
    );

    await pool.query(
      `INSERT INTO report_cards (student_id, term, school) VALUES
       ($1, 'Term 1', 'ALHAADIACADEMY')`,
      [studentId]
    );
  });

  it('GET /api/dashboard/summary returns the school\'s aggregate data, not zeros, with no X-School-Year header', async () => {
    const res = await authenticatedRequest('get', '/api/dashboard/summary?term=Term 1&date=2025-10-15');
    expect(res.status).toBe(200);
    expect(parseInt(res.body.data.totalStudents)).toBe(1);
    expect(parseInt(res.body.data.totalClasses)).toBe(1);
    expect(parseInt(res.body.data.reportCardsCount)).toBe(1);
    expect(res.body.data.todaysAttendance).toBe(1);
  });

  it('GET /api/dashboard/attendance/trend includes the yearless student in the denominator', async () => {
    const res = await authenticatedRequest('get', '/api/dashboard/attendance/trend?days=1&endDate=2025-10-15');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].rate).toBe(1);
  });
});
