jest.mock('../../../../services/finance/qboSync', () => ({ runSync: jest.fn() }));

const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const { runSync } = require('../../../../services/finance/qboSync');
const { NeedsReconnectError } = require('../../../../services/finance/errors');
const worker = require('../../../../services/finance/financeSyncWorker');

const job = (over = {}) => ({ job_id: 'j1', school: 'ALHAADIACADEMY', kind: 'cdc', state: 'running', attempts: 1, requested_by: null, ...over });
const sqlsUsed = () => db.query.mock.calls.map((c) => c[0]);

describe('financeSyncWorker.drainOnce', () => {
  afterEach(() => worker.stopWorker());

  it('does nothing when the queue is empty', async () => {
    mockQueryResponse([]);
    await expect(worker.drainOnce()).resolves.toBe(0);
    expect(runSync).not.toHaveBeenCalled();
  });

  it('runs the sync for the job\'s school and deletes the job on success', async () => {
    mockQueryResponse([job({ kind: 'manual', requested_by: 'u1' })]);
    runSync.mockResolvedValueOnce({ mode: 'cdc' });
    mockQueryResponse([{ job_id: 'j1' }]);
    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(runSync).toHaveBeenCalledWith('ALHAADIACADEMY', expect.objectContaining({ kind: 'manual', jobId: 'j1', triggeredBy: 'u1' }));
    // A crashed worker must not leave a job 'running' forever: claims carry a lease.
    expect(db.query.mock.calls[0][0]).toMatch(/claimed_at = now\(\)/);
    expect(db.query.mock.calls[0][0]).toMatch(/state = 'running' AND claimed_at </);
    expect(sqlsUsed().some((s) => /DELETE FROM finance_sync_jobs/.test(s))).toBe(true);
  });

  it('requeues with backoff when the sync fails', async () => {
    mockQueryResponse([job()]);
    runSync.mockRejectedValueOnce(new Error('QuickBooks server error (503)'));
    mockQueryResponse([job({ state: 'pending' })]);
    await expect(worker.drainOnce()).resolves.toBe(1);
    const failCall = db.query.mock.calls.find(([sql]) => /next_attempt_at = now\(\)/.test(sql));
    expect(failCall[1][1]).toMatch(/503/);
    expect(failCall[1][2]).toBe(worker.MAX_ATTEMPTS);
    expect(sqlsUsed().some((s) => /DELETE FROM finance_sync_jobs/.test(s))).toBe(false);
  });

  it('fails permanently when the grant is dead', async () => {
    mockQueryResponse([job()]);
    runSync.mockRejectedValueOnce(new NeedsReconnectError());
    mockQueryResponse([job({ state: 'failed' })]);
    await worker.drainOnce();
    expect(sqlsUsed().some((s) => /state = 'failed'/.test(s))).toBe(true);
    expect(sqlsUsed().some((s) => /next_attempt_at = now\(\)/.test(s))).toBe(false);
  });

  it('disables itself when the migration has not been applied', async () => {
    const err = new Error('relation "finance_sync_jobs" does not exist'); err.code = '42P01';
    db.query.mockRejectedValueOnce(err);
    await expect(worker.drainOnce()).resolves.toBe(0);
    expect(worker.isDisabled()).toMatch(/finance_qbo_migration/);
    worker._resetForTests();
  });
});

describe('financeSyncWorker.enqueueDueJobs', () => {
  it('inserts one job per connection that is due, choosing backfill before cdc', async () => {
    mockQueryResponse([{ job_id: 'a' }]);
    await expect(worker.enqueueDueJobs()).resolves.toBe(1);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO finance_sync_jobs/);
    expect(sql).toMatch(/CASE WHEN c.backfill_completed_at IS NULL THEN 'backfill' ELSE 'cdc' END/);
    expect(sql).toMatch(/interval '15 minutes'/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    // A school whose last job just failed permanently gets a cooldown, not an immediate retry.
    expect(sql).toMatch(/NOT EXISTS[\s\S]*state = 'failed'/);
  });
});

describe('financeSyncWorker.runDailyIfDue', () => {
  it('prunes old runs once per Toronto day', async () => {
    worker._resetForTests();
    mockQueryResponse([]);
    mockQueryResponse([]);
    await expect(worker.runDailyIfDue('2026-09-27')).resolves.toBe(true);
    expect(sqlsUsed().some((s) => /DELETE FROM finance_sync_runs/.test(s) && /90 days/.test(s))).toBe(true);
    expect(sqlsUsed().some((s) => /DELETE FROM finance_sync_jobs/.test(s) && /'failed'/.test(s))).toBe(true);
    expect(sqlsUsed().some((s) => /UPDATE finance_sync_runs[\s\S]*'failed'[\s\S]*status = 'running'/.test(s))).toBe(true);
    await expect(worker.runDailyIfDue('2026-09-27')).resolves.toBe(false);
  });
});
