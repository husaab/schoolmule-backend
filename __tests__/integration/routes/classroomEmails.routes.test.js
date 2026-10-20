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
// A missing alert's key: the child, the item and the due instant it was missed at (Fable M2).
const missingKey = (studentId, itemId, dueAt) =>
  `missing:${studentId}:${itemId}:${new Date(dueAt).toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;

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
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled, parent_summary) VALUES ('ALHAADIACADEMY', TRUE, TRUE)`);

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

  it('Fable M1: widening a posted item emails only the students added (same gates); nobody is emailed twice', async () => {
    const forItem = (itemId) => jobs('new_work', `AND digest_key = 'item:${itemId}'`);
    const some = await assignment({ title: 'Catch-up sheet', audience: 'some', studentIds: [bilalId] });
    let rows = await forItem(some.itemId);
    expect(rows.map((r) => r.recipient_email)).toEqual(['bilal.karim@example.com']);
    expect((await processJob(rows[0])).outcome).toBe('sent');

    // Widened to the class: Amal is added and emailed; Bilal, already emailed, is not queued again.
    // (Dalia's login is invite-pending: never emailed.)
    await editItem(some.itemId, { audience: 'all' });
    rows = await forItem(some.itemId);
    expect(rows.map((r) => [r.recipient_email, r.status])).toEqual([
      ['amal.haddad@example.com', 'pending'], ['bilal.karim@example.com', 'sent'],
    ]);
    expect((await processJob(rows[0])).outcome).toBe('sent');
    expect(sent().map((m) => m.to[0])).toEqual(['bilal.karim@example.com', 'amal.haddad@example.com']);

    // Narrowed and widened again: still one email each.
    await editItem(some.itemId, { audience: 'some', studentIds: [bilalId] });
    await editItem(some.itemId, { audience: 'all' });
    expect((await forItem(some.itemId)).map((r) => r.status)).toEqual(['sent', 'sent']);

    // A graded item (a gradebook column) widened from one chosen student to two.
    const graded = await assignment({
      title: 'Seed journal', audience: 'some', studentIds: [amalId], gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 },
    });
    expect((await forItem(graded.itemId)).map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com']);
    await editItem(graded.itemId, { audience: 'some', studentIds: [amalId, bilalId] });
    expect((await forItem(graded.itemId)).map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com', 'bilal.karim@example.com']);

    // A draft, or an item with "Email students" off, still emails nobody when widened.
    const draft = await assignment({ title: 'Leaf rubbing', status: 'draft', audience: 'some', studentIds: [bilalId] });
    await editItem(draft.itemId, { audience: 'all' });
    expect(await forItem(draft.itemId)).toEqual([]);
    const quiet = await assignment({ title: 'Bark rubbing', emailStudents: false, audience: 'some', studentIds: [bilalId] });
    await editItem(quiet.itemId, { audience: 'all' });
    expect(await forItem(quiet.itemId)).toEqual([]);
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
    const cells = await assignment({ title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString() });
    // Sami: a derived Missing too, due two hours ago.
    const spellingItem = (await createItem(engId, {
      kind: 'assignment', title: 'Spelling list 4', submissionMode: 'done', dueAt: hoursFrom(FRIDAY, -2).toISOString(),
    })).itemId;
    // ...and a teacher-confirmed Missing published two hours ago: the publish
    // digest announces that one (final ruling I1), so it is never alerted.
    const confirmed = (await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, date, is_published, published_at)
       VALUES ($1, 'Spelling list 3', 10, DATE '2030-10-17', TRUE, $2) RETURNING assessment_id`, [engId, hoursFrom(FRIDAY, -2)],
    )).rows[0].assessment_id;
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, NULL, 'missing')`, [samiId, confirmed]);
    // Bilal turned it in, so Rania's family has nothing new.
    await pool.query(
      `INSERT INTO classwork_submissions (item_id, student_id, turned_in_at)
       SELECT item_id, $1, NOW() FROM classwork_items WHERE class_id = $2 AND kind = 'assignment'`, [bilalId, sciId],
    );

    await classroom.runSchedule(hoursFrom(FRIDAY, -1)); // 15:30
    expect(await jobs('missing_alert')).toEqual([]);
    await classroom.runSchedule(FRIDAY);
    const rows = await jobs('missing_alert');
    // One job per child × item (the item's alert happens once for this address), all Mona's.
    expect(rows.map((r) => r.digest_key).sort()).toEqual([
      missingKey(amalId, cells.itemId, hoursFrom(FRIDAY, -3)), missingKey(samiId, spellingItem, hoursFrom(FRIDAY, -2)),
    ].sort());
    expect(rows.every((r) => r.recipient_email === 'mona.haddad@example.com' && r.recipient_id === MONA_ID)).toBe(true);
    // The window is fixed: yesterday 4 pm to today 4 pm, Toronto time.
    expect(new Date(rows[0].payload.since).toISOString()).toBe('2030-10-17T20:00:00.000Z');
    expect(new Date(rows[0].payload.until).toISOString()).toBe('2030-10-18T20:00:00.000Z');

    // Sending one sends the family's single email and finishes both.
    expect((await processJob(rows[0], FRIDAY)).outcome).toBe('sent');
    expect(sent()).toHaveLength(1);
    const [email] = sent();
    expect(email.to).toEqual(['mona.haddad@example.com']);
    expect(email.subject).toBe('Missing work: Amal (1), Sami (1)');
    const body = text(email.html);
    expect(body).toContain('Amal · Grade 5');
    expect(body).toContain('Plant cell diagram · Science · was due Fri, Oct 18');
    expect(body).toContain('Sami · Grade 3');
    expect(body).toContain('Spelling list 4 · English');
    expect(body).not.toContain('Spelling list 3');
    expect(email.html).toContain('http://localhost:3000/parent/classes');
    expect((await jobs('missing_alert')).map((r) => r.status)).toEqual(['sent', 'sent']);

    // Alerts off: no job at all, and pending ones are skipped at send time, the family's together.
    await pool.query(`DELETE FROM classroom_email_jobs`);
    await pool.query(`INSERT INTO notification_prefs (user_id, missing_alerts) VALUES ($1, FALSE)`, [MONA_ID]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    expect(await jobs('missing_alert')).toEqual([]);
    await pool.query(`UPDATE notification_prefs SET missing_alerts = TRUE WHERE user_id = $1`, [MONA_ID]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    const pending = await jobs('missing_alert');
    expect(pending).toHaveLength(2);
    await pool.query(`UPDATE notification_prefs SET missing_alerts = FALSE WHERE user_id = $1`, [MONA_ID]);
    expect((await processJob(pending[0], FRIDAY)).row).toMatchObject({ status: 'skipped', last_error: 'prefs off' });
    expect((await jobs('missing_alert')).map((r) => [r.status, r.last_error])).toEqual([['skipped', 'prefs off'], ['skipped', 'prefs off']]);

    // A family whose only news is a derived Missing (judged at the scheduler's clock) is alerted too.
    await pool.query(`DELETE FROM classwork_submissions WHERE student_id = $1`, [bilalId]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    expect((await jobs('missing_alert')).map((r) => r.recipient_email)).toContain('rania.karim@example.com');
  });

  it('one email per Missing: Mark missing is announced by the publish digest, never again by the 4 pm alert (final I1)', async () => {
    const rowsFor = (email) => jobs('missing_alert', `AND recipient_email = '${email}'`);
    // A plain gradebook column the assignment fills, due at 13:30 on Friday.
    const columnId = (await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, weight_points) VALUES ($1, 'Plant cell diagram', 10, 20) RETURNING assessment_id`, [sciId],
    )).rows[0].assessment_id;
    const item = await assignment({
      title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString(), gradebook: { mode: 'existing', assessmentId: columnId },
    });
    // Sami's English work goes missing by its due date alone (derived): still alerted.
    const spellingColumn = (await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, weight_points) VALUES ($1, 'Spelling list 4', 10, 20) RETURNING assessment_id`, [engId],
    )).rows[0].assessment_id;
    const spelling = await createItem(engId, {
      kind: 'assignment', title: 'Spelling list 4', submissionMode: 'done', dueAt: hoursFrom(FRIDAY, -2).toISOString(),
      gradebook: { mode: 'existing', assessmentId: spellingColumn },
    });

    // The teacher marks Bilal and Amal missing: published at once, with today's parent digest.
    const res = await post(`/api/classroom/items/${item.itemId}/mark-missing`, { studentIds: [bilalId, amalId] });
    expect(res.data.emailSummary).toMatchObject({ attempted: 2, sent: 2 });
    const digests = (await pool.query(
      `SELECT student_id, status, email_addresses, assessment_ids FROM assessment_publication_emails ORDER BY student_id`,
    )).rows;
    expect(digests.map((d) => [d.student_id, d.status]).sort()).toEqual([[amalId, 'sent'], [bilalId, 'sent']].sort());
    expect(digests.every((d) => d.assessment_ids.includes(columnId))).toBe(true);
    // Stamp the publish inside Friday's window (yesterday 4 pm to today 4 pm).
    const at = hoursFrom(FRIDAY, -2);
    await pool.query(`UPDATE classwork_submissions SET published_at = $2 WHERE item_id = $1 AND published_at IS NOT NULL`, [item.itemId, at]);
    await pool.query(`UPDATE assessments SET published_at = $2 WHERE assessment_id = $1`, [columnId, at]);
    await pool.query(`UPDATE assessment_publication_emails SET sent_at = $1`, [at]);

    // Amal's Missing is then taken back on the published column (a live edit):
    // now it is Missing by its due date only, but Mona already read about it.
    await pool.query(`DELETE FROM student_assessments WHERE student_id = $1 AND assessment_id = $2`, [amalId, columnId]);

    await classroom.runSchedule(FRIDAY);
    // Rania (Bilal): the digest said "Missing"; no alert. Mona: only Sami's derived Missing.
    expect(await rowsFor('rania.karim@example.com')).toEqual([]);
    const mona = await rowsFor('mona.haddad@example.com');
    expect(mona.map((r) => r.digest_key)).toEqual([missingKey(samiId, spelling.itemId, hoursFrom(FRIDAY, -2))]);

    // Confirmed between the sweep and the send: the digest announces it, the alert stays quiet.
    getResend().emails.send.mockClear();
    expect((await post(`/api/classroom/items/${spelling.itemId}/mark-missing`, { studentIds: [samiId] })).data.emailSummary)
      .toMatchObject({ attempted: 1, sent: 1 });
    expect(sent().map((m) => m.to)).toEqual([['mona.haddad@example.com']]);
    expect((await processJob(mona[0], FRIDAY)).row).toMatchObject({ status: 'skipped', last_error: 'nothing new' });
    expect(sent()).toHaveLength(1);
  });

  it('re-review N1: a Missing that goes live on an already-published column (no digest) is announced once by the 4 pm alert', async () => {
    const rowsFor = (email) => jobs('missing_alert', `AND recipient_email = '${email}'`);
    const at = hoursFrom(FRIDAY, -6); // Friday 10:30, inside Friday's window
    // Due Thursday 13:30: before Friday's window, so nothing is Missing by its due date alone today.
    const due = hoursFrom(FRIDAY, -27);
    const item = await assignment({ title: 'Plant cell diagram', dueAt: due.toISOString(), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    const columnId = item.gradebook.assessmentId;

    // Friday morning: Bilal's grade is published (the column is published now, with Rania's digest)...
    await turnIn(item.itemId, asBilal);
    await patchReq(`/api/classroom/items/${item.itemId}/submissions/${bilalId}`, { draftScore: 8 });
    expect((await post(`/api/classroom/items/${item.itemId}/publish`, { studentIds: [bilalId] })).data.assessmentPublished).toBe(true);
    // ...then the teacher marks Amal "M" in the grid: live at once (D17), no digest.
    getResend().emails.send.mockClear();
    await post(`/api/studentAssessments/classes/${sciId}/scores`, { scores: [{ studentId: amalId, assessmentId: columnId, score: null, status: 'missing' }] });
    expect(sent()).toEqual([]);
    await pool.query(`UPDATE classwork_submissions SET published_at = $2 WHERE item_id = $1 AND published_at IS NOT NULL`, [item.itemId, at]);
    await pool.query(`UPDATE assessment_publication_emails SET sent_at = $1`, [at]);

    // A second category published in Grades with a Missing in it: that digest (listing the
    // category, not the column) announced Amal's Missing, so no alert for it.
    const labsId = (await pool.query(
      `INSERT INTO assessments (class_id, name, is_parent, weight_points) VALUES ($1, 'Labs', TRUE, 30) RETURNING assessment_id`, [sciId],
    )).rows[0].assessment_id;
    const lab = await assignment({ title: 'Seed journal', dueAt: due.toISOString(), gradebook: { mode: 'category', categoryId: labsId, maxScore: 10 } });
    await expectStatus(authenticatedRequest('patch', `/api/studentAssessments/classes/${sciId}/status`, asTeacher)
      .send({ studentId: amalId, assessmentId: lab.gradebook.assessmentId, status: 'missing' }), 200);
    await expectStatus(authenticatedRequest('post', `/api/assessment-publications/classes/${sciId}/publish`, asTeacher)
      .send({ assessmentIds: [labsId] }), 201);
    const labDigest = (await pool.query(
      `SELECT assessment_ids FROM assessment_publication_emails WHERE student_id = $1 AND status = 'sent' AND $2 = ANY(assessment_ids)`, [amalId, labsId],
    )).rows;
    expect(labDigest).toHaveLength(1);
    expect(labDigest[0].assessment_ids).not.toContain(lab.gradebook.assessmentId);
    await pool.query(`UPDATE classwork_submissions SET published_at = $2 WHERE item_id = $1 AND published_at IS NOT NULL`, [lab.itemId, at]);
    await pool.query(`UPDATE assessment_publication_emails SET sent_at = $1 WHERE $2 = ANY(assessment_ids)`, [at, labsId]);

    await classroom.runSchedule(FRIDAY);
    // Mona: exactly one alert, for the live Missing; Rania (Bilal was graded): none.
    const mona = await rowsFor('mona.haddad@example.com');
    expect(mona.map((r) => r.digest_key)).toEqual([missingKey(amalId, item.itemId, due)]);
    expect(await rowsFor('rania.karim@example.com')).toEqual([]);
    getResend().emails.send.mockClear();
    expect((await processJob(mona[0], FRIDAY)).outcome).toBe('sent');
    expect(sent()).toHaveLength(1);
    const [email] = sent();
    expect(email.to).toEqual(['mona.haddad@example.com']);
    expect(email.html).toContain('Plant cell diagram');
    expect(email.html).not.toContain('Seed journal');

    // Never again: a later sweep, a restart, or the next day's window.
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 1));
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 24));
    expect(await rowsFor('mona.haddad@example.com')).toHaveLength(1);
  });

  it('post-Fable I-new: a Grades publish of the category never silences a derived Missing its digest did not mention', async () => {
    const rowsFor = (email) => jobs('missing_alert', `AND recipient_email = '${email}'`);
    const due = hoursFrom(FRIDAY, -3); // Friday 13:30
    // Homework: A (Amal graded 8) and B (Bilal turned in and was graded; Amal turned in nothing).
    const a = await assignment({ title: 'Leaf rubbing', dueAt: inDays(5), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    const b = await assignment({ title: 'Plant cell diagram', dueAt: due.toISOString(), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    await patchReq(`/api/classroom/items/${a.itemId}/submissions/${amalId}`, { draftScore: 8 });
    await turnIn(b.itemId, asBilal);
    await patchReq(`/api/classroom/items/${b.itemId}/submissions/${bilalId}`, { draftScore: 7 });

    // The teacher publishes Homework in Grades: Mona's digest lists the category line (A only, for Amal).
    await expectStatus(authenticatedRequest('post', `/api/assessment-publications/classes/${sciId}/publish`, asTeacher)
      .send({ assessmentIds: [homeworkId] }), 201);
    const amalDigest = (await pool.query(
      `SELECT e.assessment_ids, b.assessment_ids AS batch_ids FROM assessment_publication_emails e
       JOIN assessment_publication_batches b ON b.batch_id = e.batch_id WHERE e.student_id = $1 AND e.status = 'sent'`, [amalId],
    )).rows;
    expect(amalDigest).toHaveLength(1);
    expect(amalDigest[0].assessment_ids).toEqual([homeworkId]);
    expect(amalDigest[0].batch_ids).toEqual(expect.arrayContaining([b.gradebook.assessmentId]));
    // Sent after B was due (Friday 14:30).
    await pool.query(`UPDATE assessment_publication_emails SET sent_at = $1`, [hoursFrom(FRIDAY, -2)]);

    await classroom.runSchedule(FRIDAY);
    // B is Missing by its due date and no digest said so: Mona is alerted once.
    expect((await rowsFor('mona.haddad@example.com')).map((r) => r.digest_key)).toEqual([missingKey(amalId, b.itemId, due)]);
    expect(await rowsFor('rania.karim@example.com')).toEqual([]);
    const [job] = await rowsFor('mona.haddad@example.com');
    getResend().emails.send.mockClear();
    expect((await processJob(job, FRIDAY)).outcome).toBe('sent');
    expect(sent()[0].html).toContain('Plant cell diagram');
  });

  it("a family alert never takes a sibling another worker has claimed (no item emailed twice)", async () => {
    const cells = await assignment({ title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString() });
    const spelling = await createItem(engId, {
      kind: 'assignment', title: 'Spelling list 4', submissionMode: 'done', dueAt: hoursFrom(FRIDAY, -2).toISOString(),
    });
    await classroom.runSchedule(FRIDAY);
    const rows = await jobs('missing_alert', `AND recipient_email = 'mona.haddad@example.com'`);
    expect(rows).toHaveLength(2);
    const amalJob = rows.find((r) => r.payload.itemId === cells.itemId);
    const samiJob = rows.find((r) => r.payload.itemId === spelling.itemId);

    // Two workers overlap at the drain: A has claimed Amal's alert while B
    // claimed Sami's (claimDueJob: attempts + 1, pushed 5 minutes out).
    for (const j of [amalJob, samiJob]) {
      await pool.query(
        `UPDATE classroom_email_jobs SET attempts = attempts + 1, send_after = NOW() + interval '5 minutes' WHERE job_id = $1`, [j.job_id],
      );
    }
    // A's email leaves B's job alone: it lists only Amal's item, and B's row is untouched.
    expect((await processJob(await reload(amalJob.job_id), FRIDAY)).outcome).toBe('sent');
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe('Missing work: Amal (1)');
    expect(await reload(samiJob.job_id)).toMatchObject({ status: 'pending', attempts: 1 });
    // B then sends Sami's: each item reached the family exactly once.
    expect((await processJob(await reload(samiJob.job_id), FRIDAY)).outcome).toBe('sent');
    expect(sent()).toHaveLength(2);
    expect(sent()[1].subject).toBe('Missing work: Sami (1)');
    expect(sent()[1].html).not.toContain('Plant cell diagram');

    // A sibling nobody holds (never claimed, or a retry whose wait is over) still rides along.
    await pool.query(`DELETE FROM classroom_email_jobs`);
    getResend().emails.send.mockClear();
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    const again = await jobs('missing_alert', `AND recipient_email = 'mona.haddad@example.com'`);
    const retried = again.find((r) => r.payload.itemId === spelling.itemId);
    await pool.query(`UPDATE classroom_email_jobs SET attempts = 1, send_after = NOW() - interval '1 minute' WHERE job_id = $1`, [retried.job_id]);
    expect((await processJob(again.find((r) => r.payload.itemId === cells.itemId), FRIDAY)).outcome).toBe('sent');
    expect(sent().map((m) => m.subject)).toEqual(['Missing work: Amal (1), Sami (1)']);
    expect((await jobs('missing_alert', `AND recipient_email = 'mona.haddad@example.com'`)).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('missing alerts never repeat an item: a restart re-reads the same 4 pm window and an item is alerted once per address', async () => {
    const monaAlerts = () => jobs('missing_alert', `AND recipient_email = 'mona.haddad@example.com'`);
    // Due Friday 13:30 and graded in the gradebook (so it can be confirmed Missing later).
    const first = await assignment({
      title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString(), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 },
    });
    await classroom.runSchedule(FRIDAY); // 16:30
    let rows = await monaAlerts();
    expect(rows.map((r) => r.digest_key)).toEqual([missingKey(amalId, first.itemId, hoursFrom(FRIDAY, -3))]);
    expect((await processJob(rows[0], FRIDAY)).outcome).toBe('sent');

    // Work that goes missing at 17:00, after today's window closed at 16:00; the worker restarts at 18:00.
    const late = await assignment({ title: 'Seed journal', dueAt: hoursFrom(FRIDAY, 0.5).toISOString() });
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 1.5));
    expect(await monaAlerts()).toHaveLength(1);

    // Saturday morning the teacher confirms the first item Missing (published): the same item, no second alert.
    const confirmedAt = hoursFrom(FRIDAY, 17.5);
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, NULL, 'missing')`,
      [amalId, first.gradebook.assessmentId]);
    await pool.query(
      `INSERT INTO classwork_submissions (item_id, student_id, draft_status, published_at) VALUES ($1, $2, 'missing', $3)`,
      [first.itemId, amalId, confirmedAt],
    );
    await pool.query(`UPDATE assessments SET is_published = TRUE, published_at = $2 WHERE assessment_id = $1`, [first.gradebook.assessmentId, confirmedAt]);

    // Saturday 16:30: the 17:00 item is news, exactly once; the first item is not alerted again.
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 24));
    rows = await monaAlerts();
    expect(rows.map((r) => [r.digest_key, r.status]).sort()).toEqual([
      [missingKey(amalId, first.itemId, hoursFrom(FRIDAY, -3)), 'sent'],
      [missingKey(amalId, late.itemId, hoursFrom(FRIDAY, 0.5)), 'pending'],
    ].sort());
    getResend().emails.send.mockClear();
    expect((await processJob(rows.find((r) => r.status === 'pending'), hoursFrom(FRIDAY, 24))).outcome).toBe('sent');
    const [email] = sent();
    expect(email.subject).toBe('Missing work: Amal (1)');
    expect(email.html).toContain('Seed journal');
    expect(email.html).not.toContain('Plant cell diagram');

    // A second run that day, or a second instance, adds nothing.
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 26));
    expect(await monaAlerts()).toHaveLength(2);
  });

  it('Fable M2: a due date moved and missed again alerts once more; each due date alerts once', async () => {
    const monaAlerts = () => jobs('missing_alert', `AND recipient_email = 'mona.haddad@example.com'`);
    const item = await assignment({ title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString() });
    await classroom.runSchedule(FRIDAY);
    let rows = await monaAlerts();
    expect(rows.map((r) => r.digest_key)).toEqual([missingKey(amalId, item.itemId, hoursFrom(FRIDAY, -3))]);
    expect((await processJob(rows[0], FRIDAY)).outcome).toBe('sent');

    // The teacher gives Amal until Saturday 13:30; she misses that too.
    const extended = hoursFrom(FRIDAY, 21);
    await editItem(item.itemId, { dueAt: extended.toISOString() });
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 24)); // Saturday 16:30
    rows = await monaAlerts();
    expect(rows.map((r) => [r.digest_key, r.status]).sort()).toEqual([
      [missingKey(amalId, item.itemId, hoursFrom(FRIDAY, -3)), 'sent'],
      [missingKey(amalId, item.itemId, extended), 'pending'],
    ].sort());
    getResend().emails.send.mockClear();
    expect((await processJob(rows.find((r) => r.status === 'pending'), hoursFrom(FRIDAY, 24))).outcome).toBe('sent');
    expect(sent()).toHaveLength(1);
    expect(sent()[0].html).toContain('Plant cell diagram');

    // A second run, or a second instance, adds nothing for either due date.
    classroom.resetScheduleState();
    await classroom.runSchedule(hoursFrom(FRIDAY, 26));
    expect(await monaAlerts()).toHaveLength(2);
  });

  it("a daily-summary parent gets the day's Missing in the daily summary, not a separate alert", async () => {
    await assignment({ title: 'Plant cell diagram', dueAt: hoursFrom(FRIDAY, -3).toISOString() });
    await pool.query(`INSERT INTO notification_prefs (user_id, summary_frequency) VALUES ($1, 'daily')`, [MONA_ID]);
    // Rania reads no summary at all but keeps the alerts.
    await pool.query(`INSERT INTO notification_prefs (user_id, summary_frequency, weekly_summary) VALUES ($1, 'daily', FALSE)`, [RANIA_ID]);

    await classroom.runSchedule(FRIDAY);
    expect((await jobs('missing_alert')).map((r) => r.recipient_email)).toEqual(['rania.karim@example.com']);
    const summaries = await jobs('weekly_summary');
    expect(summaries.map((r) => [r.recipient_email, r.digest_key])).toEqual([['mona.haddad@example.com', 'daily:2030-10-18']]);

    expect((await processJob(summaries[0], FRIDAY)).outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['mona.haddad@example.com']);
    expect(email.subject).toBe('Daily Summary: Amal has 1 missing');
    expect(text(email.html)).toContain('Plant cell diagram · Science · was due Fri, Oct 18');

    // An alert queued before Mona switched to the daily summary is skipped when it would go out.
    await pool.query(`DELETE FROM classroom_email_jobs`);
    await pool.query(`UPDATE notification_prefs SET summary_frequency = 'weekly' WHERE user_id = $1`, [MONA_ID]);
    classroom.resetScheduleState();
    await classroom.runSchedule(FRIDAY);
    const [alert] = await jobs('missing_alert', `AND recipient_email = 'mona.haddad@example.com'`);
    await pool.query(`UPDATE notification_prefs SET summary_frequency = 'daily' WHERE user_id = $1`, [MONA_ID]);
    expect((await processJob(alert, FRIDAY)).row).toMatchObject({ status: 'skipped', last_error: 'in daily summary' });
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
    expect(email.subject).toBe('Weekly Summary: Amal has 1 missing, 1 new grade');
    const body = text(email.html);
    expect(body).toContain('Weekly Summary: Oct 14–18');
    expect(body).toContain("Here's what happened in Amal's classes this week.");
    expect(body).toContain('Amal · Grade 5');
    expect(body).toContain('Plant cell diagram · Science · was due Thu, Oct 17');
    expect(body).toContain('Science 1 new grade Seed journal "Great labels." Ziad Teacher 8/10');
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

  // The parents' summary has its own switch (owner, 2026-10-19): it does not
  // need the Student Portal on, and it reaches parents without an account too.
  const gradedThisWeek = async (studentId, title, score) => {
    const it = await assignment({ title, dueAt: hoursFrom(FRIDAY, -50).toISOString(), gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    await publishGrade({ itemId: it.itemId, assessmentId: it.gradebook.assessmentId, studentId, score, at: hoursFrom(FRIDAY, -5) });
  };

  it("the parents' weekly summary has its own switch: it goes out with the Student Portal off, and not while its switch is off", async () => {
    await gradedThisWeek(amalId, 'Seed journal', 8);
    await settings({ enabled: false });
    await classroom.runSchedule(FRIDAY);
    const rows = await jobs('weekly_summary');
    expect(rows.map((r) => r.recipient_email)).toEqual(['mona.haddad@example.com', 'rania.karim@example.com']);
    expect((await processJob(rows.find((r) => r.recipient_email === 'mona.haddad@example.com'), FRIDAY)).outcome).toBe('sent');
    expect(text(sent()[0].html)).toContain('Seed journal 8/10');

    await pool.query(`DELETE FROM classroom_email_jobs`);
    classroom.resetScheduleState();
    await settings({ enabled: true, parent_summary: false });
    await classroom.runSchedule(FRIDAY);
    expect(await jobs('weekly_summary')).toEqual([]);
  });

  it('parents without an account get the summary at the address on file, one per address, with a set-up link and no settings links', async () => {
    // Lina has no account: her address is on the guardian records of Dalia and Yusuf.
    const yusufId = await makeStudent('Yusuf Nassar', '5', sciId, null);
    await guardian(null, daliaId, 'Lina Nassar', 'Lina.Nassar@example.com');
    await guardian(null, yusufId, 'Lina Nassar', 'lina.nassar@example.com');
    // Omar has no guardian record: his mother's and father's addresses on the student record are used.
    const omarId = await makeStudent('Omar Saleh', '5', sciId, null);
    await pool.query(`UPDATE students SET mother_email = 'noor.saleh@example.com', father_email = 'karim.saleh@example.com' WHERE student_id = $1`, [omarId]);
    // An invited parent who never set a password counts as no account.
    const INVITED_ID = '550e8400-e29b-41d4-a716-446655440007';
    await user(INVITED_ID, 'reem.ali@example.com', 'Reem', 'Ali', 'PARENT', '!');
    const zaidId = await makeStudent('Zaid Ali', '5', sciId, null);
    await guardian(INVITED_ID, zaidId, 'Reem Ali', 'reem.ali@example.com');
    for (const [id, title] of [[daliaId, 'Leaf rubbing'], [yusufId, 'Bark rubbing'], [omarId, 'Seed chart'], [zaidId, 'Root sketch']]) {
      await gradedThisWeek(id, title, 7);
    }
    await pool.query(
      `INSERT INTO announcements (school, school_year_id, scope, class_id, title, body, author_id, author_role, published_at, ack_requested)
       VALUES ('ALHAADIACADEMY', $1, 'class', $2, 'Science Centre trip', 'Please sign the permission form by Monday.', $3, 'TEACHER', $4, TRUE)`,
      [yearId, sciId, TEACHER_ID, hoursFrom(FRIDAY, -24)],
    );

    await classroom.runSchedule(FRIDAY);
    const rows = await jobs('weekly_summary');
    expect(rows.map((r) => [r.recipient_email, r.recipient_id])).toEqual([
      ['karim.saleh@example.com', null],
      ['lina.nassar@example.com', null],
      ['mona.haddad@example.com', MONA_ID],
      ['noor.saleh@example.com', null],
      ['rania.karim@example.com', RANIA_ID],
      ['reem.ali@example.com', null],
    ]);

    const lina = rows.find((r) => r.recipient_email === 'lina.nassar@example.com');
    expect((await processJob(lina, FRIDAY)).outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['lina.nassar@example.com']);
    const body = text(email.html);
    expect(body).toContain('Hi there,');
    expect(body).toContain('Dalia · Grade 5');
    expect(body).toContain('Yusuf · Grade 5');
    expect(body).toContain('Leaf rubbing 7/10');
    expect(body).toContain('Bark rubbing 7/10');
    expect(body).not.toContain('Amal');
    expect(body).toContain('Science Centre trip');
    // No account: nothing to sign in to for "Got it" or settings, and no way to switch it off; a link to set one up.
    expect(email.html).not.toContain('ack=1');
    expect(email.html).not.toContain('/parent/notifications');
    expect(email.html).toContain('http://localhost:3000/signup/alhaadiacademy/parent');
    expect(body).toContain('You get this summary on Fridays.');

    expect((await processJob(rows.find((r) => r.recipient_email === 'noor.saleh@example.com'), FRIDAY)).outcome).toBe('sent');
    expect(text(sent()[1].html)).toContain('Seed chart 7/10');
    expect((await processJob(rows.find((r) => r.recipient_email === 'reem.ali@example.com'), FRIDAY)).outcome).toBe('sent');
    expect(text(sent()[2].html)).toContain('Root sketch 7/10');
  });

  it("previewSummary renders an address's or an account's summary as it would go out now, sending and recording nothing", async () => {
    await gradedThisWeek(daliaId, 'Leaf rubbing', 7);
    await guardian(null, daliaId, 'Lina Nassar', 'lina.nassar@example.com');
    const lina = await classroom.previewSummary({ school: 'ALHAADIACADEMY', email: 'lina.nassar@example.com', now: FRIDAY });
    expect(lina.subject).toContain('Dalia');
    expect(text(lina.html)).toContain('Leaf rubbing 7/10');
    expect(lina.html).toContain('/signup/alhaadiacademy/parent');
    const mona = await classroom.previewSummary({ school: 'ALHAADIACADEMY', email: 'mona.haddad@example.com', userId: MONA_ID, now: FRIDAY });
    expect(mona.subject).toBe('Weekly Summary: Amal has 1 missing');
    expect(mona.html).toContain('/parent/notifications');
    // Huda has no child linked: nothing to send.
    expect(await classroom.previewSummary({ school: 'ALHAADIACADEMY', email: 'huda.saleh@example.com', userId: HUDA_ID, now: FRIDAY }))
      .toEqual({ skip: 'nothing to report' });
    expect(sent()).toEqual([]);
    expect(await jobs('weekly_summary')).toEqual([]);
  });

  it('two publishes inside one 15-minute bucket produce one graded job listing both grades', async () => {
    const graded = (title) => assignment({ title, gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    const first = await graded('Plant cell diagram');
    const second = await graded('Seed journal');
    const third = await graded('Leaf rubbing');
    for (const it of [first, second, third]) await turnIn(it.itemId, asAmal);
    await turnIn(first.itemId, asBilal);
    await patchReq(`/api/classroom/items/${first.itemId}/submissions/${amalId}`, { draftScore: 8, feedback: 'Great labels.' });
    await patchReq(`/api/classroom/items/${second.itemId}/submissions/${amalId}`, { draftScore: 9 });
    await patchReq(`/api/classroom/items/${third.itemId}/submissions/${amalId}`, { draftScore: 7, feedback: 'Draft note.' }); // stays a draft
    await patchReq(`/api/classroom/items/${first.itemId}/submissions/${bilalId}`, { draftScore: 6, feedback: 'Check the nucleus.' });

    // Keep both publishes inside one bucket: wait out a boundary that is less than 5 s away.
    const BUCKET_MS = 15 * 60 * 1000;
    const toBoundary = BUCKET_MS - (Date.now() % BUCKET_MS);
    if (toBoundary < 5000) await new Promise((resolve) => setTimeout(resolve, toBoundary + 100));
    const bucket = gradedBucket(new Date());
    await post(`/api/classroom/items/${first.itemId}/publish`, { studentIds: [amalId] });
    await post(`/api/classroom/items/${second.itemId}/publish`, { studentIds: [amalId] });
    expect(gradedBucket(new Date()).key).toBe(bucket.key);

    let rows = await jobs('graded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ digest_key: bucket.key, recipient_id: AMAL_USER_ID, recipient_email: 'amal.haddad@example.com' });
    expect(new Date(rows[0].send_after).toISOString()).toBe(bucket.end.toISOString());
    // Enqueueing again inside the bucket changes nothing.
    await classroom.enqueueGraded({ school: 'ALHAADIACADEMY', studentIds: [amalId], now: new Date(bucket.start.getTime() + 60 * 1000) });
    rows = await jobs('graded');
    expect(rows).toHaveLength(1);

    // A classmate's grade published meanwhile is their own email, never Amal's.
    await post(`/api/classroom/items/${first.itemId}/publish`, { studentIds: [bilalId] });

    expect((await processJob(rows[0])).outcome).toBe('sent');
    const email = sent().find((m) => m.to[0] === 'amal.haddad@example.com');
    expect(email.subject).toBe('Graded: Plant cell diagram and 1 more');
    const body = text(email.html);
    expect(body).toContain('Plant cell diagram · Science 8/10');
    expect(body).toContain('"Great labels." Ziad Teacher');
    expect(body).toContain('Seed journal · Science 9/10');
    // D3: an unpublished draft and a classmate's grade never reach the email.
    for (const absent of ['Leaf rubbing', 'Draft note.', '7/10', 'Check the nucleus.', '6/10']) expect(body).not.toContain(absent);

    // The next bucket's job finds nothing new: what was emailed is not emailed again.
    await classroom.enqueueGraded({ school: 'ALHAADIACADEMY', studentIds: [amalId], now: new Date(bucket.start.getTime() + 16 * 60 * 1000) });
    const next = (await jobs('graded', `AND recipient_email = 'amal.haddad@example.com'`)).find((r) => r.status === 'pending');
    expect((await processJob(next)).row).toMatchObject({ status: 'skipped', last_error: 'nothing published' });
  });

  it('publishing a plain column in Grades emails each student their grade once; parents keep their digest', async () => {
    const unit = (await pool.query(
      `INSERT INTO assessments (class_id, name, max_score, weight_points, date) VALUES ($1, 'Unit 2 test', 20, 30, DATE '2026-10-01') RETURNING assessment_id`,
      [sciId],
    )).rows[0].assessment_id;
    const unitItem = (await pool.query(`SELECT item_id FROM classwork_items WHERE assessment_id = $1`, [unit])).rows[0].item_id;
    for (const [studentId, score] of [[amalId, 17], [bilalId, 15], [daliaId, 12]]) {
      await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)`, [studentId, unit, score]);
    }

    await post(`/api/assessment-publications/classes/${sciId}/publish`, { assessmentIds: [unit] }, asTeacher, 201);
    // Dalia's login is invite-pending: no student email for her.
    const rows = await jobs('graded');
    expect(rows.map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com', 'bilal.karim@example.com']);
    // The parents' publish digest went out exactly as before.
    expect(sent().some((m) => m.to.includes('mona.haddad@example.com'))).toBe(true);

    getResend().emails.send.mockClear();
    expect((await processJob(rows[0])).outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['amal.haddad@example.com']);
    expect(email.subject).toBe('Graded: Unit 2 test');
    const body = text(email.html);
    expect(body).toContain('Unit 2 test · Science 17/20');
    expect(body).not.toContain('15/20');
    expect(email.html).toContain(`http://localhost:3000/student/items/${unitItem}`);

    // A score typed later on the published column goes live without an email (D17), and the
    // next graded email does not list the column again.
    await pool.query(`UPDATE student_assessments SET score = 18 WHERE student_id = $1 AND assessment_id = $2`, [amalId, unit]);
    await classroom.enqueueGraded({ school: 'ALHAADIACADEMY', studentIds: [amalId], now: new Date(Date.now() + 16 * 60 * 1000) });
    const next = (await jobs('graded', `AND recipient_email = 'amal.haddad@example.com'`)).find((r) => r.status === 'pending');
    expect((await processJob(next)).row).toMatchObject({ status: 'skipped', last_error: 'nothing published' });
  });

  it('a Grades publish emails a student the item is not for their grade too, linked to their Grades page', async () => {
    // Only Amal takes the assignment; Bilal is graded in the same column like a plain assessment.
    const item = await assignment({
      title: 'Leaf rubbing', audience: 'some', studentIds: [amalId], gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 },
    });
    const column = item.gradebook.assessmentId;
    await patchReq(`/api/classroom/items/${item.itemId}/submissions/${amalId}`, { draftScore: 9 });
    await pool.query(`INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, 7)`, [bilalId, column]);

    await post(`/api/assessment-publications/classes/${sciId}/publish`, { assessmentIds: [column] }, asTeacher, 201);
    const rows = await jobs('graded');
    expect(rows.map((r) => r.recipient_email)).toEqual(['amal.haddad@example.com', 'bilal.karim@example.com']);

    getResend().emails.send.mockClear();
    const bilalJob = rows.find((r) => r.recipient_email === 'bilal.karim@example.com');
    expect((await processJob(bilalJob)).outcome).toBe('sent');
    const [email] = sent();
    expect(email.to).toEqual(['bilal.karim@example.com']);
    expect(email.subject).toBe('Graded: Leaf rubbing');
    expect(text(email.html)).toContain('Leaf rubbing · Science 7/10');
    expect(email.html).not.toContain('9/10'); // Amal's grade is never in Bilal's email
    // The item isn't Bilal's to open: the link is his Grades page.
    expect(email.html).toContain('http://localhost:3000/student/grades');
    expect(email.html).not.toContain(`/student/items/${item.itemId}`);

    getResend().emails.send.mockClear();
    expect((await processJob(rows.find((r) => r.recipient_email === 'amal.haddad@example.com'))).outcome).toBe('sent');
    expect(sent()[0].html).toContain(`http://localhost:3000/student/items/${item.itemId}`);
    expect(sent()[0].html).not.toContain('7/10');
  });

  it("a Grades publish of a draft on work a student can't open yet emails the grade, not the feedback, linked to Grades", async () => {
    // Still a draft item: Amal can't open it, but her grade shows on her Grades page once published.
    const item = await assignment({ title: 'Seed journal', status: 'draft', gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 } });
    await patchReq(`/api/classroom/items/${item.itemId}/submissions/${amalId}`, { draftScore: 8, feedback: 'Neat labels.' });
    await post(`/api/assessment-publications/classes/${sciId}/publish`, { assessmentIds: [item.gradebook.assessmentId] }, asTeacher, 201);
    const job = (await jobs('graded')).find((r) => r.recipient_email === 'amal.haddad@example.com');
    getResend().emails.send.mockClear();
    expect((await processJob(job)).outcome).toBe('sent');
    const [email] = sent();
    expect(text(email.html)).toContain('Seed journal · Science 8/10');
    expect(email.html).not.toContain('Neat labels.');
    expect(email.html).toContain('http://localhost:3000/student/grades');
    expect(email.html).not.toContain(`/student/items/${item.itemId}`);
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
