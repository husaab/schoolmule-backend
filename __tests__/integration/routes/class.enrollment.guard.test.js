jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const LEAD_ID = '550e8400-e29b-41d4-a716-446655440031';
const COLLEAGUE_ID = '550e8400-e29b-41d4-a716-446655440032';
const ARCHIVED_ID = '550e8400-e29b-41d4-a716-446655440033';
const OTHER_SCHOOL_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440034';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440035';
const UNKNOWN_ID = '550e8400-e29b-41d4-a716-4466554400ff';

// A class only takes students of its own school and school year, and only
// staff of its school lead or co-teach it. The class guard proves the caller
// may change the class; these prove who is being put into it.
describe('a class only takes people of its own school', () => {
  let pool, classId, thisYear, otherYear, sameYear, pastYear, otherSchool;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    const { rows: [school] } = await pool.query(
      `SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    await pool.query(`DELETE FROM school_years WHERE school = 'ALHAADIACADEMY'`);
    const { rows: years } = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active) VALUES
       ('ALHAADIACADEMY', $1, '2026-2027', '2026-09-01', '2027-06-30', TRUE),
       ('ALHAADIACADEMY', $1, '2025-2026', '2025-09-01', '2026-06-30', FALSE)
       RETURNING school_year_id, label`, [school.school_id]);
    thisYear = years.find((y) => y.label === '2026-2027').school_year_id;
    otherYear = years.find((y) => y.label === '2025-2026').school_year_id;

    const user = (id, email, schoolName, role, archived = false) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
       VALUES ($1, $2, $3, 'hashed', 'Test', 'Person', $4, $5, true, true, $6)`,
      [id, email, email, schoolName, role, archived]);
    await user(LEAD_ID, 'lead@test.com', 'ALHAADIACADEMY', 'TEACHER');
    await user(COLLEAGUE_ID, 'colleague@test.com', 'ALHAADIACADEMY', 'TEACHER');
    await user(ARCHIVED_ID, 'left@test.com', 'ALHAADIACADEMY', 'TEACHER', true);
    await user(OTHER_SCHOOL_TEACHER_ID, 'elsewhere@test.com', 'PLAYGROUND', 'TEACHER');
    await user(PARENT_ID, 'parent@test.com', 'ALHAADIACADEMY', 'PARENT');

    const { rows: [cls] } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '5', 'Math', 'Lead Teacher', $1, $2) RETURNING class_id`,
      [LEAD_ID, thisYear]);
    classId = cls.class_id;

    const { rows: students } = await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES
         ('This Year', '5', 'ALHAADIACADEMY', $1),
         ('Last Year', '5', 'ALHAADIACADEMY', $2),
         ('Other School', '5', 'PLAYGROUND', NULL)
       RETURNING student_id, name`, [thisYear, otherYear]);
    const idOf = (name) => students.find((s) => s.name === name).student_id;
    sameYear = idOf('This Year');
    pastYear = idOf('Last Year');
    otherSchool = idOf('Other School');
  });

  const roster = async () =>
    (await pool.query(`SELECT student_id FROM class_students WHERE class_id = $1`, [classId])).rows.map((r) => r.student_id);
  const coTeachers = async () =>
    (await pool.query(`SELECT teacher_id FROM class_teachers WHERE class_id = $1`, [classId])).rows.map((r) => r.teacher_id);
  const leadOf = async () =>
    (await pool.query(`SELECT teacher_id FROM classes WHERE class_id = $1`, [classId])).rows[0].teacher_id;

  describe('POST /api/classes/:classId/students', () => {
    const enrol = (studentId) => authenticatedRequest('post', `/api/classes/${classId}/students`).send({ studentId });

    it('enrols a student of the class\'s school and year', async () => {
      const res = await enrol(sameYear);
      expect(res.status).toBe(201);
      expect(await roster()).toEqual([sameYear]);
    });

    it('refuses a student of another school as not found', async () => {
      const res = await enrol(otherSchool);
      expect(res.status).toBe(404);
      expect(await roster()).toEqual([]);
    });

    it('refuses a student of another school year', async () => {
      const res = await enrol(pastYear);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('STUDENT_OTHER_YEAR');
      expect(await roster()).toEqual([]);
    });

    it('answers 404 to a student that does not exist and to a malformed id', async () => {
      expect((await enrol(UNKNOWN_ID)).status).toBe(404);
      expect((await enrol('not-an-id')).status).toBe(404);
      expect(await roster()).toEqual([]);
    });
  });

  describe('POST /api/classes/:classId/students/bulk', () => {
    const bulk = (studentIds) => authenticatedRequest('post', `/api/classes/${classId}/students/bulk`).send({ studentIds });

    it('enrols a list that all fits', async () => {
      const res = await bulk([sameYear]);
      expect(res.status).toBe(201);
      expect(await roster()).toEqual([sameYear]);
    });

    it('enrols nobody when one student does not fit, and says which', async () => {
      const res = await bulk([sameYear, pastYear, otherSchool]);
      expect(res.status).toBe(400);
      expect(res.body.invalid.sort()).toEqual([pastYear, otherSchool].sort());
      expect(await roster()).toEqual([]);
    });
  });

  describe('POST /api/classes/:classId/teachers', () => {
    const addTeacher = (teacherId) => authenticatedRequest('post', `/api/classes/${classId}/teachers`).send({ teacherId });

    it('adds a colleague of the same school', async () => {
      const res = await addTeacher(COLLEAGUE_ID);
      expect(res.status).toBe(201);
      expect(await coTeachers()).toEqual([COLLEAGUE_ID]);
    });

    it.each([
      ['a teacher of another school', OTHER_SCHOOL_TEACHER_ID],
      ['an archived teacher', ARCHIVED_ID],
      ['a parent account', PARENT_ID],
      ['an account that does not exist', UNKNOWN_ID],
    ])('refuses %s', async (_label, teacherId) => {
      const res = await addTeacher(teacherId);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Teacher not found');
      expect(await coTeachers()).toEqual([]);
    });
  });

  describe('the lead teacher', () => {
    it('cannot be changed to a teacher of another school', async () => {
      const res = await authenticatedRequest('patch', `/api/classes/${classId}`)
        .send({ teacherId: OTHER_SCHOOL_TEACHER_ID, teacherName: 'Elsewhere' });
      expect(res.status).toBe(404);
      expect(await leadOf()).toBe(LEAD_ID);
    });

    it('can be changed to a colleague of the same school', async () => {
      const res = await authenticatedRequest('patch', `/api/classes/${classId}`)
        .send({ teacherId: COLLEAGUE_ID, teacherName: 'Colleague' });
      expect(res.status).toBe(200);
      expect(await leadOf()).toBe(COLLEAGUE_ID);
    });

    it('of a new class must be staff of the school', async () => {
      const res = await authenticatedRequest('post', '/api/classes').send({
        grade: '5', subject: 'Science', teacherName: 'Elsewhere', teacherId: OTHER_SCHOOL_TEACHER_ID,
        termId: UNKNOWN_ID, termName: 'Term 1', autoEnroll: false,
      });
      expect(res.status).toBe(404);
      const { rows } = await pool.query(`SELECT 1 FROM classes WHERE subject = 'Science'`);
      expect(rows).toEqual([]);
    });
  });
});
