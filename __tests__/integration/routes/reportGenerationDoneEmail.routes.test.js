// When a big batch finishes, the person who started it hears about it: one
// email (and the same news as a push on the app) with the counts and a link
// to the page. Small batches, stopped batches and a second finish after
// Try again send nothing. Printing is injected. Synthetic identities only.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' }, error: null }) } })),
}));

const { getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const outbox = require('../../../services/email/outbox');
const pushEvents = require('../../../services/push/pushEvents');
const runs = require('../../../services/reportGeneration/runs');
const worker = require('../../../services/reportGeneration/worker');
const { getResend } = require('../../../utils/emailUtils');
const { deliverQueuedEmails, outboxRows } = require('../../helpers/emailOutbox');

const ADMIN = { userId: '550e8400-e29b-41d4-a716-446655440401', email: 'office.admin@example.com' };
const TERM = 'Term 1';

describe('Integration: report generation finish email', () => {
  let pool, yearId, fromEmail;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const send = () => getResend().emails.send;
  const sent = () => send().mock.calls.map(([msg]) => msg);
  const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

  beforeEach(async () => {
    send().mockReset();
    send().mockResolvedValue({ data: { id: 'email-1' }, error: null });
    outbox.resetOutboxState();
    fromEmail = jest.spyOn(pushEvents, 'fromEmail').mockResolvedValue(1);
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, 'Office Admin', '!', 'Office', 'Admin', 'ALHAADIACADEMY', 'ADMIN', true, true)`,
      [ADMIN.userId, ADMIN.email],
    );
  });

  afterEach(() => { fromEmail.mockRestore(); });

  const students = async (n) => {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      ids.push((await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2) RETURNING student_id`,
        [`Pupil Number${i + 1}`, yearId],
      )).rows[0].student_id);
    }
    return ids;
  };
  const queue = async (studentIds, extra = {}) => (await runs.queueRun({
    school: 'ALHAADIACADEMY', schoolYearId: yearId, userId: ADMIN.userId, reportType: 'report_card', term: TERM, studentIds, ...extra,
  })).run.runId;
  const printAll = (failIds = []) => worker.drainAll({
    print: async (job) => { if (failIds.includes(job.studentId)) throw new Error('No classes found for this student'); },
  });
  const doneRows = async () => (await outboxRows(pool)).filter((r) => r.kind === 'report_generation_done');

  it('a finished batch of 10 emails the person who started it once', async () => {
    const runId = await queue(await students(10));
    await printAll();

    const rows = await doneRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recipient_email: ADMIN.email, subject_id: runId, status: 'pending' });

    await deliverQueuedEmails(pool);
    expect(sent()).toHaveLength(1);
    const [email] = sent();
    expect(email.to).toEqual([ADMIN.email]);
    expect(email.subject).toBe('10 report cards are ready');
    expect(text(email.html)).toContain('10 report cards for Term 1 are ready');
    expect(email.html).not.toContain('Pupil Number');
    expect((await doneRows())[0].status).toBe('sent');
  });

  it('says how many were skipped', async () => {
    const ids = await students(10);
    await queue(ids);
    await printAll(ids.slice(0, 2));
    await deliverQueuedEmails(pool);

    const [email] = sent();
    expect(email.subject).toBe('8 report cards are ready');
    expect(text(email.html)).toContain('2 students were skipped');
    expect(email.html).not.toContain('Pupil Number');
  });

  it('a batch of 9 sends nothing', async () => {
    await queue(await students(9));
    await printAll();
    expect(await doneRows()).toEqual([]);
  });

  it('a stopped batch sends nothing', async () => {
    const ids = await students(10);
    const runId = await queue(ids);
    // One prints, then Stop.
    await worker.drainOnce(worker.createSession(), { print: async () => {} });
    await runs.cancelRun({ runId, school: 'ALHAADIACADEMY' });
    await printAll();

    expect((await pool.query('SELECT finished_at FROM report_generation_runs WHERE run_id = $1', [runId])).rows[0].finished_at).not.toBeNull();
    expect(await doneRows()).toEqual([]);
  });

  it('a retry that finishes again sends no second email', async () => {
    const ids = await students(10);
    const runId = await queue(ids);
    await printAll([ids[0]]);
    await deliverQueuedEmails(pool);

    await runs.retryRun({ runId, school: 'ALHAADIACADEMY' });
    await printAll();
    await deliverQueuedEmails(pool);
    expect(await doneRows()).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it('a run left open by a crash still emails once the worker sweeps it', async () => {
    const runId = await queue(await students(10));
    await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW() WHERE run_id = $1`, [runId]);
    await printAll();
    expect((await doneRows()).map((r) => r.subject_id)).toEqual([runId]);
  });

  it('skips the email when the starter has no address any more', async () => {
    await queue(await students(10));
    await pool.query('DELETE FROM users WHERE user_id = $1', [ADMIN.userId]);
    await printAll();
    expect(await doneRows()).toEqual([]);
  });

  it('links to the right page for each report type', async () => {
    const ids = await students(20);
    await queue(ids.slice(0, 10));
    await queue(ids.slice(10), { reportType: 'progress_report', reportDate: '2026-11-20' });
    await printAll();
    await deliverQueuedEmails(pool);

    const bySubject = Object.fromEntries(sent().map((m) => [m.subject, m.html]));
    expect(bySubject['10 report cards are ready']).toContain('/report-cards?term=Term%201');
    expect(bySubject['10 progress reports are ready']).toContain('/reports/progress-reports?term=Term%201');
  });

  it('pushes to the same path under the reminders category', async () => {
    await queue(await students(10));
    await printAll();
    await deliverQueuedEmails(pool);

    expect(fromEmail).toHaveBeenCalledTimes(1);
    const [job, push] = fromEmail.mock.calls[0];
    expect(job).toMatchObject({ kind: 'report_generation_done', recipient_user_id: ADMIN.userId });
    expect(push).toMatchObject({ category: 'reminders', title: '10 report cards are ready', path: '/report-cards?term=Term%201' });
    expect(push.body).toContain('Term 1');
  });
});
