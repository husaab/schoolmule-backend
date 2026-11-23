// The admin overview's lanes (services/adminOverview/runBlocks.js): at most
// OVERVIEW_CONCURRENCY clients at once, every statement capped and the cap
// lifted before a client goes back, one failing block isolated, and a 503 when
// no client can be had. A fake pool counts what is checked out.

const {
  runBlocks,
  overviewConcurrency,
  OverviewUnavailableError,
  STATEMENT_TIMEOUT_MS,
} = require('../../../../services/adminOverview/runBlocks');

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pg.Pool stand-in. failConnect: connect throws; failSet: the cap throws
 * (true, or a function of the client's index); failReset: RESET throws.
 */
function fakePool({ failConnect = false, failSet = false, failReset = false } = {}) {
  const pool = { out: 0, maxOut: 0, connects: 0, clients: [] };
  pool.connect = jest.fn(async () => {
    pool.connects += 1;
    if (failConnect) throw new Error('pool exhausted');
    await tick(1);
    pool.out += 1;
    pool.maxOut = Math.max(pool.maxOut, pool.out);
    const index = pool.clients.length;
    const setFails = typeof failSet === 'function' ? failSet(index) : failSet;
    const client = {
      statements: [],
      query: jest.fn(async (text) => {
        client.statements.push(text);
        if (setFails && /^SET statement_timeout/.test(text)) throw new Error('set failed');
        if (failReset && text === 'RESET statement_timeout') throw new Error('connection lost');
        return { rows: [{ text }] };
      }),
      release: jest.fn(() => { pool.out -= 1; }),
    };
    pool.clients.push(client);
    return client;
  });
  return pool;
}

const task = (key, run = async (q) => { await q(`SELECT '${key}'`); await tick(); return { key }; }) => ({ key, run });

describe('runBlocks', () => {
  const ctx = { school: 'ALHAADIACADEMY' };
  const OLD_ENV = process.env.OVERVIEW_CONCURRENCY;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.OVERVIEW_CONCURRENCY;
    else process.env.OVERVIEW_CONCURRENCY = OLD_ENV;
  });

  it('never holds more than 3 clients, however many blocks', async () => {
    const pool = fakePool();
    const keys = Array.from({ length: 12 }, (_, i) => `b${i}`);
    const results = await runBlocks(pool, keys.map((k) => task(k)), ctx);

    expect(pool.maxOut).toBeLessThanOrEqual(3);
    expect(pool.connects).toBe(3);
    expect(pool.out).toBe(0);
    expect(Object.keys(results).sort()).toEqual([...keys].sort());
    keys.forEach((k) => expect(results[k]).toEqual({ key: k }));
  });

  it('opens only as many lanes as there are blocks', async () => {
    const pool = fakePool();
    await runBlocks(pool, [task('a'), task('b')], ctx);
    expect(pool.connects).toBe(2);
  });

  it('takes the lane count from OVERVIEW_CONCURRENCY', async () => {
    process.env.OVERVIEW_CONCURRENCY = '1';
    expect(overviewConcurrency()).toBe(1);
    const pool = fakePool();
    await runBlocks(pool, [task('a'), task('b'), task('c')], ctx);
    expect(pool.maxOut).toBe(1);
    expect(pool.connects).toBe(1);

    process.env.OVERVIEW_CONCURRENCY = 'lots';
    expect(overviewConcurrency()).toBe(3);
  });

  it("runs a lane's blocks in order, one at a time, on one client", async () => {
    const pool = fakePool();
    const order = [];
    const block = (key) => task(key, async (q, c) => {
      expect(c).toBe(ctx);
      order.push(`${key}:start`);
      await q(`SELECT '${key}'`);
      await tick();
      order.push(`${key}:end`);
      return key;
    });
    await runBlocks(pool, [block('a'), block('b'), block('c')], ctx, { concurrency: 1 });

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
    expect(pool.clients[0].statements).toEqual([
      `SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
      "SELECT 'a'", "SELECT 'b'", "SELECT 'c'",
      'RESET statement_timeout',
    ]);
  });

  it('caps every client at 4 seconds and lifts the cap before returning it', async () => {
    expect(STATEMENT_TIMEOUT_MS).toBe(4000);
    const pool = fakePool();
    await runBlocks(pool, [task('a'), task('b'), task('c'), task('d')], ctx);

    for (const client of pool.clients) {
      expect(client.statements[0]).toBe('SET statement_timeout = 4000');
      expect(client.statements[client.statements.length - 1]).toBe('RESET statement_timeout');
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(false);
    }
  });

  it('turns a throwing block into { error: true } and keeps going', async () => {
    const pool = fakePool();
    const logger = { warn: jest.fn() };
    const boom = task('broken', async () => { throw new Error('canceling statement due to statement timeout'); });
    const results = await runBlocks(pool, [task('a'), boom, task('b'), task('c')], ctx, { concurrency: 1, logger });

    expect(results).toEqual({ a: { key: 'a' }, broken: { error: true }, b: { key: 'b' }, c: { key: 'c' } });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ block: 'broken' }), expect.any(String));
    expect(pool.clients[0].release).toHaveBeenCalledWith(false);
  });

  it('destroys a client whose RESET failed', async () => {
    const pool = fakePool({ failReset: true });
    const results = await runBlocks(pool, [task('a')], ctx);

    expect(results).toEqual({ a: { key: 'a' } });
    expect(pool.clients[0].release).toHaveBeenCalledWith(true);
  });

  it('destroys a client that would not take the cap, and leaves its blocks to no one else', async () => {
    const pool = fakePool({ failSet: true });
    await expect(runBlocks(pool, [task('a')], ctx)).rejects.toBeInstanceOf(OverviewUnavailableError);
    expect(pool.clients[0].release).toHaveBeenCalledWith(true);
    expect(pool.clients[0].statements).not.toContain('RESET statement_timeout');
  });

  it('leaves the blocks of a lane that would not take the cap to a healthy lane', async () => {
    const pool = fakePool({ failSet: (index) => index === 0 });
    const keys = ['a', 'b', 'c', 'd'];
    const results = await runBlocks(pool, keys.map((k) => task(k)), ctx, { concurrency: 2 });

    keys.forEach((k) => expect(results[k]).toEqual({ key: k }));
    expect(pool.clients[0].release).toHaveBeenCalledWith(true);
    expect(pool.clients[1].release).toHaveBeenCalledWith(false);
  });

  it('is unavailable (503) when no lane gets a client', async () => {
    const pool = fakePool({ failConnect: true });
    const logger = { warn: jest.fn() };
    const err = await runBlocks(pool, [task('a'), task('b')], ctx, { logger }).catch((e) => e);

    expect(err).toBeInstanceOf(OverviewUnavailableError);
    expect(err.status).toBe(503);
    expect(pool.connects).toBe(2);
  });

  it('gives blocks a missing lane would have run to the lanes that connected', async () => {
    const pool = fakePool();
    const connect = pool.connect;
    let calls = 0;
    pool.connect = jest.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('pool exhausted');
      return connect();
    });
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const results = await runBlocks(pool, keys.map((k) => task(k)), ctx);

    keys.forEach((k) => expect(results[k]).toEqual({ key: k }));
    expect(pool.clients).toHaveLength(2);
  });

  it('is unavailable when one lane never connects and the other will not take the cap', async () => {
    const pool = fakePool({ failSet: true });
    const connect = pool.connect;
    let calls = 0;
    pool.connect = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('pool exhausted');
      return connect();
    });
    await expect(runBlocks(pool, [task('a'), task('b')], ctx)).rejects.toBeInstanceOf(OverviewUnavailableError);
    expect(pool.clients[0].release).toHaveBeenCalledWith(true);
  });

  it('checks nothing out when there is nothing to run', async () => {
    const pool = fakePool();
    await expect(runBlocks(pool, [], ctx)).resolves.toEqual({});
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
