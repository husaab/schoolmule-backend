// A student's uploaded photo lives on their linked student login and shows
// wherever the student is pictured, but only while the school has student
// photos on (school_classroom_settings.student_photos).
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOM_ID = '550e8400-e29b-41d4-a716-446655440004';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office.admin@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asMom = { userId: MOM_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };

const PHOTO = 'ALHAADIACADEMY/amal/p.png';
const URL = `https://mock-signed-url.com/${PHOTO}`;
const AVATAR = { style: 'hijab', skin: 2, bg: 3 };

describe('Integration: student photos wherever a student is pictured', () => {
  let pool, yearId, termId, sciId, amalId, archivedId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const expectOk = async (method, url, who) => {
    const res = await authenticatedRequest(method, url, who);
    if (res.status !== 200) throw new Error(`${url}: expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const studentPhotos = (on) => pool.query(`UPDATE school_classroom_settings SET student_photos = $1 WHERE school = 'ALHAADIACADEMY'`, [on]);

  /** The picture `read` finds is null while student photos are off and the signed URL once on. */
  const followsSetting = async (read) => {
    await studentPhotos(false);
    expect(await read()).toBeNull();
    await studentPhotos(true);
    expect(await read()).toBe(URL);
  };

  beforeEach(async () => {
    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`)).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;
    await user(ADMIN_ID, 'office.admin@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MOM_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await pool.query(`UPDATE users SET photo_path = $2, avatar = $3::jsonb WHERE user_id = $1`, [AMAL_USER_ID, PHOTO, JSON.stringify(AVATAR)]);
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    sciId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
       VALUES ('ALHAADIACADEMY', '5', 'Science', 'Ziad Teacher', $1, $2, 'Term 1', $3) RETURNING class_id`,
      [TEACHER_ID, termId, yearId],
    )).rows[0].class_id;
    amalId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ('Amal Haddad', '5', 'ALHAADIACADEMY', $1, $2) RETURNING student_id`,
      [yearId, TEACHER_ID],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [sciId, amalId]);
    await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [AMAL_USER_ID, amalId, yearId]);
    await pool.query(`INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())`, [AMAL_USER_ID]);
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
       VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY')`, [amalId, MOM_ID],
    );
    archivedId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, is_archived, archived_at) VALUES ('Old Student', '5', 'ALHAADIACADEMY', $1, TRUE, NOW()) RETURNING student_id`,
      [yearId],
    )).rows[0].student_id;
  });

  const amalIn = (list) => list.find((s) => s.studentId === amalId);

  it('the Students list', async () => {
    await followsSetting(async () => amalIn(await expectOk('get', '/api/students', asAdmin)).photoUrl);
  });

  it('the Students list with archived students, which also carries the avatar', async () => {
    const all = await expectOk('get', '/api/students/all', asAdmin);
    expect(amalIn(all).avatar).toEqual(AVATAR);
    expect(all.find((s) => s.studentId === archivedId)).toMatchObject({ avatar: null, photoUrl: null });
    await followsSetting(async () => amalIn(await expectOk('get', '/api/students/all', asAdmin)).photoUrl);
  });

  it('one student and the student profile', async () => {
    await followsSetting(async () => (await expectOk('get', `/api/students/${amalId}`, asAdmin)).photoUrl);
    await followsSetting(async () => (await expectOk('get', `/api/students/${amalId}/overview`, asAdmin)).student.photoUrl);
  });

  it("a class's students (the gradebook), which also carries the avatar", async () => {
    const roster = await expectOk('get', `/api/classes/${sciId}/students`, asTeacher);
    expect(amalIn(roster).avatar).toEqual(AVATAR);
    await followsSetting(async () => amalIn(await expectOk('get', `/api/classes/${sciId}/students`, asTeacher)).photoUrl);
  });

  it('the grading list for a piece of classwork', async () => {
    const created = await authenticatedRequest('post', `/api/classroom/classes/${sciId}/items`, asTeacher)
      .send({ kind: 'assignment', title: 'Reading log', submissionMode: 'done', dueAt: new Date(Date.now() + 3 * 864e5).toISOString() });
    expect(created.status).toBe(201);
    const itemId = created.body.data.itemId;
    await followsSetting(async () => amalIn((await expectOk('get', `/api/classroom/items/${itemId}/submissions`, asTeacher)).students).photoUrl);
  });

  it('Student accounts', async () => {
    await followsSetting(async () => amalIn((await expectOk('get', '/api/admin/student-accounts', asAdmin)).students).studentPhotoUrl);
  });

  it("the parent's child switcher and the parent classroom summary", async () => {
    await followsSetting(async () => (await expectOk('get', `/api/parent-students/parent/${MOM_ID}`, asMom))
      .find((l) => l.studentId === amalId).student.photoUrl);
    await followsSetting(async () => amalIn((await expectOk('get', '/api/parent-portal/classroom/summary', asMom)).children).photoUrl);
  });
});
