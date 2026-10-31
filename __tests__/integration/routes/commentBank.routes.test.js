// Integration test for /api/comment-banks: a class's standard progress
// comments. Anyone who may write the class's progress comments (its teacher,
// a co-teacher, staff with report_cards) may read and change them.

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const STUDENT_USER_ID = '550e8400-e29b-41d4-a716-446655440004';

const asTeacher = { userId: TEACHER_ID, username: 'Teacher One', email: 'teacher@example.com', role: 'TEACHER' };
const asCo = { userId: CO_TEACHER_ID, username: 'Teacher Two', email: 'co@example.com', role: 'TEACHER' };
const asOther = { userId: OTHER_TEACHER_ID, username: 'Teacher Three', email: 'other@example.com', role: 'TEACHER' };
const asStudent = { userId: STUDENT_USER_ID, username: 'Amina Test', email: 'amina@students.example.test', role: 'STUDENT', roles: ['STUDENT'] };

const bank = (over = {}) => ({
  coreStandards: {
    exceeding: '{First} is exceeding expectations in {subject}.',
    meeting: '{First} is meeting expectations in {subject}.',
    workingTowards: '{First} is working towards expectations in {subject}.',
    notMeeting: '{First} is not yet meeting expectations in {subject}.',
    ...over.coreStandards,
  },
  workHabits: { E: '{He} works hard.', G: '{He} works well.', S: '{He} could work more.', N: '{He} needs to hand work in.', ...over.workHabits },
  cutoffs: { exceeding: 85, meeting: 70, workingTowards: 60, ...over.cutoffs },
});

