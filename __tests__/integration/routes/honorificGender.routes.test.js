// Staff titles in parent-facing names, and student gender on the student
// routes, against the real schema. Synthetic people only.
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const publishQueries = require('../../../queries/assessmentPublish.queries');
const messagingQueries = require('../../../queries/messaging.queries');
const analyticsQueries = require('../../../queries/analytics.queries');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '770e8400-e29b-41d4-a716-446655440001';
const PARENT_ID = '770e8400-e29b-41d4-a716-446655440002';

describe('Integration: staff titles and student gender', () => {
  let pool;
  let yearId;

  const user = (id, email, first, last, role, honorific = null) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, honorific)
     VALUES ($1, $2, $3, 'x', $4, $5, 'ALHAADIACADEMY', $6, TRUE, TRUE, $7)`,
    [id, email, `${first} ${last}`, first, last, role, honorific],
  );

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await user(ADMIN_ID, 'admin@test.com', 'Admin', 'User', 'ADMIN');
    const { rows } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active = TRUE`);
    yearId = rows[0].school_year_id;
  });

  describe('names parents see', () => {
    let classId;
    let studentId;

    beforeEach(async () => {
      await user(TEACHER_ID, 'teacher@test.com', 'Doha', 'Teacher', 'TEACHER', 'Ms.');
      // The class still carries an old copy of the name: the account wins.
      const { rows: [c] } = await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id, term_name)
         VALUES ('ALHAADIACADEMY', '5', 'English', 'Old Copy', $1, $2, 'Term 1') RETURNING class_id`,
        [TEACHER_ID, yearId],
      );
      classId = c.class_id;
      const { rows: [s] } = await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Child Test', '5', 'ALHAADIACADEMY', $1) RETURNING student_id`,
        [yearId],
      );
      studentId = s.student_id;
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
    });

    it('puts the title before the full name in the grade email', async () => {
      const { rows: [ctx] } = await pool.query(publishQueries.selectEmailClassContext, [classId]);
      expect(ctx.teacher_name).toBe('Ms. Doha Teacher');
    });

    it('uses the titled account name in the parent pickers, not the stored copy', async () => {
      const { rows } = await pool.query(messagingQueries.selectParentTargets, [studentId, yearId, null, null]);
      expect(rows[0].teacher_name).toBe('Ms. Doha Teacher');
    });

    it('uses the titled account name in the grades matrix, falling back to the stored copy', async () => {
      const { rows: [term] } = await pool.query(
        `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
         VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2026-01-31', TRUE, $1) RETURNING term_id`,
        [yearId],
      );
      await pool.query('UPDATE classes SET term_id = $1 WHERE class_id = $2', [term.term_id, classId]);
      await pool.query(`INSERT INTO assessments (class_id, name, weight_points, max_score) VALUES ($1, 'Quiz', 10, 10)`, [classId]);
      const matrix = () => pool.query(analyticsQueries.selectAnalyticsMatrix, ['ALHAADIACADEMY', term.term_id]);
      expect((await matrix()).rows[0].teacher_name).toBe('Ms. Doha Teacher');
      // With no account behind the class, the stored copy is what there is.
      await pool.query('UPDATE classes SET teacher_id = $1 WHERE class_id = $2', [ADMIN_ID, classId]);
      await pool.query(`UPDATE users SET first_name = '', last_name = '' WHERE user_id = $1`, [ADMIN_ID]);
      expect((await matrix()).rows[0].teacher_name).toBe('Old Copy');
    });

    it('leaves a parent (no title) by plain name', async () => {
      await user(PARENT_ID, 'parent@test.com', 'Sam', 'Parent', 'PARENT');
      const { rows: [row] } = await pool.query(
        `SELECT ${require('../../../queries/personName').PERSON_NAME('u')} AS name FROM users u WHERE user_id = $1`,
        [PARENT_ID],
      );
      expect(row.name).toBe('Sam Parent');
    });

    it('refuses a title outside Mr./Ms./Mrs./Dr.', async () => {
      await expect(pool.query(`UPDATE users SET honorific = 'Sir' WHERE user_id = $1`, [TEACHER_ID])).rejects.toThrow();
    });
  });

  describe('student gender', () => {
    const create = (body) => authenticatedRequest('post', '/api/students').send({ name: 'Child Test', grade: 5, ...body });

    it('is saved on create, kept when an edit leaves it out, and cleared with null', async () => {
      const created = await create({ gender: 'female' });
      expect(created.status).toBe(201);
      expect(created.body.data.gender).toBe('female');
      const id = created.body.data.studentId;

      const untouched = await authenticatedRequest('patch', `/api/students/${id}`).send({ oen: '123' });
      expect(untouched.status).toBe(200);
      expect(untouched.body.data.gender).toBe('female');

      const changed = await authenticatedRequest('patch', `/api/students/${id}`).send({ gender: 'male' });
      expect(changed.body.data.gender).toBe('male');

      const cleared = await authenticatedRequest('patch', `/api/students/${id}`).send({ gender: null });
      expect(cleared.body.data.gender).toBeNull();
    });

    it('refuses anything but male, female or not set', async () => {
      expect((await create({ gender: 'other' })).status).toBe(400);
    });
  });
});
