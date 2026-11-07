// Report generation runs: pressing Generate saves a batch (a run, one item per
// student) and answers at once; the worker prints it later (its own test).
// Covers starting a run and its guards, what a page lists, and Stop, Try
// again and Dismiss. Synthetic identities only (@example.com).

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const worker = require('../../../services/reportGeneration/worker');

const ADMIN = { userId: '550e8400-e29b-41d4-a716-446655440301', username: 'Office Admin', email: 'office.admin@example.com', role: 'ADMIN' };
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440302', username: 'Layla Saleh', email: 'layla.saleh@example.com', role: 'TEACHER' };
const PARENT = { userId: '550e8400-e29b-41d4-a716-446655440303', username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const TERM = 'Term 1';
const RUNS = '/api/report-generation/runs';

describe('Integration: /api/report-generation', () => {
  let pool, yearId, kick;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const post = (url, body, who = ADMIN, status = 202, year = null) => {
    const req = authenticatedRequest('post', url, who).send(body);
    if (year) req.set('X-School-Year', year);
    return expectStatus(req, status);
  };
  const start = (studentIds, extra = {}, who = ADMIN, status = 202) => post(RUNS, { reportType: 'report_card', term: TERM, studentIds, ...extra }, who, status);
  const list = async (reportType = 'report_card', term = TERM, who = ADMIN, status = 200) => (
    await expectStatus(authenticatedRequest('get', `${RUNS}?reportType=${reportType}&term=${encodeURIComponent(term)}`, who), status)
  ).data;
  const control = (runId, action, who = ADMIN, status = 200) => post(`${RUNS}/${runId}/${action}`, {}, who, status);

  const user = (u, firstName, lastName) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, '!', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [u.userId, u.email, u.username, firstName, lastName, u.role],
  );
  const makeStudent = async (name, { school = 'ALHAADIACADEMY', year = yearId, grade = '5' } = {}) => (await pool.query(
    `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, $2, $3, $4) RETURNING student_id`,
    [name, grade, school, year],
  )).rows[0].student_id;
  // A run written straight to the tables, for states the API can't reach yet.
  const insertRun = async ({ school = 'ALHAADIACADEMY', year = yearId, reportType = 'report_card', term = TERM, students, finishedAgo = null, dismissed = false, status = 'pending' }) => {
    const { rows: [run] } = await pool.query(
      `INSERT INTO report_generation_runs (school, school_year_id, report_type, term, student_count, finished_at, dismissed_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::interval IS NULL THEN NULL ELSE NOW() - $6::interval END, CASE WHEN $7 THEN NOW() END)
       RETURNING run_id`,
      [school, year, reportType, term, students.length, finishedAgo, dismissed],
    );
    for (const [position, studentId] of students.entries()) {
      await pool.query(
        `INSERT INTO report_generation_items (run_id, student_id, position, status, finished_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'pending' THEN NULL ELSE NOW() END)`,
        [run.run_id, studentId, position, status],
      );
    }
    return run.run_id;
  };
  const items = async (runId) => (await pool.query(
    `SELECT student_id, position, status, attempts, error, claimed_until FROM report_generation_items WHERE run_id = $1 ORDER BY position`,
    [runId],
  )).rows;
  const runRow = async (runId) => (await pool.query('SELECT * FROM report_generation_runs WHERE run_id = $1', [runId])).rows[0];

  beforeEach(async () => {
    kick = jest.spyOn(worker, 'kick').mockImplementation(() => {});
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await user(ADMIN, 'Office', 'Admin');
    await user(TEACHER, 'Layla', 'Saleh');
  });

  afterEach(() => { kick.mockRestore(); });

  describe('starting a run', () => {
    it('queues a run with one item per student, in order, and answers 202', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const c = await makeStudent('Dalia Nassar');

      const body = await start([a, b, c]);
      expect(body.data.alreadyQueued).toBe(0);
      const { run } = body.data;
      expect(run).toMatchObject({
        reportType: 'report_card', term: TERM, studentCount: 3, finishedAt: null,
        createdBy: ADMIN.userId, createdByName: 'Office Admin', stalled: false,
      });
      expect(run.counts).toEqual({ pending: 3, generated: 0, failed: 0, cancelled: 0 });
      expect(run.items).toEqual([a, b, c].map((studentId) => ({ studentId, status: 'queued', error: null, finishedAt: null })));

      expect((await items(run.runId)).map((i) => [i.student_id, i.position, i.status, i.attempts])).toEqual([
        [a, 0, 'pending', 0], [b, 1, 'pending', 0], [c, 2, 'pending', 0],
      ]);
      expect(await runRow(run.runId)).toMatchObject({ school_year_id: yearId, report_date: null, created_by: ADMIN.userId });
      expect(kick).toHaveBeenCalledTimes(1);
    });

    it('a second press for the same students queues nothing', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const c = await makeStudent('Dalia Nassar');
      await start([a, b, c]);

      const again = await start([c, b, a]);
      expect(again.data).toEqual({ run: null, alreadyQueued: 3 });
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM report_generation_runs')).rows[0].n).toBe(1);
    });

    it('a second press with one new student queues only that one', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const c = await makeStudent('Dalia Nassar');
      await start([a, b]);

      const { data } = await start([a, b, c]);
      expect(data.alreadyQueued).toBe(2);
      expect(data.run.studentCount).toBe(1);
      expect(data.run.items.map((i) => i.studentId)).toEqual([c]);
    });

    it('the same students can wait for a report card and a progress report at once', async () => {
      const a = await makeStudent('Amal Haddad');
      await start([a]);
      const { data } = await start([a], { reportType: 'progress_report', reportDate: '2026-11-20' });
      expect(data.alreadyQueued).toBe(0);
      expect(data.run.reportType).toBe('progress_report');
      expect((await runRow(data.run.runId)).report_date).toBeInstanceOf(Date);
    });

    it('keeps a report date only for a progress report', async () => {
      const a = await makeStudent('Amal Haddad');
      const { data } = await start([a], { reportDate: '2026-11-20' });
      expect((await runRow(data.run.runId)).report_date).toBeNull();
    });

    it('refuses a student of another school', async () => {
      const elsewhere = await makeStudent('Sami Yusuf', { school: 'PLAYGROUND', year: null });
      await start([elsewhere], {}, ADMIN, 403);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM report_generation_runs')).rows[0].n).toBe(0);
    });

    it('refuses a student of another school year', async () => {
      const schoolId = (await pool.query(`SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`)).rows[0].school_id;
      const lastYear = (await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         VALUES ('ALHAADIACADEMY', $1, '2024-2025', '2024-09-01', '2025-06-30', false) RETURNING school_year_id`,
        [schoolId],
      )).rows[0].school_year_id;
      const thisYear = await makeStudent('Amal Haddad');
      const old = await makeStudent('Amal Haddad', { year: lastYear });

      await post(RUNS, { reportType: 'report_card', term: TERM, studentIds: [thisYear, old] }, ADMIN, 404, yearId);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM report_generation_runs')).rows[0].n).toBe(0);
    });

    it('refuses an unknown reportType, an empty list and a bad reportDate', async () => {
      const a = await makeStudent('Amal Haddad');
      await start([a], { reportType: 'transcript' }, ADMIN, 400);
      await start([], {}, ADMIN, 400);
      await start([a], { term: '' }, ADMIN, 400);
      await start([a], { reportType: 'progress_report', reportDate: '20/11/2026' }, ADMIN, 400);
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM report_generation_runs')).rows[0].n).toBe(0);
    });

    it('refuses a parent and a teacher without report_cards', async () => {
      const a = await makeStudent('Amal Haddad');
      const roleId = (await pool.query(
        `INSERT INTO staff_roles (school, name, permissions) VALUES ('ALHAADIACADEMY', 'Attendance only', '{attendance.daily}') RETURNING role_id`,
      )).rows[0].role_id;
      await pool.query('UPDATE users SET staff_role_id = $1 WHERE user_id = $2', [roleId, TEACHER.userId]);

      for (const who of [PARENT, TEACHER]) {
        await start([a], {}, who, 403);
        await list('report_card', TERM, who, 403);
      }
    });
  });

  describe('listing', () => {
    it("lists only this year's and this school's runs", async () => {
      const schoolId = (await pool.query(`SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`)).rows[0].school_id;
      const lastYear = (await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         VALUES ('ALHAADIACADEMY', $1, '2024-2025', '2024-09-01', '2025-06-30', false) RETURNING school_year_id`,
        [schoolId],
      )).rows[0].school_year_id;
      const a = await makeStudent('Amal Haddad');
      const old = await makeStudent('Amal Haddad', { year: lastYear });
      const elsewhere = await makeStudent('Sami Yusuf', { school: 'PLAYGROUND', year: null });

      const { data: { run: ours } } = await start([a]);
      await insertRun({ year: lastYear, students: [old] });
      await insertRun({ school: 'PLAYGROUND', year: null, students: [elsewhere] });
      await insertRun({ term: 'Term 2', students: [a] });
      await insertRun({ reportType: 'progress_report', students: [a] });

      expect((await list()).map((r) => r.runId)).toEqual([ours.runId]);
      const lastYearRuns = (await expectStatus(
        authenticatedRequest('get', `${RUNS}?reportType=report_card&term=${encodeURIComponent(TERM)}`, ADMIN).set('X-School-Year', lastYear), 200,
      )).data;
      expect(lastYearRuns.map((r) => r.items[0].studentId)).toEqual([old]);
    });

    it('needs a report type and a term', async () => {
      await expectStatus(authenticatedRequest('get', `${RUNS}?term=${encodeURIComponent(TERM)}`, ADMIN), 400);
      await expectStatus(authenticatedRequest('get', `${RUNS}?reportType=report_card`, ADMIN), 400);
    });

    it('a teacher with report_cards sees a run someone else started, and who started it', async () => {
      const a = await makeStudent('Amal Haddad');
      await start([a]);
      const [run] = await list('report_card', TERM, TEACHER);
      expect(run).toMatchObject({ createdBy: ADMIN.userId, createdByName: 'Office Admin' });
    });

    it('lists an item as printing while its claim is live, queued otherwise', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const { data: { run } } = await start([a, b]);

      await pool.query(`UPDATE report_generation_items SET claimed_until = NOW() + interval '1 minute' WHERE student_id = $1`, [a]);
      expect((await list())[0].items.map((i) => i.status)).toEqual(['printing', 'queued']);

      await pool.query(`UPDATE report_generation_items SET claimed_until = NOW() - interval '1 second' WHERE student_id = $1`, [a]);
      const [after] = await list();
      expect(after.items.map((i) => i.status)).toEqual(['queued', 'queued']);
      expect(after.counts.pending).toBe(2);
      expect(after.runId).toBe(run.runId);
    });

    it('marks a run stalled after 5 minutes without a finished item', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const { data: { run } } = await start([a, b]);
      expect((await list())[0].stalled).toBe(false);

      await pool.query(`UPDATE report_generation_runs SET queued_at = NOW() - interval '6 minutes', created_at = NOW() - interval '6 minutes' WHERE run_id = $1`, [run.runId]);
      expect((await list())[0].stalled).toBe(true);

      // One report just finished: moving again.
      await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW() WHERE student_id = $1`, [a]);
      expect((await list())[0].stalled).toBe(false);

      // Nothing left to print is never stalled.
      await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW() - interval '6 minutes'`);
      expect((await list())[0].stalled).toBe(false);
    });

    it("the owner's stuck-queue alert counts a run that hasn't moved in 15 minutes", async () => {
      const { slowReadings } = require('../../../services/observe/alerts/probes');
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const { data: { run } } = await start([a, b]);
      expect((await slowReadings()).reportQueueStuck).toBe(0);

      await pool.query(`UPDATE report_generation_runs SET queued_at = NOW() - interval '16 minutes' WHERE run_id = $1`, [run.runId]);
      expect((await slowReadings()).reportQueueStuck).toBe(1);

      await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW() - interval '1 minute' WHERE student_id = $1`, [a]);
      expect((await slowReadings()).reportQueueStuck).toBe(0);
    });

    it('stops listing a dismissed run, a run finished 15 days ago, and a one-student run finished 2 minutes ago', async () => {
      const ids = [];
      for (const name of ['Amal Haddad', 'Bilal Karim', 'Dalia Nassar', 'Sami Yusuf', 'Rania Karim', 'Omar Haddad', 'Hana Saleh']) ids.push(await makeStudent(name));
      const [a, b, c, d, e, f, g] = ids;
      await insertRun({ students: [a, b], finishedAgo: '1 hour', dismissed: true, status: 'generated' });
      await insertRun({ students: [c, d], finishedAgo: '15 days', status: 'generated' });
      await insertRun({ students: [e], finishedAgo: '2 minutes', status: 'generated' });
      const justNow = await insertRun({ students: [f], finishedAgo: '10 seconds', status: 'generated' });
      const twoDays = await insertRun({ students: [g, a], finishedAgo: '2 days', status: 'failed' });

      const listed = await list();
      expect(listed.map((r) => r.runId).sort()).toEqual([justNow, twoDays].sort());
      expect(listed.find((r) => r.runId === twoDays).counts).toEqual({ pending: 0, generated: 0, failed: 2, cancelled: 0 });
    });
  });

  describe('Stop, Try again and Dismiss', () => {
    it('cancel drops pending items, leaves a printing item, and finishes the run when nothing is left', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const c = await makeStudent('Dalia Nassar');
      const { data: { run } } = await start([a, b, c]);
      await pool.query(`UPDATE report_generation_items SET claimed_until = NOW() + interval '2 minutes', attempts = 1 WHERE student_id = $1`, [a]);

      const { data: stopped } = await control(run.runId, 'cancel');
      expect(stopped.items.map((i) => i.status)).toEqual(['printing', 'cancelled', 'cancelled']);
      expect(stopped.finishedAt).toBeNull();

      // The report that was printing finishes; Stop again closes the run.
      await pool.query(`UPDATE report_generation_items SET status = 'generated', claimed_until = NULL, finished_at = NOW() WHERE student_id = $1`, [a]);
      const { data: done } = await control(run.runId, 'cancel');
      expect(done.counts).toEqual({ pending: 0, generated: 1, failed: 0, cancelled: 2 });
      expect(done.finishedAt).not.toBeNull();
    });

    it('cancel of a run with nothing printing finishes it at once', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const { data: { run } } = await start([a, b]);
      const { data } = await control(run.runId, 'cancel');
      expect(data.counts.cancelled).toBe(2);
      expect(data.finishedAt).not.toBeNull();
    });

    it('retry puts failed items back with attempts 0 and clears finished_at and dismissed_at', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const runId = await insertRun({ students: [a, b], finishedAgo: '1 hour', dismissed: true, status: 'generated' });
      await pool.query(
        `UPDATE report_generation_items SET status = 'failed', attempts = 3, error = 'No classes found for this student' WHERE student_id = $1`,
        [a],
      );

      const { data } = await control(runId, 'retry');
      expect(data.finishedAt).toBeNull();
      expect(data.items).toEqual([
        { studentId: a, status: 'queued', error: null, finishedAt: null },
        { studentId: b, status: 'generated', error: null, finishedAt: expect.any(String) },
      ]);
      expect((await items(runId))[0]).toMatchObject({ status: 'pending', attempts: 0, error: null, claimed_until: null });
      expect((await runRow(runId)).dismissed_at).toBeNull();
      expect(kick).toHaveBeenCalledTimes(1);
      expect((await list()).map((r) => r.runId)).toEqual([runId]);
    });

    it('retry leaves a student who is already waiting in another run where they are', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const runId = await insertRun({ students: [a, b], finishedAgo: '1 hour', status: 'failed' });
      await start([a]);

      const { data } = await control(runId, 'retry');
      expect(data.items.map((i) => [i.studentId, i.status])).toEqual([[a, 'failed'], [b, 'queued']]);
    });

    it('retry with studentIds puts back only those students', async () => {
      const a = await makeStudent('Amal Haddad');
      const b = await makeStudent('Bilal Karim');
      const c = await makeStudent('Dalia Nassar');
      const runId = await insertRun({ students: [a, b, c], finishedAgo: '1 hour', status: 'failed' });

      const { data } = await post(`${RUNS}/${runId}/retry`, { studentIds: [a, c] }, ADMIN, 200);
      expect(data.items.map((i) => [i.studentId, i.status])).toEqual([[a, 'queued'], [b, 'failed'], [c, 'queued']]);
      await post(`${RUNS}/${runId}/retry`, { studentIds: ['not-a-student'] }, ADMIN, 400);
    });

    it('dismiss refuses a run that is still going', async () => {
      const a = await makeStudent('Amal Haddad');
      const { data: { run } } = await start([a]);
      await control(run.runId, 'dismiss', ADMIN, 409);

      await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW()`);
      await pool.query(`UPDATE report_generation_runs SET finished_at = NOW()`);
      await control(run.runId, 'dismiss');
      expect(await list()).toEqual([]);
    });

    it("cancel, retry and dismiss answer 404 for another school's run", async () => {
      const elsewhere = await makeStudent('Sami Yusuf', { school: 'PLAYGROUND', year: null });
      const runId = await insertRun({ school: 'PLAYGROUND', year: null, students: [elsewhere], finishedAgo: '1 minute', status: 'failed' });
      for (const action of ['cancel', 'retry', 'dismiss']) {
        await control(runId, action, ADMIN, 404);
        await control('not-a-run', action, ADMIN, 404);
      }
      expect((await items(runId))[0].status).toBe('failed');
    });
  });
});
