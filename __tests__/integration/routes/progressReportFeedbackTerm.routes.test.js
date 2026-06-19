// Integration test for the progress-report feedback term fix: the term is
// derived from the class, never taken from the request, so feedback can't be
// mis-tagged into the wrong term (mirrors the report-card feedback fix).

jest.mock('puppeteer', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      setContent: jest.fn().mockResolvedValue(undefined),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf')),
      close: jest.fn().mockResolvedValue(undefined),
    }),
    close: jest.fn().mockResolvedValue(undefined),
  }),
}));

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Integration: progress-report feedback term is derived from the class', () => {
  let pool;

  beforeAll(() => { pool = getTestPool(); });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN', true, true)`,
      [TEST_USER_ID]
    );
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [TEACHER_USER_ID]
    );
  });

  async function seedTerm1Class() {
    const { rows: termRows } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
       VALUES ('ALHAADIACADEMY', 'Term 1 2025-2026', '2025-09-01', '2026-01-31', '2025-2026', false) RETURNING term_id`
    );
    const { rows: classRows } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', 'SK', 'Art', 'Teacher One', $1, $2, 'Term 1 2025-2026') RETURNING class_id`,
      [TEACHER_USER_ID, termRows[0].term_id]
    );
    const { rows: stuRows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Sk Student', 'ALHAADIACADEMY', 'SK') RETURNING student_id`
    );
    return { classId: classRows[0].class_id, studentId: stuRows[0].student_id };
  }

  it('single upsert stores under the class term, ignoring a wrong body term', async () => {
    const { classId, studentId } = await seedTerm1Class();

    const res = await authenticatedRequest('post', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`)
      .send({ term: 'Term 2 2025-2026', workHabit: 'E', behavior: 'G', comment: 'Great' });

    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT term FROM progress_report_feedback WHERE student_id = $1 AND class_id = $2',
      [studentId, classId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].term).toBe('Term 1 2025-2026'); // class term, not the body's 'Term 2'
  });

  it('bulk upsert stores under the class term, ignoring a wrong body term', async () => {
    const { classId, studentId } = await seedTerm1Class();

    const res = await authenticatedRequest('post', '/api/progress-reports/feedback/bulk')
      .send({ feedbackEntries: [{ studentId, classId, term: 'Term 2 2025-2026', workHabit: 'S' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(1);

    const { rows } = await pool.query(
      'SELECT term FROM progress_report_feedback WHERE student_id = $1 AND class_id = $2',
      [studentId, classId]
    );
    expect(rows[0].term).toBe('Term 1 2025-2026');
  });
});
