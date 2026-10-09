describe('eventBuffer', () => {
  let buffer;
  let db;
  beforeEach(() => {
    // resetModules gives the buffer a fresh mock db; grab that same instance.
    jest.resetModules();
    jest.useFakeTimers();
    delete process.env.OBSERVE_DISABLED;
    db = require('../../../../__tests__/__mocks__/config/database');
    buffer = require('../../../../services/observe/eventBuffer');
  });
  afterEach(() => {
    buffer.stop();
    jest.useRealTimers();
  });

  it('is a no-op when OBSERVE_DISABLED=true', () => {
    process.env.OBSERVE_DISABLED = 'true';
    expect(buffer.push('login_events', { email: 'a@test.com', outcome: 'success' })).toBe(false);
    expect(buffer.pending()).toBe(0);
  });

  it('ignores unknown tables', () => {
    expect(buffer.push('nope', {})).toBe(false);
  });

  it('flushes on the timer with one multi-row insert per table', async () => {
    buffer.start();
    buffer.push('login_events', { email: 'a@test.com', outcome: 'success' });
    buffer.push('login_events', { email: 'b@test.com', outcome: 'bad_password' });
    expect(buffer.pending()).toBe(2);
    jest.advanceTimersByTime(buffer.FLUSH_MS);
    await buffer.flushNow();
    const inserts = db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO login_events'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toContain('VALUES ($1,$2,$3,$4,$5,$6,$7),($8,$9,$10,$11,$12,$13,$14)');
    expect(inserts[0][1]).toHaveLength(14);
    expect(inserts[0][1][1]).toBe('a@test.com');
    expect(buffer.pending()).toBe(0);
  });

  it('flushes immediately when a table reaches BATCH rows', async () => {
    buffer.start();
    for (let i = 0; i < buffer.BATCH; i++) buffer.push('request_events', { method: 'GET', route: '/x', path: '/x', status: 200, duration_ms: 1 });
    await Promise.resolve();
    await buffer.flushNow();
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO request_events'))).toBe(true);
  });

  it('caps at CAP rows and drops the oldest', () => {
    for (let i = 0; i < buffer.CAP + 5; i++) buffer.push('login_events', { email: `u${i}@test.com`, outcome: 'success' });
    expect(buffer.pending()).toBe(buffer.CAP);
    expect(buffer.stats().dropped).toBe(5);
  });

  it('swallows insert failures and drops those rows', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    buffer.push('login_events', { email: 'a@test.com', outcome: 'success' });
    await expect(buffer.flushNow()).resolves.toBeUndefined();
    expect(buffer.pending()).toBe(0);
    expect(buffer.stats().failures).toBe(1);
  });

  it('serialises jsonb context', async () => {
    buffer.push('error_events', { source: 'server', message: 'x', fingerprint: 'f', context: { a: 1 } });
    await buffer.flushNow();
    const [, values] = db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO error_events'));
    expect(values[values.length - 1]).toBe('{"a":1}');
  });
});
