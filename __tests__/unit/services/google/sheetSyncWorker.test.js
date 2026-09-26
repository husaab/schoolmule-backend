jest.mock('../../../../services/google/sheetSyncEngine', () => ({ syncForm: jest.fn() }));

const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const { syncForm } = require('../../../../services/google/sheetSyncEngine');
const { NeedsReconnectError } = require('../../../../services/google/googleAuth');
const worker = require('../../../../services/google/sheetSyncWorker');

const job = (over = {}) => ({
  job_id: 'j1', form_id: 'form-1', state: 'running', attempts: 1, ...over,
});

const sqlsUsed = () => db.query.mock.calls.map((c) => c[0]);

describe('sheetSyncWorker.drainOnce', () => {
  afterEach(() => worker.stopWorker());

  it('does nothing when the queue is empty', async () => {
    mockQueryResponse([]); // claimNextJob finds nothing
    await expect(worker.drainOnce()).resolves.toBe(0);
    expect(syncForm).not.toHaveBeenCalled();
  });

  it('syncs the form and deletes the job on success', async () => {
    mockQueryResponse([job()]);
    syncForm.mockResolvedValueOnce({ synced: true });
    mockQueryResponse([{ job_id: 'j1' }]); // completeJob

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(syncForm).toHaveBeenCalledWith('form-1');
    expect(sqlsUsed().some((s) => /DELETE FROM sheet_sync_jobs/.test(s))).toBe(true);
  });

  it('requeues with backoff when the sync fails, keeping the job', async () => {
    mockQueryResponse([job()]);
    syncForm.mockRejectedValueOnce(new Error('Google 503'));
    mockQueryResponse([job({ state: 'pending' })]); // failJob

    await expect(worker.drainOnce()).resolves.toBe(1);

    const failCall = db.query.mock.calls.find(([sql]) => /next_attempt_at = now\(\)/.test(sql));
    expect(failCall).toBeDefined();
    expect(failCall[1][1]).toMatch(/Google 503/);
    expect(failCall[1][2]).toBe(worker.MAX_ATTEMPTS);
    // The job must survive so the write is not lost.
    expect(sqlsUsed().some((s) => /DELETE FROM sheet_sync_jobs/.test(s))).toBe(false);
  });

  it('fails a job permanently when the grant is dead, rather than retrying', async () => {
    mockQueryResponse([job()]);
    syncForm.mockRejectedValueOnce(new NeedsReconnectError());
    mockQueryResponse([job({ state: 'failed' })]);

    await expect(worker.drainOnce()).resolves.toBe(1);

    // No amount of backoff revives a revoked grant, so it must not be requeued.
    const permanent = db.query.mock.calls.find(([sql]) => /state = 'failed'/.test(sql));
    expect(permanent).toBeDefined();
    expect(sqlsUsed().some((s) => /next_attempt_at = now\(\)/.test(s))).toBe(false);
  });

  it('recognizes a duck-typed reconnect error from across a module boundary', async () => {
    mockQueryResponse([job()]);
    const err = new Error('reconnect'); err.needsReconnect = true;
    syncForm.mockRejectedValueOnce(err);
    mockQueryResponse([job({ state: 'failed' })]);

    await worker.drainOnce();
    expect(db.query.mock.calls.some(([sql]) => /state = 'failed'/.test(sql))).toBe(true);
  });
});

describe('sheetSyncWorker.drainAll', () => {
  it('clears a backlog in one pass', async () => {
    for (let i = 0; i < 3; i++) {
      mockQueryResponse([job({ job_id: `j${i}` })]);
      mockQueryResponse([{ job_id: `j${i}` }]);
    }
    mockQueryResponse([]); // queue now empty
    syncForm.mockResolvedValue({ synced: true });

    await expect(worker.drainAll()).resolves.toBe(3);
  });

  it('stops at the limit rather than looping forever', async () => {
    db.query.mockImplementation((sql) =>
      /UPDATE sheet_sync_jobs\s+SET state = 'running'/.test(sql)
        ? Promise.resolve({ rows: [job()] })
        : Promise.resolve({ rows: [{}] }));
    syncForm.mockResolvedValue({ synced: true });

    await expect(worker.drainAll(5)).resolves.toBe(5);
  });
});

describe('missing migration', () => {
  it('disables itself after one error instead of logging every 5 seconds', async () => {
    // Reproduces deploying the backend before applying the migration: the
    // worker cannot possibly succeed, so it must stand down rather than
    // erroring on every tick forever.
    await jest.isolateModulesAsync(async () => {
      const freshDb = require('../../../__mocks__/config/database');
      const fresh = require('../../../../services/google/sheetSyncWorker');

      const undefinedTable = Object.assign(new Error('relation "sheet_sync_jobs" does not exist'), { code: '42P01' });
      freshDb.query.mockRejectedValueOnce(undefinedTable);

      await expect(fresh.drainOnce()).resolves.toBe(0);
      expect(fresh.isDisabled()).toMatch(/migration/);

      // A second call must not hit the database again.
      const callsBefore = freshDb.query.mock.calls.length;
      await fresh.drainOnce();
      expect(freshDb.query.mock.calls.length).toBe(callsBefore);
    });
  });

  it('still surfaces other database errors rather than swallowing them', async () => {
    await jest.isolateModulesAsync(async () => {
      const freshDb = require('../../../__mocks__/config/database');
      const fresh = require('../../../../services/google/sheetSyncWorker');

      freshDb.query.mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { code: '57P01' }));
      await expect(fresh.drainOnce()).rejects.toThrow('connection terminated');
      expect(fresh.isDisabled()).toBeNull();
    });
  });
});

