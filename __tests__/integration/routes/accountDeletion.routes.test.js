// DELETE /api/auth/delete-user against the real schema: the account is
// erased, never hard-deleted, so school records that point at the person
// (a conversation they started, a teacher's classes, staff attendance) stay,
// and nothing about the person does.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOM_ID = '550e8400-e29b-41d4-a716-446655440002';
const STUDENT_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const asTeacher = { userId: TEACHER_ID, username: 'Teacher One', email: 'teacher@example.test', role: 'TEACHER' };
const asMom = { userId: MOM_ID, username: 'Mom Test', email: 'mom@example.test', role: 'PARENT' };
const asStudent = { userId: STUDENT_USER_ID, username: 'Amina Test', email: 'amina@students.example.test', role: 'STUDENT' };

describe('Integration: deleting your own account', () => {
  let pool, yearId, classId, studentId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, username, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, google_sub, photo_path)
     VALUES ($1, $2, $3, '$2b$10$realhash', $4, $5, 'ALHAADIACADEMY', $6, true, true, $7, $8)`,
    [id, email, username, username.split(' ')[0], username.split(' ')[1], role, `google-${id}`, `ALHAADIACADEMY/${id}.jpg`],
  );

  beforeEach(async () => {
    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`)).rows[0].school_year_id;
    await user(TEACHER_ID, 'teacher@example.test', 'Teacher One', 'TEACHER');
    await user(MOM_ID, 'mom@example.test', 'Mom Test', 'PARENT');
    await user(STUDENT_USER_ID, 'amina@students.example.test', 'Amina Test', 'STUDENT');
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '6', 'Math', 'Teacher One', $1, $2) RETURNING class_id`, [TEACHER_ID, yearId])).rows[0].class_id;
    studentId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amina Test', '6', 'ALHAADIACADEMY', $1) RETURNING student_id`, [yearId])).rows[0].student_id;
    await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
       VALUES ($1, $2, 'Mom Test', 'mom@example.test', 'Mother', 'ALHAADIACADEMY')`, [studentId, MOM_ID]);
    // A thread the parent started: the reference that made a hard delete fail.
    await pool.query(
      `INSERT INTO conversations (school, student_id, class_id, title, created_by)
       VALUES ('ALHAADIACADEMY', $1, $2, 'About the quiz', $3)`, [studentId, classId, MOM_ID]);
    await pool.query("INSERT INTO push_devices (token, user_id, platform) VALUES ('ExponentPushToken[mom-0001]', $1, 'ios')", [MOM_ID]);
    await pool.query('INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)', [STUDENT_USER_ID, studentId, yearId]);
    await pool.query("INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())", [STUDENT_USER_ID]);
  });

  const row = async (id) => (await pool.query('SELECT * FROM users WHERE user_id = $1', [id])).rows[0];

  it('erases a parent who started a conversation: the person goes, the thread stays', async () => {
    const res = await authenticatedRequest('delete', '/api/auth/delete-user', asMom).send({});
    expect(res.status).toBe(200);

    const erased = await row(MOM_ID);
    expect(erased).toMatchObject({
      email: `deleted-${MOM_ID}@deleted.schoolmule.invalid`,
      username: 'Deleted user',
      first_name: 'Deleted',
      last_name: 'user',
      google_sub: null,
      apple_sub: null,
      photo_path: null,
      is_archived: true,
    });
    expect(erased.password).not.toBe('$2b$10$realhash');

    const { rows: threads } = await pool.query('SELECT created_by FROM conversations WHERE student_id = $1', [studentId]);
    expect(threads).toEqual([{ created_by: MOM_ID }]);
    const { rows: links } = await pool.query('SELECT parent_id, parent_email FROM parent_students WHERE student_id = $1', [studentId]);
    expect(links).toEqual([{ parent_id: null, parent_email: 'mom@example.test' }]);
    const { rows: devices } = await pool.query('SELECT 1 FROM push_devices WHERE user_id = $1', [MOM_ID]);
    expect(devices).toHaveLength(0);
  });

  it('can no longer sign in, and its old session is refused', async () => {
    await authenticatedRequest('delete', '/api/auth/delete-user', asMom).send({});
    const login = await authenticatedRequest('post', '/api/auth/login', asMom).send({ email: 'mom@example.test', password: 'whatever' });
    expect(login.status).toBeGreaterThanOrEqual(400);
    const after = await authenticatedRequest('get', '/api/profile', asMom);
    expect(after.status).toBeGreaterThanOrEqual(400);
  });

  it("keeps a teacher's classes with the school", async () => {
    const res = await authenticatedRequest('delete', '/api/auth/delete-user', asTeacher).send({});
    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT teacher_id FROM classes WHERE class_id = $1', [classId]);
    expect(rows).toEqual([{ teacher_id: TEACHER_ID }]);
    expect((await row(TEACHER_ID)).is_archived).toBe(true);
  });

  it("detaches a student's sign-in from their school record", async () => {
    const res = await authenticatedRequest('delete', '/api/auth/delete-user', asStudent).send({});
    expect(res.status).toBe(200);
    const { rows: links } = await pool.query('SELECT 1 FROM student_account_links WHERE user_id = $1', [STUDENT_USER_ID]);
    expect(links).toHaveLength(0);
    const { rows: students } = await pool.query('SELECT name FROM students WHERE student_id = $1', [studentId]);
    expect(students).toEqual([{ name: 'Amina Test' }]);
  });
});
