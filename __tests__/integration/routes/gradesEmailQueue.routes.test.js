// The parents' "New Grades Posted" email through the email outbox: a publish
// queues it in its own transaction (one row per guardian address) and the
// notifier's tick sends it after the hold, built from the gradebook as it is
// then. Covers the hold, merging, undo, failures, Retry, the idempotency
// key, two workers at once, the delivery and history endpoints and who may
// read them. Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const engine = require('../../../services/analyticsEngine');
const outbox = require('../../../services/email/outbox');
const notifier = require('../../../services/messageNotifier');
const { getResend } = require('../../../utils/emailUtils');
const { deliverQueuedEmails, outboxRows } = require('../../helpers/emailOutbox');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440101';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440102';
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asParent = { userId: '550e8400-e29b-41d4-a716-446655440103', username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };

const MONA = 'mona.haddad@example.com';
const OMAR = 'omar.haddad@example.com';
const RANIA = 'rania.karim@example.com';

describe('Integration: the grades email queue', () => {
  let pool, yearId, sciId, mathId, amalId, bilalId, daliaId, quizId, labId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const send = () => getResend().emails.send;
  const sent = () => send().mock.calls.map(([msg]) => msg);
  const keys = () => send().mock.calls.map(([, options]) => options?.idempotencyKey);

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const get = (url, who = asTeacher, status = 200) => expectStatus(authenticatedRequest('get', url, who), status);
  const post = (url, body, who = asTeacher, status = 200) => expectStatus(authenticatedRequest('post', url, who).send(body), status);
  const base = (classId = sciId) => `/api/assessment-publications/classes/${classId}`;
  const publish = async (assessmentIds, extra = {}) => (await post(`${base()}/publish`, { assessmentIds, ...extra }, asTeacher, 201)).data;
  const unpublish = (assessmentIds) => post(`${base()}/unpublish`, { assessmentIds });
  const delivery = async (batchId, classId = sciId) => (await get(`${base(classId)}/batches/${batchId}/delivery`)).data;
  const retry = async (batchId) => (await post(`${base()}/batches/${batchId}/retry`, {})).data;
  const isPublished = async (id) => (await pool.query(`SELECT is_published FROM assessments WHERE assessment_id = $1`, [id])).rows[0].is_published;
  const auditRows = async () => (await pool.query(
    `SELECT batch_id, student_id, status, email_addresses, assessment_ids FROM assessment_publication_emails ORDER BY sent_at`,
  )).rows;
  const makeDue = () => pool.query(`UPDATE email_outbox SET send_after = NOW() WHERE status = 'pending'`);
  const drain = (opts = {}) => outbox.drainOutbox({ pauseMs: 0, ...opts });

  const makeStudent = async (name, classId) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2) RETURNING student_id`,
      [name, yearId],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, id]);
    return id;
  };
  const guardian = (studentId, name, email) => pool.query(
    `INSERT INTO parent_students (student_id, parent_name, parent_email, relation, school) VALUES ($1, $2, $3, 'Guardian', 'ALHAADIACADEMY')`,
    [studentId, name, email],
  );
  const assessment = async (classId, name, max) => (await pool.query(
    `INSERT INTO assessments (class_id, name, weight_points, max_score) VALUES ($1, $2, 10, $3) RETURNING assessment_id`,
    [classId, name, max],
  )).rows[0].assessment_id;
  const score = (studentId, assessmentId, value) => pool.query(
    `INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)`, [studentId, assessmentId, value],
  );

  beforeEach(async () => {
    send().mockReset();
    send().mockResolvedValue({ data: { id: 'email-1' }, error: null });
    engine.invalidateCache();
    outbox.resetOutboxState();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    for (const [id, email, first] of [[TEACHER_ID, 'ziad.teacher@example.com', 'Ziad'], [OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina']]) {
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, 'hashed', $3, 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
        [id, email, first],
      );
    }
    const makeClass = async (subject, teacherId) => (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '5', $1, 'Lead Name', $2, $3) RETURNING class_id`,
      [subject, teacherId, yearId],
    )).rows[0].class_id;
    sciId = await makeClass('Science', TEACHER_ID);
    mathId = await makeClass('Math', OTHER_TEACHER_ID);

    amalId = await makeStudent('Amal Haddad', sciId);
    bilalId = await makeStudent('Bilal Karim', sciId);
    daliaId = await makeStudent('Dalia Nassar', sciId); // no guardian on file
    await guardian(amalId, 'Mona Haddad', MONA);
    await guardian(amalId, 'Omar Haddad', OMAR);
    await guardian(bilalId, 'Rania Karim', RANIA);

    quizId = await assessment(sciId, 'Cells quiz', 10);
    labId = await assessment(sciId, 'Seed lab', 20);
    await score(amalId, quizId, 8);
    await score(bilalId, quizId, 6);
    await score(daliaId, quizId, 9);
    await score(amalId, labId, 18);
  });

  it('a publish only queues its emails: one row per address, held, then sent and logged once per address', async () => {
    const data = await publish([quizId], { batchComment: 'Great effort this week.' });
    expect(send()).not.toHaveBeenCalled();
    expect(data.delivery).toEqual({ batchId: data.batchId, families: 2, noEmail: 1 });
    expect(await isPublished(quizId)).toBe(true);

    const rows = await outboxRows(pool);
    expect(rows.map((r) => [r.recipient_email, r.status]).sort()).toEqual(
      [[MONA, 'pending'], [OMAR, 'pending'], [RANIA, 'pending'], [null, 'skipped']].sort(),
    );
    const dalia = rows.find((r) => r.student_id === daliaId);
    expect(dalia.skip_reason).toBe('No guardian email on file');
    // Held: not due for about two minutes.
    const wait = new Date(rows.find((r) => r.recipient_email === MONA).send_after) - Date.now();
    expect(wait).toBeGreaterThan(100 * 1000);
    expect(wait).toBeLessThanOrEqual(121 * 1000);
    expect(await drain()).toBe(0);
    expect(send()).not.toHaveBeenCalled();

    const before = await delivery(data.batchId);
    expect(before.counts).toEqual({ pending: 2, sent: 0, failed: 0, skipped: 1 });
    expect(before.students.find((s) => s.studentId === daliaId)).toMatchObject({ status: 'skipped', reason: 'No guardian email on file' });

    await makeDue();
    expect(await drain()).toBe(3);
    // One email per address, each with its own buttons.
    expect(sent().map((m) => m.to).sort()).toEqual([[MONA], [OMAR], [RANIA]]);
    const toMona = sent().find((m) => m.to[0] === MONA);
    expect(toMona.subject).toBe('Amal Haddad — New Grades Posted (Science)');
    expect(toMona.html).toContain('8/10');
    expect(toMona.html).toContain('Great effort this week.');
    expect(toMona.html).not.toContain('18/20'); // Seed lab isn't published
    expect(keys().every((k) => /^grades_digest:[0-9a-f-]{36}:0$/.test(k))).toBe(true);

    const after = await delivery(data.batchId);
    expect(after.counts).toEqual({ pending: 0, sent: 2, failed: 0, skipped: 1 });
    const amal = after.students.find((s) => s.studentId === amalId);
    expect(amal).toMatchObject({ studentName: 'Amal Haddad', status: 'sent' });
    expect(amal.recipients.map((r) => r.email).sort()).toEqual([MONA, OMAR]);
    // Today's per-send log (read by the 4 pm missing alert): one 'sent' row per address.
    const audit = await auditRows();
    expect(audit).toHaveLength(3);
    expect(audit.every((r) => r.status === 'sent' && r.batch_id === data.batchId && r.email_addresses.length === 1)).toBe(true);
    expect((await outboxRows(pool)).find((r) => r.recipient_email === MONA)).toMatchObject({ status: 'sent', attempts: 1 });

    // History: counts per family, from the outbox.
    const history = (await get(`${base()}/history`)).data;
    expect(history[0]).toMatchObject({ batchId: data.batchId, emailSummary: { sent: 2, failed: 0, skipped: 1, pending: 0, queued: true } });

    // Nothing is sent twice.
    await makeDue();
    expect(await drain()).toBe(0);
    expect(send()).toHaveBeenCalledTimes(3);
  });

  it('the email is queued in the publish transaction: if queueing fails, nothing is published', async () => {
    const spy = jest.spyOn(outbox, 'enqueue').mockRejectedValueOnce(new Error('connection reset'));
    try {
      await post(`${base()}/publish`, { assessmentIds: [quizId] }, asTeacher, 500);
    } finally {
      spy.mockRestore();
    }
    expect(await isPublished(quizId)).toBe(false);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM assessment_publication_batches`)).rows[0].n).toBe(0);
    expect(await outboxRows(pool)).toEqual([]);
  });

  it("two publishes of a class inside the hold go out as one email per address, listing both", async () => {
    const first = await publish([quizId]);
    const second = await publish([labId]);
    await makeDue();
    await drain();
    const toMona = sent().filter((m) => m.to[0] === MONA);
    expect(toMona).toHaveLength(1);
    expect(toMona[0].html).toContain('Cells quiz');
    expect(toMona[0].html).toContain('Seed lab');
    expect(toMona[0].html).toContain('18/20');
    // Bilal has nothing in the lab publish: his one email is the quiz's.
    expect(sent().filter((m) => m.to[0] === RANIA)).toHaveLength(1);
    expect(send()).toHaveBeenCalledTimes(3);

    const rows = await outboxRows(pool);
    const monaRows = rows.filter((r) => r.recipient_email === MONA);
    expect(monaRows).toHaveLength(2);
    const [sentRow, merged] = monaRows[0].merged_into ? [monaRows[1], monaRows[0]] : monaRows;
    expect(merged.merged_into).toBe(sentRow.id);
    expect(monaRows.every((r) => r.status === 'sent')).toBe(true);
    // Each publish reads as sent, and the log names each publish.
    expect((await delivery(first.batchId)).counts.sent).toBe(2);
    expect((await delivery(second.batchId)).counts).toMatchObject({ sent: 1, pending: 0 });
    const audit = await auditRows();
    expect(audit.filter((r) => r.email_addresses[0] === MONA).map((r) => r.batch_id).sort()).toEqual([first.batchId, second.batchId].sort());
  });

  it('a publish again of the same columns (a double click) still sends one email per address', async () => {
    await publish([quizId]);
    await publish([quizId]);
    await makeDue();
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR, RANIA]);
  });

  it('an unpublish inside the hold cancels the queued emails; an email already sent stays sent', async () => {
    const { batchId } = await publish([quizId]);
    await unpublish([quizId]);
    const rows = await outboxRows(pool);
    expect(rows.filter((r) => r.recipient_email).every((r) => r.status === 'skipped' && r.skip_reason === 'Unpublished before it was sent')).toBe(true);
    await makeDue();
    expect(await drain()).toBe(0);
    expect(send()).not.toHaveBeenCalled();
    expect((await delivery(batchId)).counts).toEqual({ pending: 0, sent: 0, failed: 0, skipped: 3 });

    // Published again and sent; unpublishing afterwards recalls nothing.
    const again = await publish([quizId]);
    await makeDue();
    await drain();
    expect(send()).toHaveBeenCalledTimes(3);
    await unpublish([quizId]);
    expect((await delivery(again.batchId)).counts.sent).toBe(2);
  });

  it('a column unpublished by any route before the send is left out at send time; nothing left, no email', async () => {
    await publish([quizId, labId]);
    await pool.query(`UPDATE assessments SET is_published = FALSE WHERE assessment_id = $1`, [labId]);
    await makeDue();
    await drain();
    const toMona = sent().find((m) => m.to[0] === MONA);
    expect(toMona.html).toContain('Cells quiz');
    expect(toMona.html).not.toContain('Seed lab');

    send().mockClear();
    const { batchId } = await publish([labId]);
    await pool.query(`UPDATE assessments SET is_published = FALSE WHERE assessment_id = $1`, [labId]);
    await makeDue();
    await drain();
    expect(send()).not.toHaveBeenCalled();
    expect((await delivery(batchId)).students[0]).toMatchObject({ status: 'skipped' });
  });

  it('an address no longer on file when the email is due is skipped', async () => {
    const { batchId } = await publish([quizId]);
    await pool.query(`DELETE FROM parent_students WHERE parent_email = $1`, [OMAR]);
    await makeDue();
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, RANIA]);
    const amal = (await delivery(batchId)).students.find((s) => s.studentId === amalId);
    expect(amal.recipients.find((r) => r.email === OMAR)).toMatchObject({ status: 'skipped', reason: 'No longer a guardian address' });
  });

  it('a refused address fails at once and the others still go; Retry sends it again with a new key', async () => {
    send().mockImplementation(async (msg) => (msg.to[0] === OMAR
      ? { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } }
      : { data: { id: 'email-ok' }, error: null }));
    const { batchId } = await publish([quizId]);
    await makeDue();
    await drain();
    expect(send()).toHaveBeenCalledTimes(3);
    const omarRow = (await outboxRows(pool)).find((r) => r.recipient_email === OMAR);
    expect(omarRow).toMatchObject({ status: 'failed', attempts: 1, error_count: 1, last_error: 'Invalid `to` field.' });
    const firstKey = keys()[send().mock.calls.findIndex(([m]) => m.to[0] === OMAR)];

    const report = await delivery(batchId);
    expect(report.counts).toEqual({ pending: 0, sent: 1, failed: 1, skipped: 1 });
    const amal = report.students.find((s) => s.studentId === amalId);
    expect(amal.status).toBe('failed');
    expect(amal.recipients.find((r) => r.email === OMAR)).toMatchObject({ status: 'failed', error: 'Invalid `to` field.' });
    expect(amal.recipients.find((r) => r.email === MONA)).toMatchObject({ status: 'sent' });

    // Fixed on Resend's side; the teacher presses Retry.
    send().mockClear();
    send().mockResolvedValue({ data: { id: 'email-2' }, error: null });
    const retried = await retry(batchId);
    expect(retried).toMatchObject({ requeued: 1, added: 0, dropped: 0, counts: { pending: 1, failed: 0 } });
    await drain();
    expect(sent().map((m) => m.to)).toEqual([[OMAR]]);
    expect(keys()[0]).not.toBe(firstKey);
    expect((await delivery(batchId)).counts).toEqual({ pending: 0, sent: 2, failed: 0, skipped: 1 });
  });

  it('Retry sends to a guardian address added since, and drops a failed one no longer on file', async () => {
    send().mockImplementation(async (msg) => (msg.to[0] === RANIA
      ? { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } }
      : { data: { id: 'email-ok' }, error: null }));
    const { batchId } = await publish([quizId]);
    await makeDue();
    await drain();
    // The office fixes Bilal's address and adds Dalia's guardian.
    await pool.query(`UPDATE parent_students SET parent_email = 'rania.k@example.com' WHERE parent_email = $1`, [RANIA]);
    await guardian(daliaId, 'Lina Nassar', 'lina.nassar@example.com');
    send().mockClear();
    send().mockResolvedValue({ data: { id: 'email-3' }, error: null });
    expect(await retry(batchId)).toMatchObject({ requeued: 0, added: 2, dropped: 1 });
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual(['lina.nassar@example.com', 'rania.k@example.com']);
    expect(sent().find((m) => m.to[0] === 'lina.nassar@example.com').html).toContain('9/10');
    const report = await delivery(batchId);
    expect(report.counts).toEqual({ pending: 0, sent: 3, failed: 0, skipped: 0 });
    expect(report.students.find((s) => s.studentId === bilalId).recipients.find((r) => r.email === RANIA))
      .toMatchObject({ status: 'skipped', reason: 'No longer a guardian address' });
  });

  it('an unclear failure retries with the same key (Resend dedupes it), and fails after three attempts', async () => {
    send().mockResolvedValue({ data: null, error: { name: 'application_error', message: 'Unable to fetch data.' } });
    const { batchId } = await publish([quizId]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await makeDue();
      await drain();
      const row = (await outboxRows(pool)).find((r) => r.recipient_email === MONA);
      expect(row).toMatchObject({ attempts: attempt, error_count: 0, status: attempt < 3 ? 'pending' : 'failed' });
    }
    const monaKeys = send().mock.calls.filter(([m]) => m.to[0] === MONA).map(([, o]) => o.idempotencyKey);
    expect(monaKeys).toHaveLength(3);
    expect(new Set(monaKeys).size).toBe(1);
    expect((await delivery(batchId)).counts.failed).toBe(2);
  });

  it('a rate limit retries with a new key; a reused key Resend already sent is recorded as sent', async () => {
    send().mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', message: 'Too many requests' } });
    await publish([quizId]);
    await makeDue();
    await drain({ limit: 1 });
    const [limited] = (await outboxRows(pool)).filter((r) => r.attempts === 1);
    expect(limited).toMatchObject({ status: 'pending', error_count: 1 });

    send().mockReset();
    send().mockResolvedValue({ data: null, error: { name: 'invalid_idempotent_request', message: 'Same key, different payload' } });
    await makeDue();
    await drain();
    const rows = (await outboxRows(pool)).filter((r) => r.recipient_email);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect((await auditRows()).length).toBe(3);
  });

  it('two workers draining at once send each email exactly once', async () => {
    send().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { data: { id: 'email-x' }, error: null };
    });
    await publish([quizId]);
    await publish([labId]);
    await makeDue();
    await Promise.all([drain(), drain(), drain()]);
    const perAddress = sent().map((m) => m.to[0]).sort();
    expect(perAddress).toEqual([MONA, OMAR, RANIA]);
  });

  it("the grading view's Publish queues the same email (no send in the request)", async () => {
    // A Classwork item on the quiz column, published to Amal from the grading view.
    const item = (await post(`/api/classroom/classes/${sciId}/items`, {
      kind: 'assignment', title: 'Cells quiz', submissionMode: 'done',
      gradebook: { mode: 'existing', assessmentId: quizId },
    }, asTeacher, 201)).data;
    await expectStatus(authenticatedRequest('patch', `/api/classroom/items/${item.itemId}/submissions/${amalId}`, asTeacher).send({ draftScore: 7 }), 200);
    const res = (await post(`/api/classroom/items/${item.itemId}/publish`, { studentIds: [amalId] })).data;
    expect(res.publishedStudentIds).toEqual([amalId]);
    expect(res.delivery).toMatchObject({ families: 1, noEmail: 0 });
    expect(send()).not.toHaveBeenCalled();
    await makeDue();
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR]);
    expect(sent()[0].html).toContain('7/10');
  });

  it('the notifier tick sends due outbox emails first', async () => {
    await publish([quizId]);
    await makeDue();
    await notifier.drainEmailOutbox();
    expect(send()).toHaveBeenCalledTimes(3);
  });

  it('only the class\'s teachers read a publish\'s delivery or retry it; another class\'s publish is not found', async () => {
    const { batchId } = await publish([quizId]);
    await get(`${base()}/batches/${batchId}/delivery`, asOtherTeacher, 403);
    await post(`${base()}/batches/${batchId}/retry`, {}, asOtherTeacher, 403);
    await get(`${base()}/batches/${batchId}/delivery`, asParent, 403);
    // The other teacher's own class does not hold this publish.
    await get(`${base(mathId)}/batches/${batchId}/delivery`, asOtherTeacher, 404);
    await get(`${base()}/batches/not-a-uuid/delivery`, asTeacher, 404);
  });
});
