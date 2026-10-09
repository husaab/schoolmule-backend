const db = require('../../../../__tests__/__mocks__/config/database');
const worker = require('../../../../services/observe/retentionWorker');

afterEach(() => worker.stopWorker());

describe('retentionWorker.sweepOnce', () => {
  it('deletes in batches per table until a batch comes back short', async () => {
    // request_events: 2 full batches then a short one; others: short immediately
    db.query.mockResolvedValueOnce({ rowCount: 10000 });
    db.query.mockResolvedValueOnce({ rowCount: 10000 });
    db.query.mockResolvedValueOnce({ rowCount: 3 });
    const result = await worker.sweepOnce(90);
    expect(result.deleted.request_events).toBe(20003);
    const first = db.query.mock.calls[0];
    expect(first[0]).toMatch(/DELETE FROM request_events WHERE event_id IN \(SELECT event_id FROM request_events WHERE ts < NOW\(\) - \(\$1 \|\| ' days'\)::interval ORDER BY ts LIMIT 10000\)/);
    expect(first[1]).toEqual([90]);
    expect(Object.keys(result.deleted)).toEqual(['request_events', 'error_events', 'client_events', 'login_events']);
  });
  it('keeps going when one table fails', async () => {
    db.query.mockRejectedValueOnce(new Error('x'));
    const result = await worker.sweepOnce(30);
    expect(result.deleted.request_events).toBe(0);
    expect(result.errors).toHaveLength(1);
  });
});