describe('Integration: /api/comment-banks', () => {
  let pool;
  let yearId;
  let classId;
  let otherSchoolClassId;

  beforeAll(() => { pool = getTestPool(); });

  const user = (id, email, username, role, school = 'ALHAADIACADEMY') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7, true, true)`,
    [id, email, username, username.split(' ')[0], username.split(' ')[1], school, role],
  );

  beforeEach(async () => {
    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`)).rows[0].school_year_id;
    await user(ADMIN_ID, 'admin@test.com', 'Admin User', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Teacher One', 'TEACHER');
    await user(CO_TEACHER_ID, 'co@example.com', 'Teacher Two', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'other@example.com', 'Teacher Three', 'TEACHER');
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id, term_name)
       VALUES ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, $2, 'Term 1') RETURNING class_id`,
      [TEACHER_ID, yearId],
    )).rows[0].class_id;
    await pool.query('INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)', [classId, CO_TEACHER_ID]);
    otherSchoolClassId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id)
       VALUES ('PLAYGROUND', '5', 'Math', 'Someone Else', $1) RETURNING class_id`,
      [OTHER_TEACHER_ID],
    )).rows[0].class_id;
  });

  const url = (id) => `/api/comment-banks/class/${id}`;

  it('GET returns null for a class with nothing saved', async () => {
    const res = await authenticatedRequest('get', url(classId), asTeacher);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', data: null });
  });

  it('PUT saves the bank, trimmed, and GET returns it', async () => {
    const body = bank({ coreStandards: { meeting: '  Hi {First}.  ' } });
    const put = await authenticatedRequest('put', url(classId), asTeacher).send(body);
    expect(put.status).toBe(200);
    expect(put.body.data.coreStandards.meeting).toBe('Hi {First}.');

    const res = await authenticatedRequest('get', url(classId), asTeacher);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ...bank(), coreStandards: { ...bank().coreStandards, meeting: 'Hi {First}.' } });

    const { rows } = await pool.query('SELECT updated_by FROM class_comment_banks WHERE class_id = $1', [classId]);
    expect(rows[0].updated_by).toBe(TEACHER_ID);
  });

  it('drops keys the bank does not have', async () => {
    const body = { ...bank(), extra: 'x', workHabits: { ...bank().workHabits, X: 'nope' } };
    const put = await authenticatedRequest('put', url(classId), asTeacher).send(body);
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual(bank());
  });

  it('a co-teacher may save it', async () => {
    const res = await authenticatedRequest('put', url(classId), asCo).send(bank());
    expect(res.status).toBe(200);
  });

  it('an admin with report_cards may save it', async () => {
    const res = await authenticatedRequest('put', url(classId)).send(bank());
    expect(res.status).toBe(200);
  });

  it("any teacher holding report_cards (the teacher default) may, as with the class's progress comments", async () => {
    expect((await authenticatedRequest('put', url(classId), asOther).send(bank())).status).toBe(200);
  });

  it('a teacher whose role lacks report_cards, with no tie to the class, may not', async () => {
    const roleId = (await pool.query(
      `INSERT INTO staff_roles (school, name, permissions) VALUES ('ALHAADIACADEMY', 'Attendance only', '{attendance.daily}') RETURNING role_id`,
    )).rows[0].role_id;
    await pool.query('UPDATE users SET staff_role_id = $1 WHERE user_id = $2', [roleId, OTHER_TEACHER_ID]);

    expect((await authenticatedRequest('get', url(classId), asOther)).status).toBe(403);
    expect((await authenticatedRequest('put', url(classId), asOther).send(bank())).status).toBe(403);
    expect((await authenticatedRequest('delete', url(classId), asOther)).status).toBe(403);
  });

  it("another school's class is refused", async () => {
    const res = await authenticatedRequest('get', url(otherSchoolClassId));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Not authorized for this class');
  });

  it('an unknown class is 404', async () => {
    const res = await authenticatedRequest('get', url('550e8400-e29b-41d4-a716-4466554400ff'));
    expect(res.status).toBe(404);
  });

  it('PUT rejects an empty sentence', async () => {
    const res = await authenticatedRequest('put', url(classId), asTeacher).send(bank({ coreStandards: { meeting: '   ' } }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: 'failed', message: 'Every standard comment needs text.' });
  });

  it('PUT rejects a missing sentence with the same message', async () => {
    const body = bank();
    delete body.workHabits.N;
    const res = await authenticatedRequest('put', url(classId), asTeacher).send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Every standard comment needs text.');
  });

  it('PUT rejects a sentence over 600 characters', async () => {
    const res = await authenticatedRequest('put', url(classId), asTeacher).send(bank({ workHabits: { E: 'a'.repeat(601) } }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Each standard comment can be up to 600 characters.');
  });

  it('PUT accepts a sentence of exactly 600 characters', async () => {
    const res = await authenticatedRequest('put', url(classId), asTeacher).send(bank({ workHabits: { E: 'a'.repeat(600) } }));
    expect(res.status).toBe(200);
  });

  it.each([
    ['out of order', { exceeding: 70, meeting: 85, workingTowards: 60 }],
    ['equal', { exceeding: 70, meeting: 70, workingTowards: 60 }],
    ['above 100', { exceeding: 101, meeting: 70, workingTowards: 60 }],
    ['below 0', { exceeding: 85, meeting: 70, workingTowards: -1 }],
    ['not a number', { exceeding: '85', meeting: 70, workingTowards: 60 }],
  ])('PUT rejects cut-offs that are %s', async (_label, cutoffs) => {
    const res = await authenticatedRequest('put', url(classId), asTeacher).send(bank({ cutoffs }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Cut-offs must go Exceeding, then Meeting, then Working towards, from high to low, between 0 and 100.');
  });

  it('DELETE removes it, so GET is null again', async () => {
    await authenticatedRequest('put', url(classId), asTeacher).send(bank());
    const del = await authenticatedRequest('delete', url(classId), asTeacher);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ status: 'success' });
    expect((await authenticatedRequest('get', url(classId), asTeacher)).body.data).toBeNull();
  });

  it("GET /mine lists the caller's classes with a saved bank in the selected year", async () => {
    expect((await authenticatedRequest('get', '/api/comment-banks/mine', asTeacher)).body).toEqual({ status: 'success', data: [] });
    await authenticatedRequest('put', url(classId), asTeacher).send(bank());

    const mine = await authenticatedRequest('get', '/api/comment-banks/mine', asTeacher);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([{ classId, grade: '5', subject: 'Math', termName: 'Term 1' }]);

    // A co-teacher of the class sees it too; an unrelated teacher does not.
    expect((await authenticatedRequest('get', '/api/comment-banks/mine', asCo)).body.data).toHaveLength(1);
    expect((await authenticatedRequest('get', '/api/comment-banks/mine', asOther)).body.data).toEqual([]);
  });

  describe('Duplicate class', () => {
    const duplicate = async (sourceId) => {
      const termId = (await pool.query(
        `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
         VALUES ('ALHAADIACADEMY', 'Term 2', '2026-02-01', '2026-06-30', '2025-2026', false) RETURNING term_id`,
      )).rows[0].term_id;
      const res = await authenticatedRequest('post', `/api/classes/${sourceId}/duplicate`, asTeacher).send({
        grade: '5', subject: 'Math', teacherName: 'Teacher One', teacherId: TEACHER_ID, termId, termName: 'Term 2',
      });
      expect(res.status).toBe(201);
      return res.body.data.classId || res.body.data.class_id;
    };

    it("copies the class's standard comments", async () => {
      await authenticatedRequest('put', url(classId), asTeacher).send(bank({ coreStandards: { meeting: 'Copied {First}.' } }));
      const newId = await duplicate(classId);
      const res = await authenticatedRequest('get', url(newId), asTeacher);
      expect(res.body.data.coreStandards.meeting).toBe('Copied {First}.');
    });

    it('leaves none when the source has none', async () => {
      const newId = await duplicate(classId);
      expect((await authenticatedRequest('get', url(newId), asTeacher)).body.data).toBeNull();
    });
  });

  it('a student token is refused', async () => {
    const res = await authenticatedRequest('get', url(classId), asStudent);
    expect(res.status).toBe(403);
  });
});
