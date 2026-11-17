// Salaat on the grades 1-8 progress report: GET/PUT /api/progress-reports/salaat.
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const HOMEROOM = '550e8400-e29b-41d4-a716-446655440051';
const OTHER_TEACHER = '550e8400-e29b-41d4-a716-446655440052';
const T1 = 'Term 1';

const asHomeroom = (method, url) => authenticatedRequest(method, url, { userId: HOMEROOM, role: 'TEACHER', username: 'Homeroom Teacher' });
const asOther = (method, url) => authenticatedRequest(method, url, { userId: OTHER_TEACHER, role: 'TEACHER', username: 'Other Teacher' });

describe('progress report Salaat', () => {
  let pool, mine, mineJK, notMine;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, honorific) VALUES
       ($1, 'homeroom@salaat.test', 'Homeroom Teacher', 'hashed', 'Homa', 'Room', 'ALHAADIACADEMY', 'TEACHER', true, true, 'Ms.'),
       ($2, 'other@salaat.test', 'Other Teacher', 'hashed', 'Otto', 'Ther', 'ALHAADIACADEMY', 'TEACHER', true, true, NULL)`,
      [HOMEROOM, OTHER_TEACHER]);
    // Production stamps every student with a school year; the request reads the active one.
    const { rows: [year] } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    const { rows } = await pool.query(
      `INSERT INTO students (name, grade, school, homeroom_teacher_id, school_year_id) VALUES
       ('Amira Sample', '4', 'ALHAADIACADEMY', $1, $3),
       ('Kenzo Sample', 'SK', 'ALHAADIACADEMY', $1, $3),
       ('Bilal Sample', '4', 'ALHAADIACADEMY', $2, $3),
       ('Last Year Sample', '4', 'ALHAADIACADEMY', $1, NULL)
       RETURNING student_id, name`, [HOMEROOM, OTHER_TEACHER, year.school_year_id]);
    const id = (name) => rows.find((r) => r.name === name).student_id;
    mine = id('Amira Sample');
    mineJK = id('Kenzo Sample');
    notMine = id('Bilal Sample');
  });

  const turnOn = () => pool.query(`UPDATE schools SET progress_salaat = TRUE WHERE school_code = 'ALHAADIACADEMY'`);

  it('is off until the school turns it on: nothing listed, nothing saved', async () => {
    const list = await asHomeroom('get', `/api/progress-reports/salaat?term=${encodeURIComponent(T1)}`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual({ enabled: false, canEditAll: false, students: [] });

    const save = await asHomeroom('put', `/api/progress-reports/salaat/${mine}`).send({ term: T1, workHabit: 'E' });
    expect(save.status).toBe(404);
  });

  it("lists a homeroom teacher's own grades 1-8 students, and everyone's for an admin", async () => {
    await turnOn();
    const teacher = await asHomeroom('get', `/api/progress-reports/salaat?term=${encodeURIComponent(T1)}`);
    expect(teacher.status).toBe(200);
    expect(teacher.body.data).toMatchObject({ enabled: true, canEditAll: false });
    expect(teacher.body.data.students).toEqual([
      expect.objectContaining({ studentId: mine, name: 'Amira Sample', grade: '4', homeroomTeacher: 'Ms. Homa Room', workHabit: '', behavior: '', comment: '' }),
    ]);

    const admin = await authenticatedRequest('get', `/api/progress-reports/salaat?term=${encodeURIComponent(T1)}`);
    expect(admin.body.data.canEditAll).toBe(true);
    expect(admin.body.data.students.map((s) => s.name)).toEqual(['Amira Sample', 'Bilal Sample']); // no SK
  });

  it('saves, updates and clears the homeroom teacher\'s entry for the term', async () => {
    await turnOn();
    const saved = await asHomeroom('put', `/api/progress-reports/salaat/${mine}`).send({ term: T1, workHabit: 'g', behavior: 'E', comment: '  Prays on time.  ' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ workHabit: 'G', behavior: 'E', comment: 'Prays on time.' });

    await asHomeroom('put', `/api/progress-reports/salaat/${mine}`).send({ term: T1, workHabit: 'S', behavior: '', comment: 'Prays on time.' });
    const list = await asHomeroom('get', `/api/progress-reports/salaat?term=${encodeURIComponent(T1)}`);
    expect(list.body.data.students[0]).toMatchObject({ workHabit: 'S', behavior: '', comment: 'Prays on time.' });
    // Another term is its own entry.
    const t2 = await asHomeroom('get', `/api/progress-reports/salaat?term=${encodeURIComponent('Term 2')}`);
    expect(t2.body.data.students[0]).toMatchObject({ workHabit: '', comment: '' });

    const cleared = await asHomeroom('put', `/api/progress-reports/salaat/${mine}`).send({ term: T1, workHabit: '', behavior: null, comment: ' ' });
    expect(cleared.status).toBe(200);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM progress_report_salaat`);
    expect(rows[0].n).toBe(0);
  });

  it("refuses another teacher's student, a kindergarten student, a bad rating and a missing term; an admin may fill in anyone", async () => {
    await turnOn();
    expect((await asOther('put', `/api/progress-reports/salaat/${mine}`).send({ term: T1, workHabit: 'E' })).status).toBe(403);
    expect((await asHomeroom('put', `/api/progress-reports/salaat/${mineJK}`).send({ term: T1, workHabit: 'E' })).status).toBe(400);
    expect((await asHomeroom('put', `/api/progress-reports/salaat/${mine}`).send({ term: T1, workHabit: 'A' })).status).toBe(400);
    expect((await asHomeroom('put', `/api/progress-reports/salaat/${mine}`).send({ workHabit: 'E' })).status).toBe(400);
    expect((await asHomeroom('put', `/api/progress-reports/salaat/not-a-uuid`).send({ term: T1, workHabit: 'E' })).status).toBe(404);

    const admin = await authenticatedRequest('put', `/api/progress-reports/salaat/${notMine}`).send({ term: T1, behavior: 'N' });
    expect(admin.status).toBe(200);
    expect(admin.body.data).toMatchObject({ workHabit: '', behavior: 'N' });
  });

  it('refuses parents', async () => {
    await turnOn();
    const res = await authenticatedRequest('get', `/api/progress-reports/salaat?term=${encodeURIComponent(T1)}`, { role: 'PARENT', userId: '550e8400-e29b-41d4-a716-446655440099' });
    expect(res.status).toBe(403);
  });
});
