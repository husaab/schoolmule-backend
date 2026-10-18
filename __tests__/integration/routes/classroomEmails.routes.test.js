// Classroom emails (spec §7): new work, due-tomorrow reminders and bundled
// grades to students; the parents' missing-work alert and weekly (or daily)
// summary; the parents' email preferences. One outbox (classroom_email_jobs)
// keyed by recipient address, kind and digest key, so re-running an enqueue
// never sends twice. The scheduled kinds run with an injected `now` (a fixed
// Friday in 2030, Toronto time) and fixtures stamped relative to it.
// Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const engine = require('../../../services/analyticsEngine');
const notifier = require('../../../services/messageNotifier');
const classroom = require('../../../services/classroom/classroomNotifier');
const { gradedBucket } = require('../../../services/classroom/classroomDigest');
const { getResend } = require('../../../utils/emailUtils');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MONA_ID = '550e8400-e29b-41d4-a716-446655440004';
const RANIA_ID = '550e8400-e29b-41d4-a716-446655440005';
const HUDA_ID = '550e8400-e29b-41d4-a716-446655440006';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const BILAL_USER_ID = '550e8400-e29b-41d4-a716-446655440011';
const SAMI_USER_ID = '550e8400-e29b-41d4-a716-446655440012';
const DALIA_USER_ID = '550e8400-e29b-41d4-a716-446655440013';

