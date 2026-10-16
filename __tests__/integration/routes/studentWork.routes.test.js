// Student work: opening an item (the lazy submission), typed answers, files,
// turn in / unsubmit / late, the derived Missing, the To-do, the parent's
// read-only lens, and the teacher counts that use the same status rule.
// Every /api/student query is keyed on the caller's own student row: another
// student's items, files and grades never come back. Synthetic identities
// only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const { workStatus } = require('../../../services/classroom/workStatus');
const { WORK_STATE_SQL, WORK_LATE_SQL } = require('../../../queries/classworkSubmission.queries');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440004';
const OTHER_PARENT_ID = '550e8400-e29b-41d4-a716-446655440005';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440006';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const BILAL_USER_ID = '550e8400-e29b-41d4-a716-446655440011';

const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asAmal = { userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'] };
const asBilal = { userId: BILAL_USER_ID, username: 'Bilal Karim', email: 'bilal.karim@example.com', role: 'STUDENT', roles: ['STUDENT'] };
const asParent = { userId: PARENT_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asOtherParent = { userId: OTHER_PARENT_ID, username: 'Rania Karim', email: 'rania.karim@example.com', role: 'PARENT' };
const asAmalPreview = { ...asAmal, impersonator: { userId: ADMIN_ID, name: 'Office Admin' } };

const BUCKET = 'classwork-submissions';
const CLOSED = 'This assignment is closed. Ask your teacher.';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const inDays = (n) => new Date(Date.now() + n * DAY_MS).toISOString();
const torontoDay = (instant) => new Date(instant).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

describe('Integration: student work', () => {
  let pool, yearId, termId;
  let sciId, mathId, arabicId, amalId, bilalId, homeworkId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = async (subject, teacherId) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', '5', $1, 'Lead Name', $2, $3, 'Term 1', $4) RETURNING class_id`,
    [subject, teacherId, termId, yearId],
  )).rows[0].class_id;
  const makeStudent = async (name, classIds) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2) RETURNING student_id`,
      [name, yearId],
    )).rows[0].student_id;
    for (const c of classIds) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [c, id]);
    return id;
  };
  const assessment = async (classId, name, o = {}) => (await pool.query(
    `INSERT INTO assessments (class_id, name, parent_assessment_id, is_parent, weight_points, max_score, date, is_published, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 THEN NOW() END) RETURNING assessment_id`,
    [classId, name, o.parentId ?? null, o.isParent ?? false, o.weight ?? null, o.max ?? null, o.date ?? null, o.published ?? false],
  )).rows[0].assessment_id;
  const score = (studentId, assessmentId, value, status = 'graded') => pool.query(
    `INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, $3, $4)
     ON CONFLICT (student_id, assessment_id) DO UPDATE SET score = EXCLUDED.score, status = EXCLUDED.status`,
    [studentId, assessmentId, value, status],
  );
  const publish = (assessmentId) => pool.query(
    `UPDATE assessments SET is_published = TRUE, published_at = NOW() WHERE assessment_id = $1`, [assessmentId],
  );
  const itemOf = async (assessmentId) => (await pool.query(
    `SELECT item_id FROM classwork_items WHERE assessment_id = $1`, [assessmentId],
  )).rows[0].item_id;
  const submissions = async (itemId) => (await pool.query(
    `SELECT * FROM classwork_submissions WHERE item_id = $1 ORDER BY student_id`, [itemId],
  )).rows;
  const setDue = (itemId, dueAt) => pool.query(`UPDATE classwork_items SET due_at = $2 WHERE item_id = $1`, [itemId, dueAt]);

  const call = (method, url, who = asAmal) => authenticatedRequest(method, url, who);
  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const get = (url, who = asAmal, status = 200) => expectStatus(call('get', url, who), status);
  const post = (url, who = asAmal, status = 200, body = undefined) => expectStatus(call('post', url, who).send(body), status);
  const createItem = async (classId, body, who = asTeacher) => (await expectStatus(
    call('post', `/api/classroom/classes/${classId}/items`, who).send(body), 201,
  )).data;
  const assignment = (extra = {}) => createItem(sciId, {
    kind: 'assignment', title: 'Plant cell diagram', instructions: 'Label six parts.', submissionMode: 'file', dueAt: inDays(2), ...extra,
  });
  const graded = (extra = {}) => assignment({ gradebook: { mode: 'category', categoryId: homeworkId, maxScore: 10 }, ...extra });
  const upload = (itemId, files, who = asAmal) => {
    let req = call('post', `/api/student/items/${itemId}/files`, who);
    for (const f of files) req = req.attach('files', Buffer.from(f.body || 'file bytes'), { filename: f.name, contentType: f.type });
    return req;
  };

  beforeEach(async () => {
    supabase._reset();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', DATE '2026-09-01', DATE '2027-01-31', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;

    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(PARENT_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(OTHER_PARENT_ID, 'rania.karim@example.com', 'Rania', 'Karim', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await user(BILAL_USER_ID, 'bilal.karim@example.com', 'Bilal', 'Karim', 'STUDENT');
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    sciId = await makeClass('Science', TEACHER_ID);
    mathId = await makeClass('Math', OTHER_TEACHER_ID);
    arabicId = await makeClass('Arabic', OTHER_TEACHER_ID);
    amalId = await makeStudent('Amal Haddad', [sciId, mathId]);
    bilalId = await makeStudent('Bilal Karim', [sciId, arabicId]);
    for (const [u, s] of [[AMAL_USER_ID, amalId], [BILAL_USER_ID, bilalId]]) {
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [u, s, yearId]);
    }
    await pool.query(
      `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, school) VALUES
       ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'ALHAADIACADEMY'),
       ($3, $4, 'Rania Karim', 'rania.karim@example.com', 'ALHAADIACADEMY')`,
      [PARENT_ID, amalId, OTHER_PARENT_ID, bilalId],
    );

    homeworkId = await assessment(sciId, 'Homework', { isParent: true, weight: 40 });
  });

  it('opening an assignment creates its submission once (opened_at set, second open keeps it)', async () => {
    const item = await graded({ dueAt: inDays(2) });

    const { data } = await get(`/api/student/items/${item.itemId}`);
    expect(data).toMatchObject({
      itemId: item.itemId, classId: sciId, subject: 'Science', kind: 'assignment', title: 'Plant cell diagram',
      instructions: 'Label six parts.', postedAt: item.postedAt, dueAt: item.dueAt, date: torontoDay(item.dueAt), points: 10,
      attachments: [], grade: null, thread: null,
      teacher: { userId: TEACHER_ID, name: 'Ziad Teacher', avatar: null, photoUrl: null },
      submission: {
        status: 'assigned', isLate: false, turnedInAt: null, textAnswer: null, textSavedAt: null, files: [],
        canEdit: true, canTurnIn: false, canUnsubmit: false, closed: false,
      },
    });
    expect(data.identity).toMatchObject({ family: 'science', iconUrl: '/class-icons/science.svg' });

    const [first] = await submissions(item.itemId);
    expect(first).toMatchObject({ student_id: amalId, turned_in_at: null });
    expect(first.opened_at).not.toBeNull();

    await get(`/api/student/items/${item.itemId}`);
    const rows = await submissions(item.itemId);
    expect(rows).toHaveLength(1);
    expect(rows[0].submission_id).toBe(first.submission_id);
    expect(rows[0].opened_at.toISOString()).toBe(first.opened_at.toISOString());

    // A material has no submission and creates no row; an admin's preview never writes one.
    const material = await createItem(sciId, { kind: 'material', title: 'Cells reading' });
    expect((await get(`/api/student/items/${material.itemId}`)).data).toMatchObject({ kind: 'material', submission: null, grade: null });
    expect(await submissions(material.itemId)).toHaveLength(0);
    const other = await assignment({ title: 'Lab report' });
    expect((await get(`/api/student/items/${other.itemId}`, asAmalPreview)).data.submission.status).toBe('assigned');
    expect(await submissions(other.itemId)).toHaveLength(0);
  });

  it('text answer autosaves and turn-in needs a non-blank answer', async () => {
    const item = await assignment({ submissionMode: 'text' });
    const url = `/api/student/items/${item.itemId}`;

    let body = await post(`${url}/turn-in`, asAmal, 400);
    expect(body.message).toBe('Write your answer first.');

    const blank = await expectStatus(call('put', `${url}/text`).send({ textAnswer: '   ' }), 200);
    expect(blank.data.savedAt).toEqual(expect.any(String));
    await post(`${url}/turn-in`, asAmal, 400);

    const saved = await expectStatus(call('put', `${url}/text`).send({ textAnswer: 'Plants make sugar from light.' }), 200);
    let { data } = await get(url);
    expect(data.submission).toMatchObject({
      textAnswer: 'Plants make sugar from light.', textSavedAt: saved.data.savedAt, canEdit: true, canTurnIn: true, status: 'assigned',
    });

    await expectStatus(call('put', `${url}/text`).send({ textAnswer: 'x'.repeat(20001) }), 400);
    await expectStatus(call('put', `${url}/text`).send({ textAnswer: 42 }), 400);

    ({ data } = await post(`${url}/turn-in`));
    expect(data.submission).toMatchObject({ status: 'turned_in', isLate: false, canEdit: false, canTurnIn: false, canUnsubmit: true });
    expect(data.submission.turnedInAt).toEqual(expect.any(String));

    body = await expectStatus(call('put', `${url}/text`).send({ textAnswer: 'Changed' }), 409);
    expect(body.code).toBe('ALREADY_SUBMITTED');
    body = await post(`${url}/turn-in`, asAmal, 409);
    expect(body.code).toBe('ALREADY_SUBMITTED');
    expect((await submissions(item.itemId))[0].text_answer).toBe('Plants make sugar from light.');

    // A file assignment takes no typed answer.
    const fileItem = await assignment();
    await expectStatus(call('put', `/api/student/items/${fileItem.itemId}/text`).send({ textAnswer: 'Hi' }), 400);
  });

  it('file mode: upload, list, delete own file, then turn in; turn-in without a file is 400', async () => {
    const item = await assignment();
    const url = `/api/student/items/${item.itemId}`;

    const none = await post(`${url}/turn-in`, asAmal, 400);
    expect(none.message).toBe('Add a photo or file first.');

    const up = await expectStatus(upload(item.itemId, [
      { name: 'diagram.jpg', type: 'image/jpeg' },
      { name: 'Notes.PDF', type: 'application/pdf' },
    ]), 201);
    expect(up.data.files).toEqual([
      { fileId: expect.any(String), fileName: 'diagram.jpg', mimeType: 'image/jpeg', sizeBytes: 10 },
      { fileId: expect.any(String), fileName: 'Notes.PDF', mimeType: 'application/pdf', sizeBytes: 10 },
    ]);
    expect(supabase.storage.from).toHaveBeenCalledWith(BUCKET);
    const paths = supabase._mockStorage.upload.mock.calls.map((c) => c[0]);
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(p).toMatch(new RegExp(`^ALHAADIACADEMY/${item.itemId}/${amalId}/[0-9a-f-]{36}\\.(jpg|pdf)$`));

    // Unsupported types and mismatched MIME types never reach storage.
    supabase._mockStorage.upload.mockClear();
    await expectStatus(upload(item.itemId, [{ name: 'run.exe', type: 'application/octet-stream' }]), 400);
    await expectStatus(upload(item.itemId, [{ name: 'photo.png', type: 'application/pdf' }]), 400);
    await expectStatus(upload(item.itemId, [{ name: 'clip.mp4', type: 'video/mp4' }]), 400);
    expect(supabase._mockStorage.upload).not.toHaveBeenCalled();

    let { data } = await get(url);
    expect(data.submission.files.map((f) => f.fileName)).toEqual(['diagram.jpg', 'Notes.PDF']);
    expect(data.submission.canTurnIn).toBe(true);

    const [photo, notes] = up.data.files;
    const signed = await get(`/api/student/files/${photo.fileId}/url`);
    expect(signed.data.url).toEqual(expect.any(String));
    expect(supabase._mockStorage.createSignedUrl).toHaveBeenCalledWith(paths[0], 3600);

    expect((await expectStatus(call('delete', `/api/student/files/${notes.fileId}`), 200)).data).toEqual({ deleted: true });
    expect(supabase._mockStorage.remove).toHaveBeenCalledWith([paths[1]]);
    ({ data } = await get(url));
    expect(data.submission.files.map((f) => f.fileId)).toEqual([photo.fileId]);

    ({ data } = await post(`${url}/turn-in`));
    expect(data.submission).toMatchObject({ status: 'turned_in', canEdit: false, canUnsubmit: true });

    supabase._mockStorage.upload.mockClear();
    let body = await expectStatus(upload(item.itemId, [{ name: 'late.jpg', type: 'image/jpeg' }]), 409);
    expect(body.code).toBe('ALREADY_SUBMITTED');
    expect(supabase._mockStorage.upload).not.toHaveBeenCalled();
    body = await expectStatus(call('delete', `/api/student/files/${photo.fileId}`), 409);
    expect(body.code).toBe('ALREADY_SUBMITTED');
    expect((await get(url)).data.submission.files).toHaveLength(1);
  });

  it('turning in after the due date marks it late; with accept_late off it is 409 ITEM_CLOSED', async () => {
    const onTime = await assignment({ submissionMode: 'done', title: 'On time' });
    let { data } = await post(`/api/student/items/${onTime.itemId}/turn-in`);
    expect(data.submission).toMatchObject({ status: 'turned_in', isLate: false });

    const late = await assignment({ submissionMode: 'done', title: 'Late one', dueAt: inDays(-1) });
    const url = `/api/student/items/${late.itemId}`;
    ({ data } = await get(url));
    expect(data.submission).toMatchObject({ status: 'missing', closed: false, canEdit: true, canTurnIn: true });

    ({ data } = await post(`${url}/turn-in`));
    expect(data.submission).toMatchObject({ status: 'turned_in', isLate: true, canUnsubmit: true });
    const [row] = await submissions(late.itemId);
    expect(row).toMatchObject({ is_late: true });
    expect(row.first_turned_in_at).not.toBeNull();

    await post(`${url}/unsubmit`);
    await pool.query(`UPDATE classes SET accept_late = FALSE WHERE class_id = $1`, [sciId]);
    ({ data } = await get(url));
    expect(data.submission).toMatchObject({ status: 'missing', closed: true, canEdit: false, canTurnIn: false, canUnsubmit: false });
    const body = await post(`${url}/turn-in`, asAmal, 409);
    expect(body).toMatchObject({ code: 'ITEM_CLOSED', message: CLOSED });
    const closedFile = await assignment({ title: 'Closed upload', dueAt: inDays(-1) });
    expect((await expectStatus(upload(closedFile.itemId, [{ name: 'a.jpg', type: 'image/jpeg' }]), 409)).code).toBe('ITEM_CLOSED');
    expect((await expectStatus(call('put', `/api/student/items/${closedFile.itemId}/text`).send({ textAnswer: 'x' }), 400)).message)
      .toBe("This assignment doesn't take a typed answer.");
    expect(supabase._mockStorage.upload).not.toHaveBeenCalled();

    // Work turned in on time is not unsubmitted into a closed assignment.
    await setDue(onTime.itemId, inDays(-1));
    ({ data } = await get(`/api/student/items/${onTime.itemId}`));
    expect(data.submission).toMatchObject({ status: 'turned_in', isLate: false, closed: true, canUnsubmit: false });
    expect((await post(`/api/student/items/${onTime.itemId}/unsubmit`, asAmal, 409)).code).toBe('ITEM_CLOSED');
  });

  it('unsubmit clears turned_in_at until a grade is published, then 409', async () => {
    const item = await graded({ submissionMode: 'done' });
    const url = `/api/student/items/${item.itemId}`;
    const assessmentId = item.gradebook.assessmentId;

    await post(`${url}/turn-in`);
    const [before] = await submissions(item.itemId);
    let { data } = await post(`${url}/unsubmit`);
    expect(data.submission).toMatchObject({ status: 'assigned', turnedInAt: null, canEdit: true, canUnsubmit: false });
    const [after] = await submissions(item.itemId);
    expect(after.turned_in_at).toBeNull();
    expect(after.first_turned_in_at.toISOString()).toBe(before.first_turned_in_at.toISOString());
    expect((await post(`${url}/unsubmit`, asAmal, 409)).message).toEqual(expect.any(String));

    await post(`${url}/turn-in`);
    // A score on the still-unpublished column is invisible: no grade, unsubmit still open.
    await score(amalId, assessmentId, 8);
    ({ data } = await get(url));
    expect(data.grade).toBeNull();
    expect(data.submission).toMatchObject({ status: 'turned_in', canUnsubmit: true });
    expect(JSON.stringify(data)).not.toContain('"score":8');

    await publish(assessmentId);
    ({ data } = await get(url));
    expect(data.submission).toMatchObject({ status: 'graded', canUnsubmit: false, canEdit: false });
    expect(data.grade).toEqual({ score: 8, maxScore: 10, status: 'graded', feedback: null, publishedAt: expect.any(String) });
    expect((await post(`${url}/unsubmit`, asAmal, 409)).code).toBe('ITEM_CLOSED');
    expect((await submissions(item.itemId))[0].turned_in_at).not.toBeNull();
  });

  it('a draft, a future scheduled item, and an audience-some item for another student are 404 for this student', async () => {
    const draft = await assignment({ title: 'Draft', status: 'draft' });
    const scheduled = await assignment({ title: 'Later', status: 'scheduled', publishAt: inDays(3) });
    const forBilal = await assignment({ title: 'Only Bilal', audience: 'some', studentIds: [bilalId] });
    const futureTest = await assessment(sciId, 'Unit 2 test', { parentId: homeworkId, max: 30, date: torontoDay(inDays(5)) });
    const testItemId = await itemOf(futureTest);

    for (const id of [draft.itemId, scheduled.itemId, forBilal.itemId, testItemId]) {
      await get(`/api/student/items/${id}`, asAmal, 404);
      await post(`/api/student/items/${id}/turn-in`, asAmal, 404);
      await post(`/api/student/items/${id}/unsubmit`, asAmal, 404);
      await expectStatus(call('put', `/api/student/items/${id}/text`).send({ textAnswer: 'x' }), 404);
      await expectStatus(upload(id, [{ name: 'a.jpg', type: 'image/jpeg' }]), 404);
    }
    expect(supabase._mockStorage.upload).not.toHaveBeenCalled();
    for (const id of [draft.itemId, scheduled.itemId, forBilal.itemId, testItemId]) expect(await submissions(id)).toHaveLength(0);
    await get('/api/student/items/not-a-uuid', asAmal, 404);

    // Bilal opens his own.
    expect((await get(`/api/student/items/${forBilal.itemId}`, asBilal)).data.title).toBe('Only Bilal');

    const { data } = await get(`/api/student/classes/${sciId}/classwork`);
    expect(data.items).toEqual([]);
    for (const id of [draft.itemId, scheduled.itemId, forBilal.itemId, testItemId]) {
      expect(JSON.stringify(data)).not.toContain(id);
    }
    const todo = await get('/api/student/todo');
    expect(todo.data.counts.assigned).toBe(0);
  });

  it('todo counts and groups: assigned, derived missing after due date, done', async () => {
    const soon = await assignment({ title: 'Due soon', dueAt: inDays(1) });
    const far = await assignment({ title: 'Due later', dueAt: inDays(10) });
    const undated = await assignment({ title: 'Reading log', submissionMode: 'text', dueAt: null });
    const overdue = await assignment({ title: 'Overdue', dueAt: inDays(-1) });
    const turnedIn = await assignment({ title: 'Handed in', submissionMode: 'done', dueAt: inDays(3) });
    const inClass = await assignment({ title: 'On paper', submissionMode: 'none', dueAt: inDays(-2) });
    await createItem(sciId, { kind: 'material', title: 'Cells reading' });
    const mathWork = await createItem(mathId, { kind: 'assignment', title: 'Fractions', submissionMode: 'done', dueAt: inDays(4) }, asOtherTeacher);
    // A plain test marked missing and published: a confirmed missing, dated five days ago.
    const quizId = await assessment(sciId, 'Pop quiz', { parentId: homeworkId, max: 10, date: torontoDay(inDays(-5)) });
    await score(amalId, quizId, null, 'missing');
    await publish(quizId);
    const quizItemId = await itemOf(quizId);

    await post(`/api/student/items/${turnedIn.itemId}/turn-in`);

    let { data } = await get('/api/student/todo');
    expect(data.counts).toEqual({ assigned: 4, missing: 2, done: 1 });
    const flat = data.groups.flatMap((g) => g.items.map((i) => i.title));
    expect(flat.sort()).toEqual(['Due later', 'Due soon', 'Fractions', 'Reading log']);
    expect(data.groups[data.groups.length - 1]).toMatchObject({ label: 'No due date', items: [expect.objectContaining({ title: 'Reading log' })] });
    const row = data.groups.flatMap((g) => g.items).find((i) => i.itemId === soon.itemId);
    expect(row).toEqual({
      itemId: soon.itemId, classId: sciId, subject: 'Science', teacherName: 'Ziad Teacher', iconUrl: '/class-icons/science.svg',
      title: 'Due soon', kind: 'assignment', submissionMode: 'file', dueAt: soon.dueAt, date: null,
      status: 'assigned', isLate: false, questionCount: 0, turnedInAt: null, publishedAt: null,
    });

    ({ data } = await get('/api/student/todo?tab=missing'));
    expect(data.groups).toEqual([{ label: 'Missing', items: [
      expect.objectContaining({ itemId: overdue.itemId, status: 'missing' }),
      expect.objectContaining({ itemId: quizItemId, status: 'missing', kind: 'assessment' }),
    ] }]);
    expect(JSON.stringify(data)).not.toContain(inClass.itemId); // nothing to turn in: never missing

    ({ data } = await get('/api/student/todo?tab=done'));
    expect(data.groups).toEqual([{ label: 'This week', items: [expect.objectContaining({ itemId: turnedIn.itemId, status: 'turned_in' })] }]);

    ({ data } = await get(`/api/student/todo?tab=assigned&classId=${mathId}`));
    expect(data.counts).toEqual({ assigned: 1, missing: 0, done: 0 });
    expect(data.groups.flatMap((g) => g.items).map((i) => i.itemId)).toEqual([mathWork.itemId]);
    await get('/api/student/todo?tab=everything', asAmal, 400);
    await get('/api/student/todo?classId=nope', asAmal, 400);

    // The same rule feeds home, the class cards, the class page and grades.
    const home = (await get('/api/student/home')).data;
    expect(home.dueSoon.map((i) => i.itemId)).toEqual([soon.itemId, mathWork.itemId]);
    expect(home.missing.map((i) => i.itemId)).toEqual([overdue.itemId, quizItemId]);
    const sciCard = home.classes.find((c) => c.classId === sciId);
    expect(sciCard).toMatchObject({ missingCount: 2, next: { itemId: soon.itemId, title: 'Due soon', kind: 'assignment', dueAt: soon.dueAt, date: null } });
    expect(home.classes.find((c) => c.classId === mathId)).toMatchObject({ missingCount: 0, next: { itemId: mathWork.itemId } });

    const page = (await get(`/api/student/classes/${sciId}`)).data;
    expect(page.upcoming.map((i) => i.title)).toEqual(['Due soon', 'Due later']);
    const classwork = (await get(`/api/student/classes/${sciId}/classwork`)).data;
    expect(classwork.upcoming).toEqual(page.upcoming);
    const byTitle = Object.fromEntries(classwork.items.map((i) => [i.title, i]));
    expect(byTitle['Overdue']).toMatchObject({ status: 'missing', grade: null, topicId: null, postedAt: overdue.postedAt });
    expect(byTitle['On paper'].status).toBe('no_turn_in');
    expect(byTitle['Cells reading'].status).toBe('material');
    expect(byTitle['Pop quiz']).toMatchObject({ status: 'missing', grade: { score: null, maxScore: 10 } });
    expect(byTitle['Handed in'].status).toBe('turned_in');

    const stream = (await get(`/api/student/classes/${sciId}/stream`)).data;
    expect(stream.notices.map((n) => n.title).sort()).toEqual(['Cells reading', 'Due later', 'Due soon', 'Handed in', 'On paper', 'Overdue', 'Reading log']);
    expect(Object.keys(stream.notices[0]).sort()).toEqual(['dueAt', 'itemId', 'kind', 'postedAt', 'title']);
    expect(stream.notices[0]).toMatchObject({ title: 'Cells reading', kind: 'material', dueAt: null }); // newest first

    const grades = (await get('/api/student/grades')).data;
    expect(grades.classes.find((c) => c.classId === sciId).missingCount).toBe(2);
  });

  it("another student's item and file are 404", async () => {
    const shared = await assignment({ title: 'Shared' });
    const bilalUp = await expectStatus(upload(shared.itemId, [{ name: 'bilal-work.jpg', type: 'image/jpeg' }], asBilal), 201);
    const bilalFile = bilalUp.data.files[0].fileId;
    await post(`/api/student/items/${shared.itemId}/turn-in`, asBilal);

    await get(`/api/student/files/${bilalFile}/url`, asAmal, 404);
    await expectStatus(call('delete', `/api/student/files/${bilalFile}`), 404);
    await get('/api/student/files/not-a-uuid/url', asAmal, 404);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM submission_files`)).rows[0].n).toBe(1);

    const mine = (await get(`/api/student/items/${shared.itemId}`)).data;
    expect(mine.submission).toMatchObject({ status: 'assigned', files: [] });
    const raw = JSON.stringify(mine);
    expect(raw).not.toContain(bilalFile);
    expect(raw).not.toContain('bilal-work');
    expect(raw).not.toContain(bilalId);

    // An item in a class Amal isn't in.
    const arabicItem = await createItem(arabicId, { kind: 'assignment', title: 'Letters', submissionMode: 'done', dueAt: inDays(2) }, asOtherTeacher);
    await get(`/api/student/items/${arabicItem.itemId}`, asAmal, 404);
    await post(`/api/student/items/${arabicItem.itemId}/turn-in`, asAmal, 404);
    await get(`/api/student/classes/${arabicId}/classwork`, asAmal, 404);
    expect((await get(`/api/student/items/${arabicItem.itemId}`, asBilal)).data.title).toBe('Letters');
  });

  it("parent sees the child's classwork read-only (no submission row created) and 403 for another child", async () => {
    const item = await graded({ title: 'Lab sheet' });
    const overdue = await assignment({ title: 'Overdue', dueAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() });
    const lens = `/api/parent-portal/students/${amalId}/classroom`;

    let { data } = await get(`${lens}/items/${item.itemId}`, asParent);
    expect(data).toMatchObject({
      itemId: item.itemId, title: 'Lab sheet', kind: 'assignment',
      submission: { status: 'assigned', files: [], canEdit: false, canTurnIn: false, canUnsubmit: false },
    });
    expect(await submissions(item.itemId)).toHaveLength(0);

    const classwork = (await get(`${lens}/classes/${sciId}/classwork`, asParent)).data;
    const student = (await get(`/api/student/classes/${sciId}/classwork`)).data;
    expect(classwork).toEqual(student);
    expect(await submissions(item.itemId)).toHaveLength(0);
    expect((await get(`${lens}/classes/${sciId}`, asParent)).data.upcoming).toEqual(student.upcoming);

    const up = await expectStatus(upload(item.itemId, [{ name: 'lab.pdf', type: 'application/pdf' }]), 201);
    await post(`/api/student/items/${item.itemId}/turn-in`);
    ({ data } = await get(`${lens}/items/${item.itemId}`, asParent));
    expect(data.submission).toMatchObject({ status: 'turned_in', files: [{ fileName: 'lab.pdf' }], canUnsubmit: false });
    expect((await get(`${lens}/files/${up.data.files[0].fileId}/url`, asParent)).data.url).toEqual(expect.any(String));

    // The summary counts the same work: one due this week, one missing, and a "Needs you" row for it.
    const summary = (await get('/api/parent-portal/classroom/summary', asParent)).data;
    const amal = summary.children.find((c) => c.studentId === amalId);
    expect(amal).toMatchObject({ dueThisWeek: 0, missingCount: 1 });
    expect(summary.needsYou).toEqual([{
      kind: 'missing', itemId: overdue.itemId, assessmentId: null, title: 'Overdue', classId: sciId, classSubject: 'Science',
      teacher: { userId: TEACHER_ID, name: 'Ziad Teacher', avatar: null }, studentId: amalId, dueAt: overdue.dueAt, date: null,
    }]);
    await assignment({ title: 'This week', dueAt: inDays(3) });
    expect((await get('/api/parent-portal/classroom/summary', asParent)).data.children.find((c) => c.studentId === amalId).dueThisWeek).toBe(1);

    // Another family's child.
    for (const url of [`${lens}/items/${item.itemId}`, `${lens}/classes/${sciId}/classwork`, `${lens}/files/${up.data.files[0].fileId}/url`]) {
      await get(url, asOtherParent, 403);
    }
    // Bilal's parent cannot reach Amal's file through Bilal either.
    await get(`/api/parent-portal/students/${bilalId}/classroom/files/${up.data.files[0].fileId}/url`, asOtherParent, 404);
    await get(`/api/parent-portal/students/${bilalId}/classroom/items/${item.itemId}`, asOtherParent, 200);
    await get(`/api/parent-portal/students/${bilalId}/classroom/classes/${mathId}/classwork`, asOtherParent, 404);
  });

  it('WORK_STATE_SQL agrees with workStatus for every branch', async () => {
    const mk = async (title, o = {}) => (await pool.query(
      `INSERT INTO classwork_items (class_id, kind, title, submission_mode, status, posted_at, due_at, assessment_id)
       VALUES ($1, $2, $3, $4, 'posted', NOW(), $5, $6) RETURNING item_id`,
      [sciId, o.kind ?? 'assignment', o.assessmentId ? null : title, o.mode ?? (o.kind && o.kind !== 'assignment' ? 'none' : 'file'),
        o.dueAt ?? null, o.assessmentId ?? null],
    )).rows[0].item_id;
    // A linked assignment takes over the column's trigger-created item, so convert that row in place.
    const linked = async (name, o = {}) => {
      const aId = await assessment(sciId, name, { parentId: homeworkId, max: 10, published: o.published ?? true });
      const itemId = await itemOf(aId);
      await pool.query(
        `UPDATE classwork_items SET kind = 'assignment', submission_mode = 'file', due_at = $2 WHERE item_id = $1`,
        [itemId, o.dueAt ?? inDays(2)],
      );
      if (o.cell) await score(amalId, aId, o.cell.score, o.cell.status);
      return itemId;
    };
    const turnIn = (itemId, late) => pool.query(
      `INSERT INTO classwork_submissions (item_id, student_id, turned_in_at, first_turned_in_at, is_late)
       VALUES ($1, $2, NOW(), NOW(), $3)`, [itemId, amalId, late],
    );

    const cases = {};
    cases.excused = await linked('Excused', { cell: { score: null, status: 'excused' } });
    await turnIn(cases.excused, true);
    cases.confirmedMissing = await linked('Confirmed missing', { cell: { score: null, status: 'missing' } });
    await turnIn(cases.confirmedMissing, false);
    cases.graded = await linked('Graded', { cell: { score: 8, status: 'graded' } });
    await turnIn(cases.graded, true);
    cases.unpublishedScore = await linked('Unpublished', { published: false, cell: { score: 9, status: 'graded' } });
    cases.blankCell = await linked('Blank', { cell: { score: null, status: 'graded' } });
    cases.material = await mk('Material', { kind: 'material' });
    const plainId = await assessment(sciId, 'Plain', { parentId: homeworkId, max: 10 });
    cases.plain = await itemOf(plainId);
    cases.paperAssignment = await mk('Paper', { mode: 'none', dueAt: inDays(-1) });
    cases.turnedIn = await mk('Turned in', { dueAt: inDays(-1) });
    await turnIn(cases.turnedIn, true);
    cases.derivedMissing = await mk('Derived', { dueAt: inDays(-1) });
    cases.quizMissing = await mk('Quiz', { kind: 'quiz', dueAt: inDays(-1) });
    cases.assigned = await mk('Assigned', { dueAt: inDays(1) });
    cases.noDue = await mk('No due');

    const { rows } = await pool.query(`
      SELECT i.item_id, i.kind, i.submission_mode, i.assessment_id, i.due_at,
             COALESCE(a.is_published, FALSE) AS is_published, sa.score, sa.status AS sa_status, sa.student_id AS sa_student,
             sub.turned_in_at, sub.is_late AS sub_late, NOW() AS now,
             ${WORK_STATE_SQL} AS state, ${WORK_LATE_SQL} AS late
      FROM classwork_items i
      LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
      LEFT JOIN classwork_submissions sub ON sub.item_id = i.item_id AND sub.student_id = $1
      LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = $1
      WHERE i.class_id = $2`, [amalId, sciId]);
    const byId = new Map(rows.map((r) => [r.item_id, r]));

    const expected = {
      excused: ['excused', false], confirmedMissing: ['missing', false], graded: ['graded', true],
      unpublishedScore: ['assigned', false], blankCell: ['assigned', false], material: ['material', false],
      plain: ['no_turn_in', false], paperAssignment: ['no_turn_in', false], turnedIn: ['turned_in', true],
      derivedMissing: ['missing', false], quizMissing: ['missing', false], assigned: ['assigned', false], noDue: ['assigned', false],
    };
    for (const [name, [status, isLate]] of Object.entries(expected)) {
      const r = byId.get(cases[name]);
      const js = workStatus(
        { kind: r.kind, submissionMode: r.submission_mode, assessmentId: r.assessment_id, dueAt: r.due_at },
        r.turned_in_at || r.sub_late !== null ? { turnedInAt: r.turned_in_at, isLate: r.sub_late } : null,
        { isPublished: r.is_published, row: r.sa_student ? { score: r.score === null ? null : Number(r.score), status: r.sa_status } : null },
        r.now,
      );
      expect([name, r.state, r.late]).toEqual([name, status, isLate]);
      expect([name, js.status, js.isLate]).toEqual([name, r.state, r.late]);
    }
  });

  it('teacher classwork counts and People missing counts follow the same rule', async () => {
    const archivedId = await makeStudent('Old Student', [sciId]);
    await pool.query(`UPDATE students SET is_archived = TRUE WHERE student_id = $1`, [archivedId]);

    const past = await graded({ title: 'Past due', submissionMode: 'done', dueAt: inDays(2) });
    await post(`/api/student/items/${past.itemId}/turn-in`); // Amal, on time
    await setDue(past.itemId, new Date(Date.now() - HOUR_MS).toISOString()); // now past due: Bilal is missing
    const future = await assignment({ title: 'Future', submissionMode: 'done', dueAt: inDays(3) });
    const quizId = await assessment(sciId, 'Pop quiz', { parentId: homeworkId, max: 10, date: torontoDay(inDays(-3)) });
    await score(bilalId, quizId, null, 'missing');
    await score(amalId, quizId, 9);
    await publish(quizId);

    const itemsRes = await expectStatus(call('get', `/api/classroom/classes/${sciId}/items`, asTeacher), 200);
    const counts = (title) => itemsRes.data.items.find((i) => i.title === title).counts;
    expect(counts('Past due')).toEqual({ turnedIn: 1, missing: 1, notYet: 0, toReview: 1, drafts: 0, published: 0 });
    expect(counts('Future')).toEqual({ turnedIn: 0, missing: 0, notYet: 2, toReview: 0, drafts: 0, published: 0 });
    expect(counts('Pop quiz')).toEqual({ turnedIn: 0, missing: 1, notYet: 0, toReview: 0, drafts: 0, published: 0 });

    // A draft score moves Amal's work from "to review" to "drafts" (T16 writes these).
    await pool.query(`UPDATE classwork_submissions SET draft_score = 7 WHERE item_id = $1 AND student_id = $2`, [past.itemId, amalId]);
    const single = await expectStatus(call('get', `/api/classroom/items/${past.itemId}`, asTeacher), 200);
    expect(single.data.counts).toEqual({ turnedIn: 1, missing: 1, notYet: 0, toReview: 0, drafts: 1, published: 0 });

    const people = (await expectStatus(call('get', `/api/classroom/classes/${sciId}/people`, asTeacher), 200)).data;
    const missingOf = (id) => people.students.find((s) => s.studentId === id).missingCount;
    expect(missingOf(bilalId)).toBe(2);
    expect(missingOf(amalId)).toBe(0);
    expect(people.counts.missingWork).toBe(1);

    // Bilal's own To-do agrees with People.
    expect((await get(`/api/student/todo?tab=missing&classId=${sciId}`, asBilal)).data.counts.missing).toBe(2);

    // The teacher Stream and Coming up count turn-ins.
    const stream = (await expectStatus(call('get', `/api/classroom/classes/${sciId}/stream`, asTeacher), 200)).data;
    expect(stream.notices.find((n) => n.itemId === past.itemId)).toMatchObject({ turnedInCount: 1, total: 2 });
    expect(stream.upcoming.find((r) => r.itemId === future.itemId)).toMatchObject({ stillToTurnIn: 2 });
    await post(`/api/student/items/${future.itemId}/turn-in`, asBilal);
    const after = (await expectStatus(call('get', `/api/classroom/classes/${sciId}/stream`, asTeacher), 200)).data;
    expect(after.upcoming.find((r) => r.itemId === future.itemId)).toMatchObject({ stillToTurnIn: 1 });
    expect(after.notices.find((n) => n.itemId === future.itemId)).toMatchObject({ turnedInCount: 1, total: 2 });
  });
});
