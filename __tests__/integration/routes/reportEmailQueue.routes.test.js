// Report card and progress report emails through the email outbox: a send
// queues a run and one row per parent address in one transaction, answers at
// once, and the notifier sends each email with its PDF attached. Covers the
// progress endpoints, the CC on each student's first email, the emailed log,
// double sends, failures and Retry, the one-student send to typed addresses,
// the worker starting at once, and who may read a send. Synthetic
// identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');
const outbox = require('../../../services/email/outbox');
const notifier = require('../../../services/messageNotifier');
const reportEmails = require('../../../services/reportEmails');
const { getResend } = require('../../../utils/emailUtils');
const { deliverQueuedEmails, outboxRows } = require('../../helpers/emailOutbox');

const ADMIN = { userId: '550e8400-e29b-41d4-a716-446655440201', username: 'Office Admin', email: 'office.admin@example.com', role: 'ADMIN' };
const PARENT = { userId: '550e8400-e29b-41d4-a716-446655440202', username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const TERM = 'Term 1';

const MONA = 'mona.haddad@example.com';
const OMAR = 'omar.haddad@example.com';
const RANIA = 'rania.karim@example.com';
const OFFICE = 'office.copy@example.com';

describe('Integration: report emails through the outbox', () => {
  let pool, yearId, amalId, bilalId, daliaId, samiId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const send = () => getResend().emails.send;
  const sent = () => send().mock.calls.map(([msg]) => msg);
  const keys = () => send().mock.calls.map(([, options]) => options?.idempotencyKey);
  const download = () => supabase._mockStorage.download;

  const expectStatus = async (req, status) => {
    const res = await req;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const post = (url, body, who = ADMIN, status = 202) => expectStatus(authenticatedRequest('post', url, who).send(body), status);
  const get = (url, who = ADMIN, status = 200) => expectStatus(authenticatedRequest('get', url, who), status);
  const bulk = (studentIds, extra = {}) => post('/api/report-emails/send/bulk', {
    reportType: 'report_card', studentIds, term: TERM,
    bulkConfig: {
      customHeader: 'Report Cards - Term 1',
      customMessage: "Dear Parent/Guardian,\n\nPlease find attached the report card for [Student Name] for [Term].",
      ccAddresses: [OFFICE],
    },
    ...extra,
  });
  const run = async (runId) => (await get(`/api/report-emails/runs/${runId}`)).data;
  const drain = () => deliverQueuedEmails(pool);

  const makeStudent = async (name, mother, father) => (await pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, mother_email, father_email)
     VALUES ($1, '5', 'ALHAADIACADEMY', $2, $3, $4) RETURNING student_id`,
    [name, yearId, mother, father],
  )).rows[0].student_id;
  const reportCard = (studentId, name, table = 'report_cards') => pool.query(
    `INSERT INTO ${table} (student_id, term, student_name, file_path, school) VALUES ($1, $2, $3, $4, 'ALHAADIACADEMY')`,
    [studentId, TERM, name, `ALHAADIACADEMY/${TERM}/${studentId}.pdf`],
  );

  beforeEach(async () => {
    supabase._reset();
    download().mockImplementation(async () => ({ data: new Blob(['%PDF-1.4 synthetic report']), error: null }));
    send().mockReset();
    send().mockResolvedValue({ data: { id: 'email-1' }, error: null });
    outbox.resetOutboxState();
    reportEmails.clearPdfCache();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;

    amalId = await makeStudent('Amal Haddad', MONA, OMAR);
    bilalId = await makeStudent('Bilal Karim', RANIA, null);
    daliaId = await makeStudent('Dalia Nassar', null, null); // no parent email
    samiId = await makeStudent('Sami Yusuf', 'sami.parent@example.com', null); // no report card yet
    await reportCard(amalId, 'Amal Haddad');
    await reportCard(bilalId, 'Bilal Karim');
    await reportCard(daliaId, 'Dalia Nassar');
  });

  it('a bulk send queues and answers at once; each parent gets the PDF, the CC rides on the first email', async () => {
    const res = await bulk([amalId, bilalId, daliaId, samiId]);
    expect(res).toMatchObject({ status: 'queued', reportType: 'report_card', term: TERM, summary: { total: 4, queued: 2, skipped: 2 } });
    expect(send()).not.toHaveBeenCalled();

    const before = await run(res.runId);
    expect(before).toMatchObject({ runId: res.runId, reportType: 'report_card', term: TERM, studentCount: 4, recipients: 'guardians' });
    expect(before.counts).toEqual({ pending: 2, sent: 0, failed: 0, skipped: 2 });
    expect(before.students.find((s) => s.studentId === daliaId)).toMatchObject({ status: 'skipped', reason: 'No parent email on file' });
    expect(before.students.find((s) => s.studentId === samiId)).toMatchObject({ status: 'skipped', reason: 'No report card for Term 1' });

    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR, RANIA]);
    for (const m of sent()) {
      expect(m.subject).toBe('Report Cards - Term 1');
      expect(m.attachments).toHaveLength(1);
      expect(m.attachments[0].filename).toMatch(/_Term 1_report_card\.pdf$/);
      expect(Buffer.isBuffer(m.attachments[0].content)).toBe(true);
    }
    const toMona = sent().find((m) => m.to[0] === MONA);
    expect(toMona.html).toContain('Amal Haddad');
    expect(toMona.html).not.toContain('[Student Name]');
    // The CC once per student: on its first address only.
    const amalEmails = sent().filter((m) => [MONA, OMAR].includes(m.to[0]));
    expect(amalEmails.filter((m) => m.cc).map((m) => m.cc)).toEqual([[OFFICE]]);
    expect(sent().find((m) => m.to[0] === RANIA).cc).toEqual([OFFICE]);
    // Each PDF is read once, whatever the number of parents.
    expect(download()).toHaveBeenCalledTimes(2);
    expect(keys().every((k) => /^report_email:[0-9a-f-]{36}:0$/.test(k))).toBe(true);

    const after = await run(res.runId);
    expect(after.counts).toEqual({ pending: 0, sent: 2, failed: 0, skipped: 2 });
    expect(after.students.find((s) => s.studentId === amalId).recipients.map((r) => r.email).sort()).toEqual([MONA, OMAR]);

    // The emailed log: one row per student for this send, both addresses; the report marked emailed.
    const log = (await pool.query(
      `SELECT student_id, email_addresses, cc_addresses, custom_message, run_id FROM report_emails ORDER BY student_id`,
    )).rows;
    expect(log).toHaveLength(2);
    const amalLog = log.find((r) => r.student_id === amalId);
    expect(amalLog.email_addresses.sort()).toEqual([MONA, OMAR]);
    expect(amalLog.run_id).toBe(res.runId);
    expect(amalLog.custom_message).toContain('[Student Name]'); // the raw body, as before
    const emailed = (await pool.query(`SELECT student_id FROM report_cards WHERE email_sent ORDER BY student_id`)).rows;
    expect(emailed.map((r) => r.student_id).sort()).toEqual([amalId, bilalId].sort());

    // The student's emailed history reads it.
    const history = (await get(`/api/report-emails/history/student/${amalId}`)).data;
    expect(history).toHaveLength(1);
    expect(history[0].emailAddresses.sort()).toEqual([MONA, OMAR]);
  });

  it('the latest sends list with their counts, newest first', async () => {
    const first = await bulk([amalId]);
    await drain();
    const second = await bulk([bilalId]);
    const runs = (await get(`/api/report-emails/runs?reportType=report_card&term=${encodeURIComponent(TERM)}`)).data;
    expect(runs.map((r) => r.runId)).toEqual([second.runId, first.runId]);
    expect(runs[0].counts).toMatchObject({ pending: 1 });
    expect(runs[1].counts).toMatchObject({ sent: 1, pending: 0 });
    expect((await get('/api/report-emails/runs?reportType=progress_report')).data).toEqual([]);
  });

  it('a second send while the first is still going never doubles an email', async () => {
    const first = await bulk([amalId, bilalId]);
    const second = await bulk([amalId, bilalId]);
    expect(second.summary).toMatchObject({ queued: 0, skipped: 2 });
    expect((await run(second.runId)).students.every((s) => s.status === 'skipped' && s.reason === 'Already being sent')).toBe(true);
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR, RANIA]);
    expect((await run(first.runId)).counts.sent).toBe(2);
    // Once sent, sending again is a new send (a corrected report card).
    send().mockClear();
    await bulk([bilalId]);
    await drain();
    expect(sent().map((m) => m.to[0])).toEqual([RANIA]);
  });

  it('two sends at the same moment (a double click, two tabs) still send each email once', async () => {
    const [a, b] = await Promise.all([bulk([amalId, bilalId]), bulk([amalId, bilalId])]);
    expect([a.summary.queued, b.summary.queued].sort()).toEqual([0, 2]);
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR, RANIA]);
  });

  it("a report regenerated since the last send goes out new, never the old PDF", async () => {
    download().mockImplementation(async () => ({ data: new Blob(['%PDF-1.4 first version']), error: null }));
    await bulk([bilalId]);
    await drain();
    expect(sent()[0].attachments[0].content.toString()).toContain('first version');

    // Regenerated: same path, new generated_at, new bytes.
    await pool.query(`UPDATE report_cards SET generated_at = NOW() + interval '1 second' WHERE student_id = $1`, [bilalId]);
    download().mockImplementation(async () => ({ data: new Blob(['%PDF-1.4 corrected version']), error: null }));
    send().mockClear();
    await bulk([bilalId]);
    await drain();
    expect(sent()[0].attachments[0].content.toString()).toContain('corrected version');
  });

  it("the CC rides on the student's first email that goes, when an earlier address is already being sent", async () => {
    await post('/api/report-emails/send', { reportType: 'report_card', studentId: amalId, term: TERM, emailAddresses: [MONA] });
    const { runId } = await bulk([amalId]);
    const amal = (await run(runId)).students[0];
    expect(amal.recipients.find((r) => r.email === MONA)).toMatchObject({ status: 'skipped', reason: 'Already being sent' });
    await drain();
    const fromBulk = sent().filter((m) => m.to[0] === OMAR);
    expect(fromBulk).toHaveLength(1);
    expect(fromBulk[0].cc).toEqual([OFFICE]);
  });

  it('a refused address fails and the rest still go; Retry sends it again with a new key', async () => {
    send().mockImplementation(async (msg) => (msg.to[0] === OMAR
      ? { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } }
      : { data: { id: 'email-ok' }, error: null }));
    const { runId } = await bulk([amalId, bilalId]);
    await drain();
    const failedReport = await run(runId);
    expect(failedReport.counts).toEqual({ pending: 0, sent: 1, failed: 1, skipped: 0 });
    expect(failedReport.students.find((s) => s.studentId === amalId).recipients.find((r) => r.email === OMAR))
      .toMatchObject({ status: 'failed', error: 'Invalid `to` field.' });
    const firstKey = keys()[send().mock.calls.findIndex(([m]) => m.to[0] === OMAR)];

    send().mockClear();
    send().mockResolvedValue({ data: { id: 'email-2' }, error: null });
    const retried = (await post(`/api/report-emails/runs/${runId}/retry`, {}, ADMIN, 200)).data;
    expect(retried).toMatchObject({ requeued: 1, added: 0, dropped: 0, counts: { pending: 1 } });
    await drain();
    expect(sent().map((m) => m.to)).toEqual([[OMAR]]);
    expect(keys()[0]).not.toBe(firstKey);
    expect((await run(runId)).counts).toEqual({ pending: 0, sent: 2, failed: 0, skipped: 0 });
    // Still one log row for Amal, now with both parents.
    const log = (await pool.query(`SELECT email_addresses FROM report_emails WHERE student_id = $1`, [amalId])).rows;
    expect(log).toHaveLength(1);
    expect(log[0].email_addresses.sort()).toEqual([MONA, OMAR]);
  });

  it('Retry sends to a parent address added since and drops a failed one taken off the student', async () => {
    send().mockImplementation(async (msg) => (msg.to[0] === RANIA
      ? { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.' } }
      : { data: { id: 'email-ok' }, error: null }));
    const { runId } = await bulk([amalId, bilalId, daliaId]);
    await drain();
    await pool.query(`UPDATE students SET mother_email = 'rania.k@example.com' WHERE student_id = $1`, [bilalId]);
    await pool.query(`UPDATE students SET father_email = 'lina.nassar@example.com' WHERE student_id = $1`, [daliaId]);
    send().mockClear();
    send().mockResolvedValue({ data: { id: 'email-3' }, error: null });
    expect((await post(`/api/report-emails/runs/${runId}/retry`, {}, ADMIN, 200)).data).toMatchObject({ requeued: 0, added: 2, dropped: 1 });
    await drain();
    expect(sent().map((m) => m.to[0]).sort()).toEqual(['lina.nassar@example.com', 'rania.k@example.com']);
    expect((await run(runId)).counts).toEqual({ pending: 0, sent: 3, failed: 0, skipped: 0 });
  });

  it('a PDF that cannot be read is retried, and fails after three attempts with why', async () => {
    download().mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    const { runId } = await bulk([bilalId]);
    for (let i = 0; i < 3; i += 1) await drain();
    expect(send()).not.toHaveBeenCalled();
    const report = await run(runId);
    expect(report.counts.failed).toBe(1);
    expect(report.students[0].recipients[0].error).toBe('Could not read the report card file');
  });

  it('an address taken off the student before its email goes is skipped', async () => {
    const { runId } = await bulk([amalId]);
    await pool.query(`UPDATE students SET father_email = NULL WHERE student_id = $1`, [amalId]);
    await drain();
    expect(sent().map((m) => m.to[0])).toEqual([MONA]);
    const amal = (await run(runId)).students[0];
    expect(amal.recipients.find((r) => r.email === OMAR)).toMatchObject({ status: 'skipped', reason: 'No longer a parent address' });
  });

  it('a one-student send goes to the addresses typed, CC on the first', async () => {
    const res = await post('/api/report-emails/send', {
      reportType: 'report_card', studentId: bilalId, term: TERM,
      emailAddresses: ['grandma.karim@example.com', RANIA], ccAddresses: [OFFICE],
      customMessage: 'For [Student Name].',
    });
    expect(res).toMatchObject({ status: 'queued', summary: { total: 1, queued: 1 } });
    expect(send()).not.toHaveBeenCalled();
    await drain();
    expect(sent().map((m) => [m.to[0], m.cc ?? null])).toEqual([['grandma.karim@example.com', [OFFICE]], [RANIA, null]]);
    expect(sent()[0].subject).toBe('Bilal Karim — Report Card (Term 1)');
    expect(sent()[0].html).toContain('For Bilal Karim.');
    expect((await run(res.runId)).recipients).toBe('chosen');
    // A missing report is still refused before anything is queued.
    await post('/api/report-emails/send', {
      reportType: 'report_card', studentId: samiId, term: TERM, emailAddresses: ['sami.parent@example.com'],
    }, ADMIN, 404);
  });

  it('progress reports go the same way, from their own bucket and template', async () => {
    await reportCard(amalId, 'Amal Haddad', 'progress_reports');
    const { runId } = await post('/api/report-emails/send/bulk', { reportType: 'progress_report', studentIds: [amalId], term: TERM });
    await drain();
    expect(supabase.storage.from).toHaveBeenCalledWith('progress-reports');
    expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR]);
    expect(sent()[0].subject).toBe('Amal Haddad — Progress Report (Term 1)');
    expect(sent()[0].attachments[0].filename).toMatch(/_progress_report\.pdf$/);
    expect((await pool.query(`SELECT email_sent FROM progress_reports WHERE student_id = $1`, [amalId])).rows[0].email_sent).toBe(true);
    expect((await run(runId)).counts.sent).toBe(1);
  });

  it('a send starts the running worker at once, without waiting for its next tick', async () => {
    notifier.startWorker(60 * 60 * 1000);
    try {
      await bulk([amalId, bilalId]);
      for (let i = 0; i < 50 && send().mock.calls.length < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(sent().map((m) => m.to[0]).sort()).toEqual([MONA, OMAR, RANIA]);
    } finally {
      notifier.stopWorker();
      // Let a pass still running finish before the next test truncates.
      for (let i = 0; i < 50 && (await outboxRows(pool)).some((r) => r.status === 'pending'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  it("only staff with report card access read or retry a send, and only their own school's", async () => {
    const { runId } = await bulk([amalId]);
    await get(`/api/report-emails/runs/${runId}`, PARENT, 403);
    await post(`/api/report-emails/runs/${runId}/retry`, {}, PARENT, 403);
    await get('/api/report-emails/runs', PARENT, 403);
    await get(`/api/report-emails/runs/${runId}`, { ...ADMIN, userId: '550e8400-e29b-41d4-a716-446655440203', email: 'other.admin@example.com', school: 'PLAYGROUND' }, 404);
    await get('/api/report-emails/runs/not-a-uuid', ADMIN, 404);
  });
});
