// Integration: part-time staff work days — admin overrides, schedule-planner
// inference, and their effect on assumed-present attendance and the dashboard
// check-in prompt.

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const SCHOOL = 'ALHAADIACADEMY';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440077';
// The default authenticatedRequest admin; seeded so updated_by's FK holds.
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
// September 2026: Tue 1 … Mon 14 have elapsed (ASSUMED_PRESENT_FROM is Sept 1).
const MONTH = '2026-09';

const asAdmin = (method, url) => authenticatedRequest(method, url);
const asTeacher = (method, url) =>
  authenticatedRequest(method, url, { role: 'TEACHER', userId: TEACHER_ID });

async function seed() {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
     SELECT 'ALHAADIACADEMY', school_id, '2026-2027', DATE '2026-09-01', DATE '2027-06-30', FALSE
     FROM schools WHERE school_code = 'ALHAADIACADEMY'`
  );
  await pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 'pt@test.com', 'parttime', 'x', 'Part', 'Timer', $2, 'TEACHER', true, true),
            ($3, 'admin@test.com', 'admin', 'x', 'Test', 'Admin', $2, 'ADMIN', true, true)`,
    [TEACHER_ID, SCHOOL, ADMIN_ID]
  );
}

const elapsedDays = (records) =>
  records.map((r) => String(r.attendanceDate).substring(0, 10)).filter((d) => d <= '2026-09-14');

const findTeacher = (res) => res.body.data.teachers.find((t) => t.teacherId === TEACHER_ID);

describe('Integration: staff work days', () => {
  it('assumes every weekday present when no work days are known', async () => {
    await seed();
    const res = await asTeacher('get', `/api/teacher-attendance/me?month=${MONTH}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workDaysSource).toBe('default');
    expect(res.body.data.workDays).toEqual([1, 2, 3, 4, 5]);
    // Sept 1–14 weekdays: 1,2,3,4 + 7,8,9,10,11 + 14
    expect(elapsedDays(res.body.data.records)).toHaveLength(10);
  });

  it('infers work days from the linked planner teacher', async () => {
    await seed();
    const pool = getTestPool();
    const { rows } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = $1 AND label = '2026-2027'`,
      [SCHOOL]
    );
    await pool.query(
      `INSERT INTO planner_teachers (school, user_id, display_name, allowed_days, school_year_id)
       VALUES ($1, $2, 'Sadiq/Narges', '[3,5]'::jsonb, $3)`,
      [SCHOOL, TEACHER_ID, rows[0].school_year_id]
    );

    const res = await asAdmin('get', `/api/teacher-attendance?school=${SCHOOL}&month=${MONTH}`);
    const teacher = findTeacher(res);
    expect(teacher.workDaysSource).toBe('planner');
    expect(teacher.workDays).toEqual([3, 5]);
    // Wednesdays and Fridays only: Sept 2, 4, 9, 11
    expect(elapsedDays(teacher.records)).toEqual(['2026-09-02', '2026-09-04', '2026-09-09', '2026-09-11']);
  });

  it('lets an admin override work days, keeps real check-ins on off days, and resets', async () => {
    await seed();
    const put = await asAdmin('put', `/api/teacher-attendance/work-days/${TEACHER_ID}`).send({
      workDays: [5, 3, 3],
    });
    expect(put.status).toBe(200);
    expect(put.body.data.workDays).toEqual([3, 5]);

    // Covering a Monday shift: a real check-in on an off day still counts.
    await asTeacher('post', '/api/teacher-attendance/checkin').send({
      status: 'PRESENT',
      date: '2026-09-07',
    });

    const me = await asTeacher('get', `/api/teacher-attendance/me?month=${MONTH}`);
    expect(me.body.data.workDaysSource).toBe('custom');
    expect(elapsedDays(me.body.data.records)).toEqual([
      '2026-09-02', '2026-09-04', '2026-09-07', '2026-09-09', '2026-09-11',
    ]);
    // Working days count only their scheduled days (Wed/Fri in Sept 2026 = 9)
    expect(me.body.data.workingDays).toBe(9);

    const del = await asAdmin('delete', `/api/teacher-attendance/work-days/${TEACHER_ID}`);
    expect(del.status).toBe(200);
    const after = await asTeacher('get', `/api/teacher-attendance/me?month=${MONTH}`);
    expect(after.body.data.workDaysSource).toBe('default');
  });

  it('reports whether a check-in is expected today', async () => {
    await seed();
    await asAdmin('put', `/api/teacher-attendance/work-days/${TEACHER_ID}`).send({ workDays: [3, 5] });

    const wednesday = await asTeacher('get', '/api/teacher-attendance/today?date=2026-09-09');
    expect(wednesday.body.data.expected).toBe(true);
    const monday = await asTeacher('get', '/api/teacher-attendance/today?date=2026-09-14');
    expect(monday.body.data.expected).toBe(false);
  });

  it('validates input and restricts overrides to admins', async () => {
    await seed();
    const bad = await asAdmin('put', `/api/teacher-attendance/work-days/${TEACHER_ID}`).send({ workDays: [] });
    expect(bad.status).toBe(400);
    const outOfRange = await asAdmin('put', `/api/teacher-attendance/work-days/${TEACHER_ID}`).send({ workDays: [8] });
    expect(outOfRange.status).toBe(400);
    const unknown = await asAdmin(
      'put',
      '/api/teacher-attendance/work-days/00000000-0000-0000-0000-000000000000'
    ).send({ workDays: [1] });
    expect(unknown.status).toBe(404);
    const forbidden = await asTeacher('put', `/api/teacher-attendance/work-days/${TEACHER_ID}`).send({
      workDays: [1],
    });
    expect(forbidden.status).toBe(403);
  });
});
