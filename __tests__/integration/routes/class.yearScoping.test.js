jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

describe('classes and bulk enrollment are year-scoped', () => {
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

    // teacher_id is NOT NULL / FK'd on classes, so seed a teacher user.
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [TEACHER_USER_ID]
    );

    await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id) VALUES
       ('ALHAADIACADEMY', '3', 'Math', 'Teacher One', $1, $2),
       ('ALHAADIACADEMY', '4', 'Math', 'Teacher One', $1, $3)`,
      [TEACHER_USER_ID, year25, year26]
    );
  });

  it('GET /api/classes returns only the selected year', async () => {
    const res25 = await authenticatedRequest('get', '/api/classes').set('X-School-Year', year25);
    expect(res25.body.data.map(c => c.grade)).toEqual(['3']);

    const res26 = await authenticatedRequest('get', '/api/classes').set('X-School-Year', year26);
    expect(res26.body.data.map(c => c.grade)).toEqual(['4']);
  });

  it('GET /api/classes defaults to the active year without a header', async () => {
    const res = await authenticatedRequest('get', '/api/classes');
    expect(res.body.data.map(c => c.grade)).toEqual(['3']);
  });

  it('POST /api/classes stamps the selected year', async () => {
    // termId/termName are validated as required by the create handler and
    // term_id is FK'd, so seed a real term rather than sending nulls.
    const term = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true)
       RETURNING term_id`
    );

    const res = await authenticatedRequest('post', '/api/classes')
      .set('X-School-Year', year26)
      .send({
        grade: '5',
        subject: 'Science',
        teacherName: 'Teacher One',
        teacherId: TEACHER_USER_ID,
        termId: term.rows[0].term_id,
        termName: 'Term 1 2025-2026',
      });

    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT school_year_id FROM classes WHERE subject = 'Science'`);
    expect(rows[0].school_year_id).toBe(year26);
  });

  it('enroll-all-in-grade only enrolls students from the class\'s own year', async () => {
    const cls = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '3', 'Science', 'Teacher One', $1, $2)
       RETURNING class_id`,
      [TEACHER_USER_ID, year26]
    );
    const classId = cls.rows[0].class_id;

    await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES
       ('Old Kid', '3', 'ALHAADIACADEMY', $1),
       ('New Kid', '3', 'ALHAADIACADEMY', $2)`, [year25, year26]);

    const res = await authenticatedRequest('post', `/api/classes/${classId}/students/bulk`)
      .set('X-School-Year', year26)
      .send({ enrollAllInGrade: true });

    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT count(*) FROM class_students WHERE class_id = $1`, [classId]
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('POST /api/classes/:sourceClassId/duplicate inherits the source class\'s school year', async () => {
    // Seed a class in the active (year25) year, plus a term to satisfy
    // duplicateClass's required-fields validation.
    const source = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '3', 'History', 'Teacher One', $1, $2)
       RETURNING class_id`,
      [TEACHER_USER_ID, year25]
    );
    const sourceClassId = source.rows[0].class_id;

    const term = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true)
       RETURNING term_id`
    );

    // Caller is viewing year26, but the duplicate must still inherit year25
    // (the source class's year), not the caller's selected year.
    const res = await authenticatedRequest('post', `/api/classes/${sourceClassId}/duplicate`)
      .set('X-School-Year', year26)
      .send({
        grade: '3',
        subject: 'History',
        teacherName: 'Teacher One',
        teacherId: TEACHER_USER_ID,
        termId: term.rows[0].term_id,
        termName: 'Term 1 2025-2026',
      });

    expect([200, 201]).toContain(res.status);

    // The newly created (duplicate) class row's school_year_id must match the source's.
    const dup = await pool.query(
      `SELECT school_year_id FROM classes WHERE subject = 'History' AND class_id != $1`,
      [sourceClassId]
    );
    expect(dup.rows).toHaveLength(1);
    expect(dup.rows[0].school_year_id).toBe(year25);
  });
});
