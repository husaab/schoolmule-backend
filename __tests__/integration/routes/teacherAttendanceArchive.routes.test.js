// Integration: archived staff and attendance. An archived account is left out
// of the month view and gets no assumed-present days, but still shows up in a
// range where they have real check-ins so past pay periods stay complete.

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const SCHOOL = 'ALHAADIACADEMY';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440077';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
// September 2026: Tue 1 … Mon 14 have elapsed (ASSUMED_PRESENT_FROM is Sept 1).
const MONTH = '2026-09';

const asAdmin = (method, url) => authenticatedRequest(method, url);
const findTeacher = (res) => res.body.data.teachers.find((t) => t.teacherId === TEACHER_ID);

async function seed({ archived }) {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
     SELECT 'ALHAADIACADEMY', school_id, '2026-2027', DATE '2026-09-01', DATE '2027-06-30', FALSE
     FROM schools WHERE school_code = 'ALHAADIACADEMY'`
  );
  await pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
     VALUES ($1, 'gone@test.com', 'gone', 'x', 'Gone', 'Teacher', $2, 'TEACHER', true, $4, $3),
            ($5, 'admin@test.com', 'admin', 'x', 'Test', 'Admin', $2, 'ADMIN', true, true, false)`,
    [TEACHER_ID, SCHOOL, archived, !archived, ADMIN_ID]
  );
  return pool;
}

describe('Integration: archived staff attendance', () => {
  it('lists an active teacher with assumed-present days', async () => {
    await seed({ archived: false });
    const res = await asAdmin('get', `/api/teacher-attendance?school=${SCHOOL}&month=${MONTH}`);
    expect(res.status).toBe(200);
    expect(findTeacher(res)).toBeDefined();
    expect(findTeacher(res).records.length).toBeGreaterThan(0);
  });

  it('hides an archived teacher with no records in the range', async () => {
    await seed({ archived: true });
    const res = await asAdmin('get', `/api/teacher-attendance?school=${SCHOOL}&month=${MONTH}`);
    expect(res.status).toBe(200);
    expect(findTeacher(res)).toBeUndefined();
  });

  it('keeps an archived teacher where they have real records, without assumed days', async () => {
    const pool = await seed({ archived: true });
    await pool.query(
      `INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school)
       VALUES ($1, DATE '2026-09-02', 'PRESENT', $2)`,
      [TEACHER_ID, SCHOOL]
    );

    const res = await asAdmin('get', `/api/teacher-attendance?school=${SCHOOL}&month=${MONTH}`);
    const teacher = findTeacher(res);
    expect(teacher).toBeDefined();
    expect(teacher.records.map((r) => String(r.attendanceDate).substring(0, 10))).toEqual(['2026-09-02']);
  });

  it('refuses admin edits to an archived teacher', async () => {
    await seed({ archived: true });
    const res = await asAdmin('put', `/api/teacher-attendance/work-days/${TEACHER_ID}`).send({ workDays: [1] });
    expect(res.status).toBe(404);
  });
});