const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asMona = { userId: MONA_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const student = (userId, username, email) => ({ userId, username, email, role: 'STUDENT', roles: ['STUDENT'] });
const asAmal = student(AMAL_USER_ID, 'Amal Haddad', 'amal.haddad@example.com');
const asBilal = student(BILAL_USER_ID, 'Bilal Karim', 'bilal.karim@example.com');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();
// Friday Oct 18, 2030, 16:30 in Toronto (EDT, UTC-4): the school's summary day.
const FRIDAY = new Date('2030-10-18T20:30:00Z');
const hoursFrom = (base, h) => new Date(base.getTime() + h * HOUR_MS);

describe('Integration: classroom emails', () => {
  let pool, yearId, termId, sciId, engId, homeworkId;
  let amalId, bilalId, samiId, daliaId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, `${first} ${last}`, password, first, last, role],
  );
  const makeClass = async (subject, grade) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', $1, $2, 'Ziad Teacher', $3, $4, 'Term 1', $5) RETURNING class_id`,
    [grade, subject, TEACHER_ID, termId, yearId],
  )).rows[0].class_id;
  const makeStudent = async (name, grade, classId, loginId) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, $2, 'ALHAADIACADEMY', $3) RETURNING student_id`,
      [name, grade, yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    if (loginId) {
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [loginId, id, yearId]);
      await pool.query(`INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())`, [loginId]);
    }
    return id;
  };
  const guardian = (parentId, studentId, name, email) => pool.query(
    `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school)
     VALUES ($1, $2, $3, $4, 'Mother', 'ALHAADIACADEMY')`,
    [parentId, studentId, name, email],
  );
  const settings = (patch) => pool.query(
    `UPDATE school_classroom_settings SET ${Object.keys(patch).map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE school = 'ALHAADIACADEMY'`,
    Object.values(patch),
  );

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const post = (url, body, who = asTeacher, status = 200) => expectStatus(authenticatedRequest('post', url, who).send(body), status);
  const patchReq = (url, body, who = asTeacher, status = 200) => expectStatus(authenticatedRequest('patch', url, who).send(body), status);
  const createItem = async (classId, body) => (await post(`/api/classroom/classes/${classId}/items`, body, asTeacher, 201)).data;
  const editItem = async (itemId, body) => (await patchReq(`/api/classroom/items/${itemId}`, body)).data;
  const assignment = (extra = {}) => createItem(sciId, {
    kind: 'assignment', title: 'Plant cell diagram', instructions: 'Label six parts.', submissionMode: 'done', dueAt: inDays(2), ...extra,
  });
  const turnIn = (itemId, who) => post(`/api/student/items/${itemId}/turn-in`, undefined, who);

  const jobs = async (kind, extra = '') => (await pool.query(
    `SELECT * FROM classroom_email_jobs WHERE kind = $1 ${extra} ORDER BY recipient_email, digest_key`, [kind],
  )).rows;
  const sent = () => getResend().emails.send.mock.calls.map(([msg]) => msg);
  const reload = async (jobId) => (await pool.query(`SELECT * FROM classroom_email_jobs WHERE job_id = $1`, [jobId])).rows[0];
  const processJob = async (job, now) => {
    const outcome = await classroom.processClassroomJob(job, now ? { now } : {});
    return { outcome, row: await reload(job.job_id) };
  };
  // The email as a reader sees it.
  const text = (html) => html.replace(/<\/?(a|strong|em|b|span)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  // A graded column published to one student at `at`, with feedback.
  const publishGrade = async ({ itemId, assessmentId, studentId, score, feedback = null, at }) => {
    await pool.query(
      `INSERT INTO classwork_submissions (item_id, student_id, turned_in_at, draft_score, draft_status, feedback, published_at)
       VALUES ($1, $2, $3::timestamptz - interval '1 day', $4, 'graded', $5, $3)
       ON CONFLICT (item_id, student_id) DO UPDATE SET draft_score = EXCLUDED.draft_score, feedback = EXCLUDED.feedback,
         published_at = EXCLUDED.published_at, turned_in_at = EXCLUDED.turned_in_at`,
      [itemId, studentId, at, score, feedback],
    );
    await pool.query(
      `INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, $3, 'graded')
       ON CONFLICT (student_id, assessment_id) DO UPDATE SET score = EXCLUDED.score`,
      [studentId, assessmentId, score],
    );
    await pool.query(`UPDATE assessments SET is_published = TRUE, published_at = $2 WHERE assessment_id = $1`, [assessmentId, at]);
  };

  beforeEach(async () => {
    supabase._reset();
    engine.invalidateCache();
    getResend().emails.send.mockClear();
    classroom.resetScheduleState();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2031-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;

    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MONA_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(RANIA_ID, 'rania.karim@example.com', 'Rania', 'Karim', 'PARENT');
    await user(HUDA_ID, 'huda.saleh@example.com', 'Huda', 'Saleh', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await user(BILAL_USER_ID, 'bilal.karim@example.com', 'Bilal', 'Karim', 'STUDENT');
    await user(SAMI_USER_ID, 'sami.haddad@example.com', 'Sami', 'Haddad', 'STUDENT');
    await user(DALIA_USER_ID, 'dalia.nassar@example.com', 'Dalia', 'Nassar', 'STUDENT', '!'); // invite pending
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    sciId = await makeClass('Science', '5');
    engId = await makeClass('English', '3');
    amalId = await makeStudent('Amal Haddad', '5', sciId, AMAL_USER_ID);
    bilalId = await makeStudent('Bilal Karim', '5', sciId, BILAL_USER_ID);
    daliaId = await makeStudent('Dalia Nassar', '5', sciId, DALIA_USER_ID);
    samiId = await makeStudent('Sami Haddad', '3', engId, SAMI_USER_ID);
    await guardian(MONA_ID, amalId, 'Mona Haddad', 'mona.haddad@example.com');
    await guardian(MONA_ID, samiId, 'Mona Haddad', 'mona.haddad@example.com');
    await guardian(RANIA_ID, bilalId, 'Rania Karim', 'rania.karim@example.com');

    homeworkId = (await pool.query(
      `INSERT INTO assessments (class_id, name, is_parent, weight_points) VALUES ($1, 'Homework', TRUE, 40) RETURNING assessment_id`, [sciId],
    )).rows[0].assessment_id;
  });

  it('posting an assignment with email_students queues one new_work job per eligible student; re-saving does not queue again', async () => {
    const item = await assignment();
    let rows = await jobs('new_work');
    expect(rows.map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com', 'bilal.karim@example.com']);
    for (const r of rows) {
      expect(r).toMatchObject({ digest_key: `item:${item.itemId}`, status: 'pending', school: 'ALHAADIACADEMY' });
      expect(r.payload.itemId).toBe(item.itemId);
      // Two minutes to coalesce a quick edit or an unpost.
      const wait = new Date(r.send_after) - new Date(r.created_at);
      expect(wait).toBeGreaterThan(100 * 1000);
      expect(wait).toBeLessThan(140 * 1000);
    }
    expect(rows.map((r) => r.recipient_id).sort()).toEqual([AMAL_USER_ID, BILAL_USER_ID]);

    // Re-saving, unposting and posting again: still one job each.
    await editItem(item.itemId, { title: 'Plant cell diagram (labelled)' });
    await editItem(item.itemId, { status: 'draft' });
    await editItem(item.itemId, { status: 'posted' });
    rows = await jobs('new_work');
    expect(rows).toHaveLength(2);

    // A draft queues nothing until it is posted; "don't email students" never queues.
    const draft = await assignment({ title: 'Seed journal', status: 'draft' });
    expect(await jobs('new_work', `AND digest_key = 'item:${draft.itemId}'`)).toEqual([]);
    await editItem(draft.itemId, { status: 'posted' });
    expect(await jobs('new_work', `AND digest_key = 'item:${draft.itemId}'`)).toHaveLength(2);
    const quiet = await assignment({ title: 'Leaf rubbing', emailStudents: false });
    expect(await jobs('new_work', `AND digest_key = 'item:${quiet.itemId}'`)).toEqual([]);

    // An item for chosen students reaches only them.
    const some = await assignment({ title: 'Catch-up sheet', audience: 'some', studentIds: [bilalId] });
    expect((await jobs('new_work', `AND digest_key = 'item:${some.itemId}'`)).map((r) => r.recipient_email)).toEqual(['bilal.karim@example.com']);

    // Unposted when the email was due: skipped; posted again: it goes after all, once.
    await editItem(some.itemId, { status: 'draft' });
    const [held] = await jobs('new_work', `AND digest_key = 'item:${some.itemId}'`);
    expect((await processJob(held)).row).toMatchObject({ status: 'skipped', last_error: 'not posted' });
    await editItem(some.itemId, { status: 'posted' });
    const [revived] = await jobs('new_work', `AND digest_key = 'item:${some.itemId}'`);
    expect(revived).toMatchObject({ job_id: held.job_id, status: 'pending', last_error: null, attempts: 0 });
    expect((await processJob(revived)).outcome).toBe('sent');
    await editItem(some.itemId, { status: 'draft' });
    await editItem(some.itemId, { status: 'posted' });
    expect((await jobs('new_work', `AND digest_key = 'item:${some.itemId}'`))[0]).toMatchObject({ status: 'sent' });
    expect(sent().filter((m) => m.to[0] === 'bilal.karim@example.com')).toHaveLength(1);
  });

  it('a scheduled item queues new_work when it is promoted', async () => {
    const item = await assignment({ status: 'scheduled', publishAt: new Date(Date.now() + HOUR_MS).toISOString() });
    expect(await jobs('new_work')).toEqual([]);

    await pool.query(`UPDATE classwork_items SET publish_at = NOW() - interval '1 minute' WHERE item_id = $1`, [item.itemId]);
    await notifier.classroomTick();

    const { rows: [row] } = await pool.query(`SELECT status, posted_at, publish_at FROM classwork_items WHERE item_id = $1`, [item.itemId]);
    expect(row.status).toBe('posted');
    const rows = await jobs('new_work');
    expect(rows.map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com', 'bilal.karim@example.com']);
    expect(rows.every((r) => r.digest_key === `item:${item.itemId}`)).toBe(true);
  });

  it('no student jobs when classrooms are off, student email is off, or the account is invite-pending', async () => {
    const titles = ['Off', 'Email off', 'Email above grade', 'Login above grade'];
    const changes = [
      { enabled: false },
      { enabled: true, student_email_from_grade: null },
      { student_email_from_grade: '6' },
      { student_email_from_grade: '1', login_from_grade: '6' },
    ];
    for (let n = 0; n < changes.length; n += 1) {
      await settings(changes[n]);
      await assignment({ title: titles[n] });
      expect(await jobs('new_work')).toEqual([]);
    }

    // Back on: Dalia (invite pending) never gets one; neither does a login without consent.
    await settings({ login_from_grade: '1' });
    await pool.query(`UPDATE student_accounts SET consent_at = NULL WHERE user_id = $1`, [BILAL_USER_ID]);
    const item = await assignment({ title: 'Back on' });
    expect((await jobs('new_work')).map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com']);

    // Re-checked at send time: the school turns student email off inside the window.
    await settings({ student_email_from_grade: null });
    const [job] = await jobs('new_work');
    const { outcome, row } = await processJob(job);
    expect(outcome).toBe('skipped');
    expect(row).toMatchObject({ status: 'skipped', last_error: 'student email off' });

    // And an item deleted inside the window is never emailed.
    await settings({ student_email_from_grade: '1' });
    await pool.query(`UPDATE classroom_email_jobs SET status = 'pending', last_error = NULL WHERE job_id = $1`, [job.job_id]);
    await expectStatus(authenticatedRequest('delete', `/api/classroom/items/${item.itemId}`, asTeacher), 200);
    expect((await processJob(job)).row).toMatchObject({ status: 'skipped', last_error: 'item removed' });
    expect(sent()).toEqual([]);
  });

  it('due reminders: only not-turned-in items due tomorrow with remind_students, one email per student', async () => {
    // Wednesday Oct 16, 2030 at 17:30 Toronto; "tomorrow" is Thursday Oct 17.
    const wed = new Date('2030-10-16T21:30:00Z');
    const a = await assignment({ title: 'Plant cell diagram', dueAt: '2030-10-18T03:59:00Z' }); // Thu 23:59
    const b = await assignment({ title: 'Seed journal', dueAt: '2030-10-17T12:00:00Z' }); // Thu 08:00
    await assignment({ title: 'Leaf rubbing', dueAt: '2030-10-17T20:00:00Z', remindStudents: false });
    await assignment({ title: 'Cell model', dueAt: '2030-10-18T20:00:00Z' }); // Friday
    await assignment({ title: 'Class photo day', dueAt: '2030-10-17T20:00:00Z', submissionMode: 'none' }); // nothing to turn in
    await turnIn(a.itemId, asBilal);
    await turnIn(b.itemId, asBilal);

    await classroom.runSchedule(hoursFrom(wed, -1)); // 16:30: too early for reminders
    expect(await jobs('due_reminder')).toEqual([]);

    await classroom.runSchedule(wed);
    classroom.resetScheduleState(); // a restart re-runs the sweep: the digest key keeps it to one
    await classroom.runSchedule(wed);
    const rows = await jobs('due_reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_email: 'amal.haddad@example.com', digest_key: 'due:2030-10-17', recipient_id: AMAL_USER_ID });

    // Content is read at send time: what Amal turned in meanwhile drops out.
    await turnIn(b.itemId, asAmal);
    const { outcome } = await processJob(rows[0], wed);
    expect(outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['amal.haddad@example.com']);
    expect(email.subject).toBe('Due tomorrow: Plant cell diagram');
    expect(text(email.html)).toContain('Plant cell diagram · Science · due 11:59 PM');
    for (const other of ['Seed journal', 'Leaf rubbing', 'Cell model', 'Class photo day']) expect(email.html).not.toContain(other);
    expect(email.html).toContain(`http://localhost:3000/student/items/${a.itemId}`);
  });

  it('missing alert: one email per family covering two siblings; none when prefs.missing_alerts is false', async () => {
    // Amal: derived Missing, due three hours ago and not turned in.
    await assignment({ title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString() });
    // Sami: a teacher-confirmed Missing published two hours ago.
    const spelling = (await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, date, is_published, published_at)
       VALUES ($1, 'Spelling list 4', 10, DATE '2030-10-17', TRUE, $2) RETURNING assessment_id`, [engId, hoursFrom(FRIDAY, -2)],
    )).rows[0].assessment_id;
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, NULL, 'missing')`, [samiId, spelling]);
    // Bilal turned it in, so Rania's family has nothing new.
    await pool.query(
      `INSERT INTO classwork_submissions (item_id, student_id, turned_in_at)
       SELECT item_id, $1, NOW() FROM classwork_items WHERE class_id = $2 AND kind = 'assignment'`, [bilalId, sciId],
    );

    await classroom.runSchedule(hoursFrom(FRIDAY, -1)); // 15:30
    expect(await jobs('missing_alert')).toEqual([]);
    await classroom.runSchedule(FRIDAY);
    const rows = await jobs('missing_alert');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_email: 'mona.haddad@example.com', digest_key: 'missing:2030-10-18', recipient_id: MONA_ID });

    expect((await processJob(rows[0], FRIDAY)).outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['mona.haddad@example.com']);
    expect(email.subject).toBe('Missing work: Amal (1), Sami (1)');
    const body = text(email.html);
    expect(body).toContain('Amal · Grade 5');
    expect(body).toContain('Plant cell diagram · Science · was due Fri, Oct 18');
    expect(body).toContain('Sami · Grade 3');
    expect(body).toContain('Spelling list 4 · English');
    expect(email.html).toContain('http://localhost:3000/parent/classes');

    // Alerts off: no job at all, and a pending one is skipped at send time.
    await pool.query(`DELETE FROM classroom_email_jobs`);
    await pool.query(`INSERT INTO notification_prefs (user_id, missing_alerts) VALUES ($1, FALSE)`, [MONA_ID]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    expect(await jobs('missing_alert')).toEqual([]);
    await pool.query(`UPDATE notification_prefs SET missing_alerts = TRUE WHERE user_id = $1`, [MONA_ID]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    const [again] = await jobs('missing_alert');
    await pool.query(`UPDATE notification_prefs SET missing_alerts = FALSE WHERE user_id = $1`, [MONA_ID]);
    expect((await processJob(again, FRIDAY)).row).toMatchObject({ status: 'skipped', last_error: 'prefs off' });

    // A family whose only news is a derived Missing (judged at the scheduler's clock) is alerted too.
    await pool.query(`DELETE FROM classwork_submissions WHERE student_id = $1`, [bilalId]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    expect((await jobs('missing_alert')).map((r) => r.recipient_email)).toContain('rania.karim@example.com');
    // A day later it is no longer news.
    await pool.query(`DELETE FROM classroom_email_jobs`);
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 24));
    expect(await jobs('missing_alert')).toEqual([]);
  });

  it("weekly summary on the school's day; skipped when every section is empty; a daily-frequency parent gets one each day", async () => {
    // Amal: one Missing, one new grade with feedback, one due next week, one post asking for "Got it".
    await assignment({ title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -27).toISOString() });
    const journal = await assignment({ title: 'Seed journal', dueAt: hoursFrom(FRIDAY, -50).toISOString(), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    await publishGrade({
      itemId: journal.itemId, assessmentId: journal.gradebook.assessmentId, studentId: amalId, score: 8,
      feedback: 'Great labels.', at: hoursFrom(FRIDAY, -5),
    });
    await assignment({ title: 'Cell model', dueAt: '2030-10-21T20:00:00Z' }); // Monday
    const post = (await pool.query(
      `INSERT INTO announcements (school, school_year_id, scope, class_id, title, body, author_id, author_role, published_at, ack_requested)
       VALUES ('ALHAADIACADEMY', $1, 'class', $2, 'Science Centre trip', 'Please sign the permission form by Monday.', $3, 'TEACHER', $4, TRUE)
       RETURNING announcement_id`, [yearId, sciId, TEACHER_ID, hoursFrom(FRIDAY, -24)],
    )).rows[0].announcement_id;
    // Huda's child is in a class where nothing happened this week.
    const artId = await makeClass('Art', '4');
    const omarId = await makeStudent('Omar Saleh', '4', artId, null);
    await guardian(HUDA_ID, omarId, 'Huda Saleh', 'huda.saleh@example.com');

    await classroom.runSchedule(new Date('2030-10-17T20:30:00Z')); // Thursday 16:30
    expect(await jobs('weekly_summary')).toEqual([]);
    await classroom.runSchedule(hoursFrom(FRIDAY, -1)); // Friday 15:30
    expect(await jobs('weekly_summary')).toEqual([]);
    await classroom.runSchedule(FRIDAY);
    const rows = await jobs('weekly_summary');
    expect(rows.map((r) => [r.recipient_email, r.digest_key])).toEqual([
      ['huda.saleh@example.com', 'weekly:2030-W42'],
      ['mona.haddad@example.com', 'weekly:2030-W42'],
      ['rania.karim@example.com', 'weekly:2030-W42'],
    ]);

    const byEmail = Object.fromEntries(rows.map((r) => [r.recipient_email, r]));
    expect((await processJob(byEmail['huda.saleh@example.com'], FRIDAY)).row).toMatchObject({ status: 'skipped', last_error: 'nothing to report' });
    expect((await processJob(byEmail['mona.haddad@example.com'], FRIDAY)).outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['mona.haddad@example.com']);
    // Sami has nothing this week, so Sami is left out of the subject and the body;
    // a child's subject part keeps the two most pressing counts.
    expect(email.subject).toBe('Your week: Amal has 1 missing, 1 new grade');
    const body = text(email.html);
    expect(body).toContain('Your week: Oct 14–18');
    expect(body).toContain("Here's what happened in Amal's classes this week.");
    expect(body).toContain('Amal · Grade 5');
    expect(body).toContain('Plant cell diagram · Science · was due Thu, Oct 17');
    expect(body).toContain('Seed journal · Science 8/10');
    expect(body).toContain('"Great labels." Ziad Teacher');
    expect(body).toContain('Cell model · Science Mon');
    expect(body).toContain('Science Centre trip Ziad Teacher · Please sign the permission form by Monday.');
    expect(email.html).toContain(`/parent/messages?tab=announcements&amp;announcement=${post}&amp;ack=1`);
    expect(body).toContain('You get this summary on Fridays.');
    expect(email.html).toContain('http://localhost:3000/parent/notifications?set=daily');
    expect(email.html).toContain('http://localhost:3000/parent/notifications?set=off');
    expect(body).not.toContain('Sami');

    // A parent's own day overrides the school's.
    await pool.query(`INSERT INTO notification_prefs (user_id, summary_dow) VALUES ($1, 1)`, [MONA_ID]);
    const monday = new Date('2030-10-21T20:30:00Z');
    // Daily: one each day, the weekly parents get nothing on those days.
    await pool.query(`INSERT INTO notification_prefs (user_id, summary_frequency) VALUES ($1, 'daily')`, [RANIA_ID]);
    await pool.query(`DELETE FROM classroom_email_jobs`);
    for (const day of [new Date('2030-10-19T20:30:00Z'), new Date('2030-10-20T20:30:00Z'), monday]) await classroom.runSchedule(day);
    expect((await jobs('weekly_summary')).map((r) => [r.recipient_email, r.digest_key])).toEqual([
      ['mona.haddad@example.com', 'weekly:2030-W43'],
      ['rania.karim@example.com', 'daily:2030-10-19'],
      ['rania.karim@example.com', 'daily:2030-10-20'],
      ['rania.karim@example.com', 'daily:2030-10-21'],
    ]);
  });

  it('two publishes inside one 15-minute bucket produce one graded job listing both grades', async () => {
    const graded = (title) => assignment({ title, gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    const first = await graded('Plant cell diagram');
    const second = await graded('Seed journal');
    for (const it of [first, second]) await turnIn(it.itemId, asAmal);
    await patchReq(`/api/classroom/items/${first.itemId}/submissions/${amalId}`, { draftScore: 8, feedback: 'Great labels.' });
    await patchReq(`/api/classroom/items/${second.itemId}/submissions/${amalId}`, { draftScore: 9 });

    const before = gradedBucket(new Date());
    await post(`/api/classroom/items/${first.itemId}/publish`, { studentIds: [amalId] });
    await post(`/api/classroom/items/${second.itemId}/publish`, { studentIds: [amalId] });
    const after = gradedBucket(new Date());

    let rows = await jobs('graded');
    expect(rows.every((r) => r.recipient_email === 'amal.haddad@example.com')).toBe(true);
    if (before.key === after.key) {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ digest_key: before.key, recipient_id: AMAL_USER_ID });
      expect(new Date(rows[0].send_after).toISOString()).toBe(before.end.toISOString());
    }
    // Enqueueing again inside the bucket changes nothing.
    const last = rows[rows.length - 1];
    const lastBucketStart = new Date(last.digest_key.slice('graded:'.length));
    await classroom.enqueueGraded({ school: 'ALHAADIACADEMY', studentIds: [amalId], now: new Date(lastBucketStart.getTime() + 60 * 1000) });
    rows = await jobs('graded');
    expect(rows[rows.length - 1].job_id).toBe(last.job_id);
    expect(rows).toHaveLength(before.key === after.key ? 1 : rows.length);

    expect((await processJob(last)).outcome).toBe('sent');
    const email = sent().find((m) => m.to[0] === 'amal.haddad@example.com');
    expect(email.subject).toBe('Graded: Plant cell diagram and 1 more');
    const body = text(email.html);
    expect(body).toContain('Plant cell diagram · Science 8/10');
    expect(body).toContain('"Great labels." Ziad Teacher');
    expect(body).toContain('Seed journal · Science 9/10');

    // The next bucket's job finds nothing new: what was emailed is not emailed again.
    await classroom.enqueueGraded({ school: 'ALHAADIACADEMY', studentIds: [amalId], now: new Date(lastBucketStart.getTime() + 16 * 60 * 1000) });
    const next = (await jobs('graded')).find((r) => r.status === 'pending');
    expect((await processJob(next)).row).toMatchObject({ status: 'skipped', last_error: 'nothing published' });
  });

  it('processing renders and sends through the school sender with no teacher Reply-To', async () => {
    await pool.query(`UPDATE schools SET email_reply_to = '{office@example.org}' WHERE school_code = 'ALHAADIACADEMY'`);
    await pool.query(`UPDATE users SET avatar = '{"style":"kufi","skin":1,"bg":3}' WHERE user_id = $1`, [TEACHER_ID]);
    const item = await assignment({ dueAt: '2030-10-22T03:59:00Z' });
    await pool.query(`UPDATE classroom_email_jobs SET send_after = NOW() - interval '1 minute'`);

    expect(await classroom.drainClassroomJobs()).toBe(2);
    const rows = await jobs('new_work');
    expect(rows.every((r) => r.status === 'sent' && r.sent_at && r.attempts === 1)).toBe(true);

    const toAmal = sent().find((m) => m.to[0] === 'amal.haddad@example.com');
    expect(toAmal.from).toBe('"Al Haadi Academy" <alhaadiacademy@test.com>');
    expect(toAmal.replyTo).toEqual(['office@example.org']); // the office, never the teacher
    expect(toAmal.subject).toBe('New assignment in Science: Plant cell diagram');
    const body = text(toAmal.html);
    expect(body).toContain('Hi Amal,');
    expect(body).toContain('Ziad Teacher posted a new assignment in Science.');
    expect(body).toContain('Due Mon, Oct 21 at 11:59 PM');
    expect(body).toContain('Label six parts.');
    expect(body).toContain('Open in SchoolMule');
    expect(toAmal.html).toContain(`http://localhost:3000/student/items/${item.itemId}`);
    expect(toAmal.html).toContain('https://schoolmule.ca/email/avatars/kufi-1-3.png');
    expect(toAmal.html).toContain('Al Haadi Academy');
    expect(toAmal.html).not.toContain('ziad.teacher@example.com');

    // Nothing is due any more.
    expect(await classroom.drainClassroomJobs()).toBe(0);
  });

  it('prefs GET returns defaults; PUT validates and persists', async () => {
    const url = '/api/parent-portal/notification-prefs';
    const get = async (who = asMona, status = 200) => expectStatus(authenticatedRequest('get', url, who), status);
    const put = async (body, status = 200) => expectStatus(authenticatedRequest('put', url, asMona).send(body), status);

    expect((await get()).data).toEqual({
      weeklySummary: true, summaryFrequency: 'weekly', summaryDow: 5, missingAlerts: true, schoolDefaultDow: 5,
    });
    await settings({ summary_dow: 4 });
    expect((await get()).data).toMatchObject({ summaryDow: 4, schoolDefaultDow: 4 });

    for (const bad of [
      { weeklySummary: 'yes' },
      { summaryFrequency: 'hourly' },
      { summaryDow: 7 },
      { summaryDow: 2.5 },
      { missingAlerts: null },
      {},
      [],
    ]) await put(bad, 400);
    expect((await pool.query(`SELECT * FROM notification_prefs`)).rows).toEqual([]);

    const saved = await put({ weeklySummary: false, summaryFrequency: 'daily', summaryDow: 1, missingAlerts: false });
    expect(saved.data).toEqual({ weeklySummary: false, summaryFrequency: 'daily', summaryDow: 1, missingAlerts: false, schoolDefaultDow: 4 });
    const { rows: [row] } = await pool.query(`SELECT * FROM notification_prefs WHERE user_id = $1`, [MONA_ID]);
    expect(row).toMatchObject({ weekly_summary: false, summary_frequency: 'daily', summary_dow: 1, missing_alerts: false });
    expect((await get()).data).toEqual(saved.data);

    // A partial change keeps the rest; null (or the school's own day) follows the school.
    expect((await put({ weeklySummary: true })).data).toMatchObject({ weeklySummary: true, summaryFrequency: 'daily', summaryDow: 1 });
    expect((await put({ summaryDow: null })).data).toMatchObject({ summaryDow: 4 });
    expect((await pool.query(`SELECT summary_dow FROM notification_prefs WHERE user_id = $1`, [MONA_ID])).rows[0].summary_dow).toBeNull();
    await put({ summaryDow: 4 });
    expect((await pool.query(`SELECT summary_dow FROM notification_prefs WHERE user_id = $1`, [MONA_ID])).rows[0].summary_dow).toBeNull();

    // Parents only.
    await get(asTeacher, 403);
    await get(asAmal, 403);
  });
});