describe('worker lifecycle', () => {
  const savedClientId = process.env.GOOGLE_CLIENT_ID;
  beforeEach(() => { process.env.GOOGLE_CLIENT_ID = 'client-id'; });
  afterEach(() => {
    worker.stopWorker();
    if (savedClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = savedClientId;
  });

  it('does not poll at all when Google is not configured', () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const spy = jest.spyOn(global, 'setInterval');
    worker.startWorker(60000);
    // Deployments that never use the feature shouldn't pay a query every 5s.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is not started merely by importing the module', () => {
    // Every test suite requires server.js; a poller started at import would
    // leave timers running across the whole suite.
    jest.isolateModules(() => {
      const spy = jest.spyOn(global, 'setInterval');
      require('../../../../services/google/sheetSyncWorker');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('starts only once even if called repeatedly', () => {
    const spy = jest.spyOn(global, 'setInterval');
    worker.startWorker(60000);
    worker.startWorker(60000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('stops cleanly', () => {
    worker.startWorker(60000);
    const spy = jest.spyOn(global, 'clearInterval');
    worker.stopWorker();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── Staff-hours jobs and the nightly refresh ────────────────────────────────

jest.mock('../../../../services/google/staffHoursSyncEngine', () => ({ syncStaffHours: jest.fn() }));
const { syncStaffHours } = require('../../../../services/google/staffHoursSyncEngine');

describe('sheetSyncWorker job kinds', () => {
  afterEach(() => worker.stopWorker());

  it('routes a staff_hours job to the staff-hours engine by school', async () => {
    mockQueryResponse([job({ kind: 'staff_hours', form_id: null, school: 'ALHAADIACADEMY' })]);
    syncStaffHours.mockResolvedValueOnce({ synced: true });
    mockQueryResponse([{ job_id: 'j1' }]); // completeJob

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(syncStaffHours).toHaveBeenCalledWith('ALHAADIACADEMY');
    expect(syncForm).not.toHaveBeenCalled();
  });

  it('treats a job with no kind (queued before the migration) as a form job', async () => {
    mockQueryResponse([job()]);
    syncForm.mockResolvedValueOnce({ synced: true });
    mockQueryResponse([{ job_id: 'j1' }]);

    await worker.drainOnce();
    expect(syncForm).toHaveBeenCalledWith('form-1');
    expect(syncStaffHours).not.toHaveBeenCalled();
  });

  it('halts a staff-hours job permanently on a dead grant, like a form job', async () => {
    mockQueryResponse([job({ kind: 'staff_hours', form_id: null, school: 'ALHAADIACADEMY' })]);
    syncStaffHours.mockRejectedValueOnce(new NeedsReconnectError());
    mockQueryResponse([job({ state: 'failed' })]);

    await worker.drainOnce();
    expect(db.query.mock.calls.some(([sql]) => /state = 'failed'/.test(sql))).toBe(true);
  });
});

describe('sheetSyncWorker.enqueueNightlyIfDue', () => {
  beforeEach(() => worker._resetNightly());

  it('queues one refresh per linked school, once per day', async () => {
    mockQueryResponse([{ job_id: 'a' }, { job_id: 'b' }]);
    await expect(worker.enqueueNightlyIfDue('2026-09-27')).resolves.toBe(2);
    expect(sqlsUsed().some((s) => /SELECT 'staff_hours', school FROM staff_hours_sheet_links/.test(s))).toBe(true);

    const before = db.query.mock.calls.length;
    await expect(worker.enqueueNightlyIfDue('2026-09-27')).resolves.toBe(0);
    expect(db.query.mock.calls.length).toBe(before); // same day: no database call
  });

  it('fires again once the Toronto date changes', async () => {
    mockQueryResponse([{ job_id: 'a' }]);
    await worker.enqueueNightlyIfDue('2026-09-27');
    mockQueryResponse([{ job_id: 'b' }]);
    await expect(worker.enqueueNightlyIfDue('2026-09-28')).resolves.toBe(1);
  });

  it('does not retry on every tick after a database failure', async () => {
    db.query.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(worker.enqueueNightlyIfDue('2026-09-27')).rejects.toThrow('connection terminated');
    await expect(worker.enqueueNightlyIfDue('2026-09-27')).resolves.toBe(0);
  });
});
