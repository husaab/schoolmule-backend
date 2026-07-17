const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

describe('school year rollover', () => {
  let pool, schoolId, year25, year26, gradKid, movingKid;

  beforeAll(async () => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    // setupTestDB's global beforeEach already seeds a baseline ALHAADIACADEMY
    // row (+ active school_year via trigger) and TRUNCATEs every other table;
    // look the school up fresh each test rather than caching from beforeAll,
    // since TRUNCATE regenerates a new school_id every time.
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
    // update created_from so preview/execute know the source
    await pool.query(`UPDATE school_years SET created_from_year_id = $1 WHERE school_year_id = $2`, [year25, year26]);

    // teacher_id is NOT NULL / FK'd on classes, so seed a teacher user.
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [TEACHER_USER_ID]
    );

    const s = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES
       ('Grad Kid', '8', 'ALHAADIACADEMY', $1),
       ('Moving Kid', 'JK', 'ALHAADIACADEMY', $1)
       RETURNING student_id, name`, [year25]);
    gradKid = s.rows.find(r => r.name === 'Grad Kid').student_id;
    movingKid = s.rows.find(r => r.name === 'Moving Kid').student_id;
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_name, parent_email, relation, school)
       VALUES ($1, 'Mom Kid', 'mom@x.com', 'MOTHER', 'ALHAADIACADEMY')`, [movingKid]);
    await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id) VALUES
       ('ALHAADIACADEMY', 'JK', 'Math', 'Ms T', $1, $2)`, [TEACHER_USER_ID, year25]);
  });

  it('preview proposes advanced grades and flags graduates', async () => {
    const res = await authenticatedRequest('get', `/api/school-years/rollover/preview?sourceYearId=${year25}`);
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.students.map(s => [s.name, s]));
    expect(byName['Moving Kid']).toMatchObject({ grade: 'JK', proposedGrade: 'SK', isGraduating: false });
    expect(byName['Grad Kid']).toMatchObject({ grade: '8', proposedGrade: null, isGraduating: true });
    expect(res.body.data.classes).toHaveLength(1);
  });

  it('executes a full rollover in one transaction', async () => {
    const res = await authenticatedRequest('post', `/api/school-years/${year26}/rollover`)
      .send({
        students: { mode: 'rollover', excludeStudentIds: [], gradeOverrides: {} },
        classes:  { mode: 'duplicate', excludeClassIds: [] },
        terms:    [{ name: 'Term 1', startDate: '2026-09-01', endDate: '2027-01-31' }],
        copyPlanner: false,
        copyCalendar: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ termsCreated: 1, studentsRolled: 1, studentsGraduated: 1, classesCreated: 1 });

    const rolled = await pool.query(
      `SELECT student_id, name, grade::text, previous_student_id FROM students WHERE school_year_id = $1`, [year26]);
    expect(rolled.rows).toHaveLength(1);
    expect(rolled.rows[0]).toMatchObject({ name: 'Moving Kid', grade: 'SK', previous_student_id: movingKid });

    const links = await pool.query(
      `SELECT parent_email FROM parent_students WHERE student_id = $1`,
      [rolled.rows[0].student_id]);
    expect(links.rows[0].parent_email).toBe('mom@x.com');

    const classes = await pool.query(
      `SELECT subject, school_year_id FROM classes WHERE school_year_id = $1`, [year26]);
    expect(classes.rows).toHaveLength(1);
    const roster = await pool.query(
      `SELECT count(*)::int AS n FROM class_students cs JOIN classes c ON c.class_id = cs.class_id WHERE c.school_year_id = $1`, [year26]);
    expect(roster.rows[0].n).toBe(0); // empty rosters
  });

  it('is idempotent for students', async () => {
    const body = {
      students: { mode: 'rollover', excludeStudentIds: [], gradeOverrides: {} },
      classes: { mode: 'skip' }, terms: [], copyPlanner: false, copyCalendar: false,
    };
    await authenticatedRequest('post', `/api/school-years/${year26}/rollover`).send(body);
    const second = await authenticatedRequest('post', `/api/school-years/${year26}/rollover`).send(body);
    expect(second.status).toBe(200);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM students WHERE school_year_id = $1`, [year26]);
    expect(rows[0].n).toBe(1); // not duplicated
  });

  it('honors exclusions and grade overrides', async () => {
    await authenticatedRequest('post', `/api/school-years/${year26}/rollover`).send({
      students: { mode: 'rollover', excludeStudentIds: [movingKid], gradeOverrides: { [gradKid]: '8' } },
      classes: { mode: 'skip' }, terms: [], copyPlanner: false, copyCalendar: false,
    });
    const { rows } = await pool.query(`SELECT name, grade::text FROM students WHERE school_year_id = $1`, [year26]);
    expect(rows).toEqual([{ name: 'Grad Kid', grade: '8' }]); // override kept the grade-8 kid, exclusion dropped the other
  });

  // Added during review: copyPlanner/copyCalendar execute paths had zero coverage
  // (both existing execute tests pass copyPlanner:false, copyCalendar:false), yet
  // they hit the per-year planner unique constraints and the fixed-block
  // class_group_ids jsonb remap — historically the buggiest area of this branch.
  it('copies planner config and calendar events, remapping fixed-block class group ids', async () => {
    await pool.query(
      `INSERT INTO planner_settings (school, school_id, default_duration_minutes, snap_minutes, school_year_id)
       VALUES ('ALHAADIACADEMY', $1, 45, 10, $2)`, [schoolId, year25]);
    await pool.query(
      `INSERT INTO planner_rooms (school, school_id, name, school_year_id)
       VALUES ('ALHAADIACADEMY', $1, 'Room A', $2)`, [schoolId, year25]);

    const groups = await pool.query(
      `INSERT INTO planner_class_groups (school, school_id, name, grade, school_year_id) VALUES
       ('ALHAADIACADEMY', $1, 'Group A', 'JK', $2),
       ('ALHAADIACADEMY', $1, 'Group B', 'SK', $2)
       RETURNING class_group_id, name`, [schoolId, year25]);
    const groupA = groups.rows.find(g => g.name === 'Group A').class_group_id;
    const groupB = groups.rows.find(g => g.name === 'Group B').class_group_id;

    await pool.query(
      `INSERT INTO planner_fixed_blocks
         (school, school_id, label, day_of_week, start_min, end_min, class_group_ids, school_year_id)
       VALUES ('ALHAADIACADEMY', $1, 'Lunch', 1, 720, 760, $2::jsonb, $3)`,
      [schoolId, JSON.stringify([groupA, groupB]), year25]);

    await pool.query(
      `INSERT INTO school_calendar_events
         (school, school_id, title, category, start_date, end_date, is_school_closed, school_year_id)
       VALUES ('ALHAADIACADEMY', $1, 'Winter Break', 'holiday', '2025-12-20', '2026-01-02', true, $2)`,
      [schoolId, year25]);

    const res = await authenticatedRequest('post', `/api/school-years/${year26}/rollover`).send({
      students: { mode: 'skip' }, classes: { mode: 'skip' }, terms: [],
      copyPlanner: true, copyCalendar: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plannerCopied: true, calendarEventsCopied: 1 });

    const settings = await pool.query(
      `SELECT default_duration_minutes, snap_minutes FROM planner_settings WHERE school_year_id = $1`, [year26]);
    expect(settings.rows).toEqual([{ default_duration_minutes: 45, snap_minutes: 10 }]);

    const rooms = await pool.query(
      `SELECT name FROM planner_rooms WHERE school_year_id = $1`, [year26]);
    expect(rooms.rows).toEqual([{ name: 'Room A' }]);

    const newGroups = await pool.query(
      `SELECT class_group_id, name FROM planner_class_groups WHERE school_year_id = $1 ORDER BY name`, [year26]);
    expect(newGroups.rows.map(g => g.name)).toEqual(['Group A', 'Group B']);
    const newGroupIds = newGroups.rows.map(g => g.class_group_id);
    expect(newGroupIds).not.toContain(groupA);
    expect(newGroupIds).not.toContain(groupB);

    const blocks = await pool.query(
      `SELECT label, class_group_ids FROM planner_fixed_blocks WHERE school_year_id = $1`, [year26]);
    expect(blocks.rows).toHaveLength(1);
    expect(blocks.rows[0].label).toBe('Lunch');
    expect(blocks.rows[0].class_group_ids.sort()).toEqual(newGroupIds.sort());
    expect(blocks.rows[0].class_group_ids).not.toContain(groupA);
    expect(blocks.rows[0].class_group_ids).not.toContain(groupB);

    const events = await pool.query(
      `SELECT title, start_date::text, end_date::text FROM school_calendar_events WHERE school_year_id = $1`, [year26]);
    expect(events.rows).toEqual([{ title: 'Winter Break', start_date: '2026-12-20', end_date: '2027-01-02' }]);
  });
});
