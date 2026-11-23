// Integration test for /api/report-templates/subject-layout: a school's
// subject headings on progress reports (school setup only, own school only).

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const URL = '/api/report-templates/subject-layout';
const SCHOOL = 'ALHAADIACADEMY';
const TEACHER_ID = '6a1f0c2e-1d3b-4c5a-9e8f-0000000000ca';
const OTHER_ADMIN_ID = '6a1f0c2e-1d3b-4c5a-9e8f-0000000000cb';

const admin = (method) => authenticatedRequest(method, URL);
const teacher = (method) => authenticatedRequest(method, URL, { userId: TEACHER_ID, role: 'TEACHER', email: 'teacher.sl@example.test', username: 'Teacher SL' });
const otherAdmin = (method) => authenticatedRequest(method, URL, { userId: OTHER_ADMIN_ID, school: 'PLAYGROUND', email: 'admin.sl@example.test' });

const SECTIONS = [
  { heading: 'Language & Literacy', subjects: [{ name: 'English Language Arts', classes: ['English'] }] },
  { heading: 'Religious Studies', subjects: [{ name: 'Quran', classes: ['Quran', 'Quran Teaching'] }, { name: 'Salaat', classes: [] }] },
];

describe('Integration: /api/report-templates/subject-layout', () => {
  let pool;
  let yearId;

  beforeAll(() => { pool = getTestPool(); });

  beforeEach(async () => {
    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = $1 AND is_active`, [SCHOOL])).rows[0].school_year_id;
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'teacher.sl@example.test', 'Teacher SL', 'hashed', 'Teacher', 'SL', $2, 'TEACHER', true, true)`,
      [TEACHER_ID, SCHOOL],
    );
    await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id, archived_at) VALUES
         ($1, '2', 'English', 'Teacher SL', $2, $3, NULL),
         ($1, '5', ' English ', 'Teacher SL', $2, $3, NULL),
         ($1, '2', 'Salaat', 'Teacher SL', $2, $3, NULL),
         ($1, 'JK', 'Circle Time', 'Teacher SL', $2, $3, NULL),
         ($1, '3', 'Old Subject', 'Teacher SL', $2, $3, NOW())`,
      [SCHOOL, TEACHER_ID, yearId],
    );
  });

  it('GET: no headings yet, with the grades 1-8 class subjects of the year', async () => {
    const res = await admin('get');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sections: [], updatedAt: null, classSubjects: ['English', 'Salaat'] });
  });

  it('PUT saves the tidied headings, GET returns them, DELETE goes back to none', async () => {
    let res = await admin('put').send({ sections: [{ ...SECTIONS[0], heading: '  Language   & Literacy ' }, SECTIONS[1]] });
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual(SECTIONS);
    expect(res.body.updatedAt).toEqual(expect.any(String));

    res = await admin('get');
    expect(res.body.sections).toEqual(SECTIONS);

    // Saving again replaces the whole list.
    res = await admin('put').send({ sections: [SECTIONS[1]] });
    expect(res.body.sections).toEqual([SECTIONS[1]]);
    const { rows } = await pool.query('SELECT sections FROM report_subject_layouts WHERE school = $1', [SCHOOL]);
    expect(rows).toHaveLength(1);

    res = await admin('delete');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sections: [], updatedAt: null });
    expect((await admin('get')).body.sections).toEqual([]);
  });

  it.each([
    ['no headings', { sections: [] }, 'Add at least one heading'],
    ['no body', {}, 'Add at least one heading'],
    ['a heading with no subjects', { sections: [{ heading: 'Math', subjects: [] }] }, 'Add a subject under "Math"'],
    [
      'a class under two subjects',
      { sections: [{ heading: 'A', subjects: [{ name: 'Quran' }, { name: 'Recitation', classes: ['quran'] }] }] },
      'Classes named "quran" are under both "Quran" and "Recitation". Keep them under one.',
    ],
  ])('PUT refuses %s with 400 and saves nothing', async (_label, body, message) => {
    const res = await admin('put').send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect((await pool.query('SELECT 1 FROM report_subject_layouts')).rows).toHaveLength(0);
  });

  it('is school setup only', async () => {
    for (const method of ['get', 'put', 'delete']) {
      const res = await teacher(method).send({ sections: SECTIONS });
      expect(res.status).toBe(403);
    }
  });

  it("never reads or changes another school's headings", async () => {
    await admin('put').send({ sections: SECTIONS });
    expect((await otherAdmin('get')).body.sections).toEqual([]);
    await otherAdmin('delete');
    expect((await admin('get')).body.sections).toEqual(SECTIONS);
  });
});
