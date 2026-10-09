const { parseWindow } = require('../../../../services/observe/window');

describe('railwayMetrics.getInfra', () => {
  let railway;
  beforeEach(() => {
    jest.resetModules();
    process.env.RAILWAY_TOKEN = 'tok';
    process.env.RAILWAY_PROJECT_ID = 'p';
    process.env.RAILWAY_ENVIRONMENT_ID = 'e';
    process.env.RAILWAY_SERVICE_ID = 's';
    global.fetch = jest.fn();
    railway = require('../../../../services/observe/railwayMetrics');
  });
  afterEach(() => { delete process.env.RAILWAY_TOKEN; delete global.fetch; });

  it('reports unavailable without a token and never calls fetch', async () => {
    delete process.env.RAILWAY_TOKEN;
    const r = await railway.getInfra(parseWindow('1h'));
    expect(r).toEqual({ available: false, reason: 'RAILWAY_TOKEN is not set' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('queries metrics and deployments with the project token header and shapes the result', async () => {
    global.fetch
      .mockResolvedValueOnce({ json: async () => ({ data: { metrics: [
        { measurement: 'CPU_USAGE', values: [{ ts: 1791486000, value: 0.01 }] },
        { measurement: 'MEMORY_USAGE_GB', values: [{ ts: 1791486000, value: 0.2 }] },
        { measurement: 'NETWORK_RX_GB', values: [] }, { measurement: 'NETWORK_TX_GB', values: [] } ] } }) })
      .mockResolvedValueOnce({ json: async () => ({ data: { deployments: { edges: [
        { node: { id: 'd1', status: 'SUCCESS', createdAt: '2026-10-08T10:00:00Z', meta: { commitMessage: 'feat: x', commitAuthor: 'husaab', branch: 'main' } } } ] } } }) });
    const r = await railway.getInfra(parseWindow('1h'));
    expect(r.available).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers['Project-Access-Token']).toBe('tok');
    expect(r.cpu).toEqual([{ ts: '2026-10-08T19:00:00.000Z', value: 0.01 }]);
    expect(r.memoryGb[0].value).toBe(0.2);
    expect(r.deployments).toEqual([{ id: 'd1', status: 'SUCCESS', createdAt: '2026-10-08T10:00:00Z', commitMessage: 'feat: x', commitAuthor: 'husaab', branch: 'main' }]);
  });

  it('caches for 60 seconds per window', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ data: { metrics: [], deployments: { edges: [] } } }) });
    await railway.getInfra(parseWindow('1h'));
    await railway.getInfra(parseWindow('1h'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await railway.getInfra(parseWindow('24h'));
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('turns a GraphQL error into available:false', async () => {
    global.fetch.mockResolvedValue({ json: async () => ({ errors: [{ message: 'Not Authorized' }] }) });
    const r = await railway.getInfra(parseWindow('1h'));
    expect(r).toEqual({ available: false, reason: 'Not Authorized' });
  });
});
