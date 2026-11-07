// The report generation worker on the real test database: it claims one
// queued student at a time, prints it, and records the result. Printing is
// replaced (an injected print, or mocked generators), so nothing launches
// Chromium. Covers the turn order between runs, leases lost to a restart,
// failures, Stop, and the run finishing exactly once. Synthetic identities
// only.

jest.mock('../../../controllers/reportCard.controller', () => ({
  ...jest.requireActual('../../../controllers/reportCard.controller'),
  generateSingleReportCard: jest.fn(),
}));
jest.mock('../../../controllers/progressReports.controller', () => ({
  ...jest.requireActual('../../../controllers/progressReports.controller'),
  generateSingleProgressReport: jest.fn(),
}));
jest.mock('../../../utils/pdfGenerator', () => ({
  ...jest.requireActual('../../../utils/pdfGenerator'),
  launchPDFBrowser: jest.fn(),
}));

const { getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const runs = require('../../../services/reportGeneration/runs');
const worker = require('../../../services/reportGeneration/worker');
const { generateSingleReportCard } = require('../../../controllers/reportCard.controller');
const { generateSingleProgressReport } = require('../../../controllers/progressReports.controller');
const { launchPDFBrowser } = require('../../../utils/pdfGenerator');
const { ReportSkip } = require('../../../services/reportEngine/data/errors');

const TERM = 'Term 1';
const GAVE_UP = "Couldn't finish this report. Try again.";

describe('Integration: report generation worker', () => {
  let pool, yearId, browser;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  beforeEach(async () => {
    browser = { close: jest.fn().mockResolvedValue() };
    launchPDFBrowser.mockResolvedValue(browser);
    generateSingleReportCard.mockResolvedValue('Report card generated and uploaded');
    generateSingleProgressReport.mockResolvedValue({ studentId: 'x' });
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
  });

  const makeStudent = async (name) => (await pool.query(
    `INSERT INTO students (name, grade, school, school_year_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2) RETURNING student_id`,
    [name, yearId],
  )).rows[0].student_id;
  const students = async (n) => {
    const ids = [];
    for (let i = 0; i < n; i += 1) ids.push(await makeStudent(`Student ${i + 1}`));
    return ids;
  };
  const queue = async (studentIds, extra = {}) => (await runs.queueRun({
    school: 'ALHAADIACADEMY', schoolYearId: yearId, reportType: 'report_card', term: TERM, studentIds, ...extra,
  })).run.runId;
  const items = async (runId) => (await pool.query(
    `SELECT student_id, status, attempts, error, claimed_until, finished_at
     FROM report_generation_items WHERE run_id = $1 ORDER BY position`,
    [runId],
  )).rows;
  const runRow = async (runId) => (await pool.query('SELECT * FROM report_generation_runs WHERE run_id = $1', [runId])).rows[0];
  const recorder = () => {
    const printed = [];
    const print = jest.fn(async (job) => { printed.push(job.studentId); });
    return { printed, print };
  };

  it('prints every pending item, marks it generated and finishes the run', async () => {
    const [a, b] = await students(2);
    const runId = await queue([a, b]);
    const { printed, print } = recorder();

    await expect(worker.drainAll({ print })).resolves.toBe(2);
    expect(printed).toEqual([a, b]);
    const after = await items(runId);
    expect(after.map((i) => [i.status, i.attempts, i.claimed_until])).toEqual([['generated', 1, null], ['generated', 1, null]]);
    expect(after.every((i) => i.finished_at)).toBe(true);
    const run = await runRow(runId);
    expect(run.finished_at).not.toBeNull();
    expect(run.last_served_at).not.toBeNull();
  });

  it('passes term and report date to the right generator for each report type', async () => {
    const [a, b] = await students(2);
    await queue([a]);
    await queue([b], { reportType: 'progress_report', reportDate: '2026-11-20' });

    await expect(worker.drainAll()).resolves.toBe(2);
    expect(generateSingleReportCard).toHaveBeenCalledWith(a, TERM, expect.objectContaining({ browser }));
    expect(generateSingleReportCard.mock.calls[0][2].engine).toEqual(expect.objectContaining({ browser: expect.any(Function) }));
    expect(generateSingleProgressReport).toHaveBeenCalledWith(b, TERM, expect.objectContaining({ browser, reportDate: '2026-11-20' }));
    // One browser for both, closed when the queue ran dry.
    expect(launchPDFBrowser).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('a thrown error fails that item with its message and the next one still prints', async () => {
    const [a, b, c] = await students(3);
    const runId = await queue([a, b, c]);
    const print = jest.fn(async (job) => {
      if (job.studentId === a) throw new ReportSkip('Fill in "Principal" before printing');
      if (job.studentId === b) throw new Error('No classes found for this student');
    });

    await worker.drainAll({ print });
    expect((await items(runId)).map((i) => [i.status, i.error])).toEqual([
      ['failed', 'Fill in "Principal" before printing'],
      ['failed', 'No classes found for this student'],
      ['generated', null],
    ]);
    expect((await runRow(runId)).finished_at).not.toBeNull();
  });

  it('a student deleted after queueing fails with Student not found and the rest print', async () => {
    const [a, b] = await students(2);
    const runId = await queue([a, b]);
    await pool.query('UPDATE students_all SET deleted_at = NOW() WHERE student_id = $1', [a]);
    const actual = jest.requireActual('../../../controllers/reportCard.controller');
    const print = jest.fn(async (job) => (job.studentId === a ? actual.generateSingleReportCard(job.studentId, job.term) : 'printed'));

    await worker.drainAll({ print });
    expect((await items(runId)).map((i) => [i.status, i.error])).toEqual([['failed', 'Student not found'], ['generated', null]]);
  });

  it('serves the least recently served run first', async () => {
    const [a1, a2, a3, b1] = await students(4);
    await queue([a1, a2, a3]);
    await queue([b1]);
    const { printed, print } = recorder();

    await worker.drainAll({ print });
    expect(printed).toEqual([a1, b1, a2, a3]);
  });

  it('never gives two drains the same item', async () => {
    const [a, b] = await students(2);
    await queue([a, b]);
    const printed = [];
    const print = async (job) => { printed.push(job.studentId); await new Promise((r) => setTimeout(r, 50)); };

    const counts = await Promise.all([
      worker.drainOnce(worker.createSession(), { print }),
      worker.drainOnce(worker.createSession(), { print }),
    ]);
    expect(counts).toEqual([1, 1]);
    expect(printed.sort()).toEqual([a, b].sort());
  });

  it('leaves an item alone while its lease is live', async () => {
    const [a] = await students(1);
    const runId = await queue([a]);
    await pool.query(`UPDATE report_generation_items SET claimed_until = NOW() + interval '1 minute', attempts = 1`);
    const { print } = recorder();

    await expect(worker.drainAll({ print })).resolves.toBe(0);
    expect(print).not.toHaveBeenCalled();
    expect((await items(runId))[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('reclaims an item whose lease ran out', async () => {
    const [a] = await students(1);
    const runId = await queue([a]);
    // A server claimed it and died mid-print.
    await pool.query(`UPDATE report_generation_items SET claimed_until = NOW() - interval '1 second', attempts = 1`);
    const { printed, print } = recorder();

    await worker.drainAll({ print });
    expect(printed).toEqual([a]);
    const rows = await items(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'generated', attempts: 2 });
  });

  it('fails an item after its third lost lease', async () => {
    const [a] = await students(1);
    const runId = await queue([a]);
    await pool.query(`UPDATE report_generation_items SET claimed_until = NOW() - interval '1 second', attempts = 3`);
    const { print } = recorder();

    await worker.drainAll({ print });
    expect(print).not.toHaveBeenCalled();
    expect((await items(runId))[0]).toMatchObject({ status: 'failed', error: GAVE_UP });
    expect((await runRow(runId)).finished_at).not.toBeNull();
  });

  it('a cancelled item is never printed', async () => {
    const [a, b] = await students(2);
    const runId = await queue([a, b]);
    await runs.cancelRun({ runId, school: 'ALHAADIACADEMY' });
    const { print } = recorder();

    await expect(worker.drainAll({ print })).resolves.toBe(0);
    expect(print).not.toHaveBeenCalled();
  });

  it('finishes a run left open with nothing waiting (a crash between its last report and its finish)', async () => {
    const [a, b] = await students(2);
    const runId = await queue([a, b]);
    await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW()`);
    const { print } = recorder();

    await expect(worker.drainAll({ print })).resolves.toBe(0);
    expect(print).not.toHaveBeenCalled();
    expect((await runRow(runId)).finished_at).not.toBeNull();
  });

  it('sets finished_at once when two finishes race', async () => {
    const [a] = await students(1);
    const runId = await queue([a]);
    await pool.query(`UPDATE report_generation_items SET status = 'generated', finished_at = NOW()`);

    const results = await Promise.all([runs.finishIfDone(runId), runs.finishIfDone(runId)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ run_id: runId, report_type: 'report_card', term: TERM, student_count: 1 });
  });
});
