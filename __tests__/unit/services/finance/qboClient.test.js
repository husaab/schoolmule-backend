const { createClient, QboApiError, QboThrottledError } = require('../../../../services/finance/qboClient');
const { NeedsReconnectError } = require('../../../../services/finance/errors');
const { invoice, queryResponse, cdcResponse } = require('../../../helpers/qboFixtures');

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function makeClient(over = {}) {
  const calls = [];
  const fetchImpl = jest.fn();
  const getToken = jest.fn().mockResolvedValue('tok-1');
  const sleep = jest.fn().mockResolvedValue();
  const client = createClient({ school: 'ALHAADIACADEMY', realmId: '913', getToken, fetchImpl, sleep, onCall: () => calls.push(1), ...over });
  return { client, fetchImpl, getToken, sleep, calls };
}

describe('qboClient.request', () => {
  it('adds the bearer token, Accept header and minorversion to every call', async () => {
    const { client, fetchImpl, calls } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ CompanyInfo: { CompanyName: 'Al Haadi' } }));
    const out = await client.request('GET', 'companyinfo/913');
    expect(out.CompanyInfo.CompanyName).toBe('Al Haadi');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://quickbooks.api.intuit.com/v3/company/913/companyinfo/913?minorversion=75');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(init.headers.Accept).toBe('application/json');
    expect(calls).toHaveLength(1);
  });

  it('refreshes once on 401 and retries; a second 401 means reconnect', async () => {
    const { client, fetchImpl, getToken } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ fault: { type: 'AUTHENTICATION' } }, 401));
    fetchImpl.mockResolvedValueOnce(json({ ok: true }));
    await expect(client.request('GET', 'companyinfo/913')).resolves.toEqual({ ok: true });
    expect(getToken).toHaveBeenCalledWith({ force: true });

    fetchImpl.mockResolvedValueOnce(json({}, 401));
    fetchImpl.mockResolvedValueOnce(json({}, 401));
    await expect(client.request('GET', 'companyinfo/913')).rejects.toBeInstanceOf(NeedsReconnectError);
  });

  it('honours Retry-After on 429, then gives up with a throttled error', async () => {
    const { client, fetchImpl, sleep } = makeClient({ maxRetries: 2 });
    fetchImpl.mockResolvedValueOnce(json({ Fault: { Error: [{ code: '3001', Message: 'ThrottleExceeded' }] } }, 429, { 'Retry-After': '7' }));
    fetchImpl.mockResolvedValueOnce(json({ ok: true }));
    await expect(client.request('GET', 'x')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(7000);

    fetchImpl.mockResolvedValue(json({}, 429));
    await expect(client.request('GET', 'x')).rejects.toBeInstanceOf(QboThrottledError);
  });

  it('backs off and retries on 5xx, then throws a retryable error', async () => {
    const { client, fetchImpl, sleep } = makeClient({ maxRetries: 3 });
    fetchImpl.mockResolvedValueOnce(json({}, 503));
    fetchImpl.mockResolvedValueOnce(json({}, 502));
    fetchImpl.mockResolvedValueOnce(json({ ok: true }));
    await expect(client.request('GET', 'x')).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1][0]).toBeGreaterThanOrEqual(sleep.mock.calls[0][0]);

    fetchImpl.mockResolvedValue(json({}, 500));
    await expect(client.request('GET', 'x')).rejects.toMatchObject({ retryable: true, status: 500 });
  });

  it('turns a Fault (either casing) into a non-retryable QboApiError with the code', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ Fault: { Error: [{ code: '6240', Message: 'Duplicate Name Exists Error', Detail: 'x' }], type: 'ValidationFault' } }, 400));
    await expect(client.request('POST', 'customer', { body: {} })).rejects.toMatchObject({ code: '6240', retryable: false });

    fetchImpl.mockResolvedValueOnce(json({ fault: { error: [{ code: '4001', message: 'Invalid query' }] } }, 400));
    const err = await client.request('GET', 'query?query=x').catch((e) => e);
    expect(err).toBeInstanceOf(QboApiError);
    expect(err.code).toBe('4001');
  });

  it('treats a network failure as retryable', async () => {
    const { client, fetchImpl } = makeClient({ maxRetries: 1 });
    fetchImpl.mockRejectedValue(new TypeError('fetch failed'));
    await expect(client.request('GET', 'x')).rejects.toMatchObject({ retryable: true });
  });
});

describe('qboClient.query / queryPages / cdc', () => {
  it('URL-encodes the query and returns the QueryResponse', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json(queryResponse('Invoice', [invoice({ id: '1' })])));
    const res = await client.query("SELECT * FROM Invoice WHERE TxnDate >= '2026-08-01'");
    expect(res.Invoice).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0]).toContain(`query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE TxnDate >= '2026-08-01'")}`);
  });

  it('pages with STARTPOSITION until a short page', async () => {
    const { client, fetchImpl } = makeClient();
    const full = Array.from({ length: 3 }, (_, i) => invoice({ id: String(i + 1) }));
    fetchImpl.mockResolvedValueOnce(json(queryResponse('Invoice', full)));
    fetchImpl.mockResolvedValueOnce(json(queryResponse('Invoice', [invoice({ id: '4' })], { startPosition: 4 })));
    const pages = [];
    for await (const page of client.queryPages({ entity: 'Invoice', where: [{ field: 'TxnDate', op: '>=', value: '2026-08-01' }], pageSize: 3 })) pages.push(page);
    expect(pages.map((p) => p.length)).toEqual([3, 1]);
    expect(decodeURIComponent(fetchImpl.mock.calls[0][0])).toContain('STARTPOSITION 1 MAXRESULTS 3');
    expect(decodeURIComponent(fetchImpl.mock.calls[1][0])).toContain('STARTPOSITION 4 MAXRESULTS 3');
  });

  it('stops paging on an empty QueryResponse', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json(queryResponse('Invoice', [])));
    const pages = [];
    for await (const page of client.queryPages({ entity: 'Invoice' })) pages.push(page);
    expect(pages).toEqual([]);
  });

  it('parses a CDC response', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json(cdcResponse({ invoices: [invoice({ id: '9' })], deleted: { Payment: ['5'] } })));
    const out = await client.cdc(['Invoice', 'Payment', 'Customer'], '2026-09-27T10:00:00Z');
    expect(out.Invoice.upserts).toHaveLength(1);
    expect(out.Payment.deleted[0].id).toBe('5');
    expect(fetchImpl.mock.calls[0][0]).toContain('cdc?entities=Invoice%2CPayment%2CCustomer&changedSince=2026-09-27T10%3A00%3A00Z');
  });
});
