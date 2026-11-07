// The report generation worker's loop, timers and browsers, against a fake
// queue standing in for the database: the flag that starts it, kick(), the
// per-report timeout, replacing and closing browsers, and standing down
// when the tables are missing.

jest.mock('../../../../utils/pdfGenerator', () => ({ launchPDFBrowser: jest.fn() }));
jest.mock('../../../../services/reportEngine/generate', () => ({ reportEngineSession: jest.fn() }));

const db = require('../../../__mocks__/config/database');
const logger = require('../../../../logger');
const { launchPDFBrowser } = require('../../../../utils/pdfGenerator');
const { reportEngineSession } = require('../../../../services/reportEngine/generate');
const worker = require('../../../../services/reportGeneration/worker');

const original = db.query.getMockImplementation();

// Pending items; the worker's claim takes the first unclaimed one.
let queue;
function fakeDb(sql, params) {
  if (/SKIP LOCKED/.test(sql)) {
    const item = queue.find((i) => i.status === 'pending' && !i.claimed);
    if (!item) return { rows: [], rowCount: 0 };
    item.attempts += 1;
    item.claimed = true;
    return {
      rows: [{ run_id: 'run-1', student_id: item.studentId, attempts: item.attempts, report_type: 'report_card', term: 'Term 1', report_date: null, school: 'ALHAADIACADEMY' }],
      rowCount: 1,
    };
  }
  const item = queue.find((i) => i.studentId === params?.[1]);
  if (/SET status = 'generated'/.test(sql)) Object.assign(item, { status: 'generated', claimed: false });
  else if (/SET status = 'failed'/.test(sql)) Object.assign(item, { status: 'failed', error: params[2], claimed: false });
  else if (/SET claimed_until = NULL/.test(sql)) Object.assign(item, { claimed: false, released: true });
  return { rows: [], rowCount: 0 };
}
const pending = (...studentIds) => studentIds.map((studentId) => ({ studentId, status: 'pending', attempts: 0, claimed: false }));

describe('report generation worker', () => {
  let browsers, engines;

  beforeEach(() => {
    queue = [];
    db.query.mockImplementation(fakeDb);
    browsers = [];
    engines = [];
    launchPDFBrowser.mockImplementation(async () => {
      const browser = { close: jest.fn().mockResolvedValue() };
      browsers.push(browser);
      return browser;
    });
    reportEngineSession.mockImplementation(() => {
      const engine = { browser: jest.fn(), close: jest.fn().mockResolvedValue() };
      engines.push(engine);
      return engine;
    });
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    worker.stopWorker();
    worker.resetWorkerState();
    delete process.env.REPORT_GENERATION_WORKER;
    db.query.mockImplementation(original);
  });

  // A print that uses the session's browsers, as the real one does.
  const usesBrowsers = () => jest.fn(async (job, session) => { await session.tools(); });

  it('does not start without REPORT_GENERATION_WORKER=true', async () => {
    queue = pending('s1');
    const print = usesBrowsers();
    process.env.REPORT_GENERATION_WORKER = 'false';
    worker.startWorker(10, { print });

    expect(worker.isRunning()).toBe(false);
    await worker.kick();
    await new Promise((r) => setTimeout(r, 30));
    expect(print).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('starts printing at once on kick()', async () => {
    process.env.REPORT_GENERATION_WORKER = 'true';
    const print = usesBrowsers();
    worker.startWorker(60 * 60 * 1000, { print });
    expect(worker.isRunning()).toBe(true);

    queue = pending('s1', 's2');
    await worker.kick();
    expect(print.mock.calls.map(([job]) => job.studentId)).toEqual(['s1', 's2']);
    expect(queue.map((i) => i.status)).toEqual(['generated', 'generated']);
  });

  it('a kick while a drain is running is picked up by that drain', async () => {
    process.env.REPORT_GENERATION_WORKER = 'true';
    let release;
    const gate = new Promise((r) => { release = r; });
    const print = jest.fn(async (job) => { if (job.studentId === 's1') await gate; });
    worker.startWorker(60 * 60 * 1000, { print });

    queue = pending('s1');
    const first = worker.kick();
    await new Promise((r) => setTimeout(r, 5));
    queue.push(...pending('s2'));
    const second = worker.kick();
    release();
    await Promise.all([first, second]);
    expect(print.mock.calls.map(([job]) => job.studentId)).toEqual(['s1', 's2']);
  });

  it('a hung report times out, closes the browsers and releases the item', async () => {
    queue = pending('s1');
    const print = jest.fn(async (job, session) => { await session.tools(); return new Promise(() => {}); });

    await expect(worker.drainOnce(worker.createSession(), { print, timeoutMs: 10 })).resolves.toBe(1);
    expect(queue[0]).toMatchObject({ status: 'pending', attempts: 1, released: true, claimed: false });
    expect(browsers[0].close).toHaveBeenCalledTimes(1);
    expect(engines[0].close).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('replaces the browsers after recycleAfter reports', async () => {
    queue = pending('s1', 's2', 's3');
    await worker.drainAll({ print: usesBrowsers(), recycleAfter: 2 });

    expect(launchPDFBrowser).toHaveBeenCalledTimes(2);
    expect(reportEngineSession).toHaveBeenCalledTimes(2);
    expect(browsers.every((b) => b.close.mock.calls.length === 1)).toBe(true);
  });

  it('closes the browsers when the queue is empty', async () => {
    queue = pending('s1');
    const session = worker.createSession();
    const print = usesBrowsers();

    await expect(worker.drainOnce(session, { print })).resolves.toBe(1);
    expect(browsers[0].close).not.toHaveBeenCalled();
    await expect(worker.drainOnce(session, { print })).resolves.toBe(0);
    expect(browsers[0].close).toHaveBeenCalledTimes(1);
    expect(engines[0].close).toHaveBeenCalledTimes(1);
  });

  it('launches no browser when there is nothing to print', async () => {
    await expect(worker.drainAll({ print: usesBrowsers() })).resolves.toBe(0);
    expect(launchPDFBrowser).not.toHaveBeenCalled();
    expect(reportEngineSession).not.toHaveBeenCalled();
  });

  it('prints without a shared browser when it fails to launch, as the bulk route does', async () => {
    queue = pending('s1');
    launchPDFBrowser.mockRejectedValueOnce(new Error('Chromium missing'));
    const seen = [];
    const print = jest.fn(async (job, session) => { seen.push(await session.tools()); });

    await worker.drainAll({ print });
    expect(seen[0].browser).toBeNull();
    expect(seen[0].engine).toBe(engines[0]);
    expect(queue[0].status).toBe('generated');
  });

  it('stands down once if the tables are missing', async () => {
    process.env.REPORT_GENERATION_WORKER = 'true';
    const print = usesBrowsers();
    worker.startWorker(60 * 60 * 1000, { print });
    db.query.mockImplementation(async () => {
      throw Object.assign(new Error('relation "report_generation_items" does not exist'), { code: '42P01' });
    });

    await worker.kick();
    expect(worker.isRunning()).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await worker.kick();
    await expect(worker.drainAll({ print })).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(print).not.toHaveBeenCalled();
  });
});
