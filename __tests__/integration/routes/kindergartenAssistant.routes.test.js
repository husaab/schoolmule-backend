// The JK/SK gradebook's teacher-assistant picker: the assistant is a
// co-teacher of the student's Kindergarten class (services/kindergartenStaff.js).
// Synthetic identities only.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const SCHOOL = 'ALHAADIACADEMY';
const LEAD_ID = '6b1f0c2e-1d3b-4c5a-9e8f-000000000001';
const CO_A = '6b1f0c2e-1d3b-4c5a-9e8f-000000000002';
const CO_B = '6b1f0c2e-1d3b-4c5a-9e8f-000000000003';
const OUTSIDER = '6b1f0c2e-1d3b-4c5a-9e8f-000000000004';

const as = (userId, username) => ({ userId, username, email: `${userId}@example.test`, role: 'TEACHER' });
const asLead = as(LEAD_ID, 'Lead Teacher');
const asCoA = as(CO_A, 'Co Teacher A');
const asOutsider = as(OUTSIDER, 'Other Teacher');

describe('Integration: kindergarten teacher assistant', () => {
  let pool;
  let studentId;
  let classId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  beforeEach(async () => {
    const user = (id, name) => pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'hashed', 'Test', 'User', $4, 'TEACHER', true, true)`,
      [id, `${id}@example.test`, name, SCHOOL],
    );
    await user(LEAD_ID, 'Lead Teacher');
    await user(CO_A, 'Co Teacher A');
    await user(CO_B, 'Co Teacher B');
    await user(OUTSIDER, 'Other Teacher');
    const { rows: [year] } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = $1 AND is_active`, [SCHOOL]);
    ({ rows: [{ student_id: studentId }] } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Test Student K', $1, 'SK') RETURNING student_id`,
      [SCHOOL],
    ));
    ({ rows: [{ class_id: classId }] } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ($1, 'SK', 'Senior Kindergarten', 'Lead Teacher', $2, $3) RETURNING class_id`,
      [SCHOOL, LEAD_ID, year.school_year_id],
    ));
    await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
  });

  const get = (who = asLead, term = 'Term 1') => authenticatedRequest('get', `/api/sk/teacher-assistant/${studentId}?term=${encodeURIComponent(term)}`, who);
  const post = (body, who = asLead) => authenticatedRequest('post', '/api/sk/teacher-assistant', who).send({ studentId, term: 'Term 1', ...body });
  const coTeach = (...ids) => Promise.all(ids.map((id) => pool.query('INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)', [classId, id])));

  it('with no co-teacher: nobody prints, and the class teacher may add one', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      teacher: { userId: LEAD_ID, name: 'Lead Teacher' },
      classId,
      choices: [],
      defaultUserId: null,
      selection: 'default',
      effective: null,
      canManageClass: true,
    });
  });

  it("the class's only co-teacher is the default, with no saving needed", async () => {
    await coTeach(CO_A);
    const res = await get();
    expect(res.body.data).toMatchObject({
      choices: [{ userId: CO_A, name: 'Co Teacher A' }],
      defaultUserId: CO_A,
      selection: 'default',
      effective: { userId: CO_A, name: 'Co Teacher A' },
    });
    // A co-teacher has the same access, and may manage the class too.
    expect((await get(asCoA)).body.data.canManageClass).toBe(true);
  });

  it('a teacher picks another co-teacher, or none, per term; default clears the pick', async () => {
    await coTeach(CO_A, CO_B);
    expect((await get()).body.data).toMatchObject({ defaultUserId: null, effective: null });

    const picked = await post({ mode: 'user', assistantUserId: CO_B });
    expect(picked.status).toBe(200);
    expect(picked.body.data).toMatchObject({ selection: { userId: CO_B }, effective: { userId: CO_B, name: 'Co Teacher B' } });
    expect((await get(asLead, 'Term 2')).body.data.selection).toBe('default'); // per term

    const none = await post({ mode: 'none' });
    expect(none.body.data).toMatchObject({ selection: 'none', effective: null });
    const { rows } = await pool.query('SELECT teacher_assistant_user_id, no_assistant FROM sk_teacher_assistants WHERE student_id = $1', [studentId]);
    expect(rows).toEqual([{ teacher_assistant_user_id: null, no_assistant: true }]);

    const back = await post({ mode: 'default' });
    expect(back.body.data).toMatchObject({ selection: 'default', effective: null });
  });

  it('refuses someone who is not a co-teacher of the class', async () => {
    await coTeach(CO_A);
    const res = await post({ mode: 'user', assistantUserId: OUTSIDER });
    expect(res.status).toBe(400);
    expect((await get()).body.data.selection).toBe('default');
  });

  it('leaves the choice alone when an old app sends a typed name', async () => {
    await coTeach(CO_A, CO_B);
    await post({ mode: 'user', assistantUserId: CO_B });
    const res = await post({ teacherAssistantName: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.selection).toEqual({ userId: CO_B });
  });

  it('is for the teachers of the student (and classes.all) only', async () => {
    expect((await get(asOutsider)).status).toBe(403);
    expect((await post({ mode: 'none' }, asOutsider)).status).toBe(403);
  });

  it('needs a term and a valid mode', async () => {
    expect((await authenticatedRequest('get', `/api/sk/teacher-assistant/${studentId}`, asLead)).status).toBe(400);
    expect((await post({ mode: 'everyone' })).status).toBe(400);
    expect((await post({ mode: 'user' })).status).toBe(400);
  });
});
