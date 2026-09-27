const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const { createTokenCrypto } = require('../../../../utils/tokenCrypto');

const KEY = Buffer.alloc(32, 5).toString('base64');
process.env.QBO_TOKEN_ENC_KEY = KEY;
process.env.QBO_CLIENT_ID = 'cid';
process.env.QBO_CLIENT_SECRET = 'csecret';
process.env.QBO_REDIRECT_URI = 'https://api.example.com/api/finance/qbo/callback';

const auth = require('../../../../services/finance/qboAuth');
const crypto = createTokenCrypto('QBO_TOKEN_ENC_KEY');

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const connRow = (over = {}) => ({
  connection_id: 'c1', school: 'ALHAADIACADEMY', realm_id: '9130351374400296', status: 'active',
  refresh_token: crypto.encryptToken('old-refresh'), refresh_token_version: 3,
  access_token: crypto.encryptToken('old-access'),
  access_token_expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
  ...over,
});

let fetchSpy;
beforeEach(() => {
  process.env.QBO_TOKEN_ENC_KEY = KEY;
  fetchSpy = jest.spyOn(global, 'fetch');
});
afterEach(() => fetchSpy.mockRestore());

describe('qboAuth.getAccessToken', () => {
  it('returns the cached access token without touching Intuit when it is still fresh', async () => {
    mockQueryResponse([connRow()]);
    await expect(auth.getAccessToken('ALHAADIACADEMY')).resolves.toBe('old-access');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('throws NeedsReconnectError when the connection is flagged or missing', async () => {
    mockQueryResponse([connRow({ status: 'needs_reconnect' })]);
    await expect(auth.getAccessToken('ALHAADIACADEMY')).rejects.toBeInstanceOf(auth.NeedsReconnectError);
    mockQueryResponse([]);
    await expect(auth.getAccessToken('ALHAADIACADEMY')).rejects.toMatchObject({ needsReconnect: true });
  });

  it('refreshes under a row lock and persists the rotated refresh token', async () => {
    const expired = connRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    mockQueryResponse([expired]); // fast path sees it expired
    const client = db._mockClient;
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [expired] }); // SELECT … FOR UPDATE
    client.query.mockResolvedValueOnce({ rows: [{ connection_id: 'c1' }], rowCount: 1 }); // UPDATE tokens
    client.query.mockResolvedValueOnce({}); // COMMIT
    fetchSpy.mockResolvedValueOnce(jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, x_refresh_token_expires_in: 8726400, token_type: 'bearer' }));

    await expect(auth.getAccessToken('ALHAADIACADEMY')).resolves.toBe('new-access');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('cid:csecret').toString('base64')}`);
    expect(String(init.body)).toContain('grant_type=refresh_token');
    expect(String(init.body)).toContain('refresh_token=old-refresh');

    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls[1]).toMatch(/FOR UPDATE/);
    const update = client.query.mock.calls[2];
    expect(update[0]).toMatch(/refresh_token_version = refresh_token_version \+ 1/);
    expect(update[0]).toMatch(/refresh_token_version = \$/);
    // params: school, enc refresh, enc access, expires seconds, expected version
    expect(crypto.decryptToken(update[1][1])).toBe('new-refresh');
    expect(crypto.decryptToken(update[1][2])).toBe('new-access');
    expect(update[1]).toContain(3);
    expect(sqls[3]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('skips the refresh when another process refreshed while it waited for the lock', async () => {
    mockQueryResponse([connRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() })]);
    const client = db._mockClient;
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [connRow({ access_token: crypto.encryptToken('fresh-from-other') })] }); // FOR UPDATE: now fresh
    client.query.mockResolvedValueOnce({}); // COMMIT

    await expect(auth.getAccessToken('ALHAADIACADEMY')).resolves.toBe('fresh-from-other');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('marks the connection needs_reconnect on invalid_grant and throws', async () => {
    const expired = connRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    mockQueryResponse([expired]);
    const client = db._mockClient;
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [expired] }); // FOR UPDATE
    client.query.mockResolvedValueOnce({ rows: [{}] }); // mark needs_reconnect
    client.query.mockResolvedValueOnce({}); // COMMIT
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant', error_description: 'Token invalid' }, 400));

    await expect(auth.getAccessToken('ALHAADIACADEMY')).rejects.toBeInstanceOf(auth.NeedsReconnectError);
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /needs_reconnect/.test(s))).toBe(true);
    expect(sqls).toContain('COMMIT');
  });

  it('rolls back and throws a retryable error on an Intuit 5xx, without flagging the connection', async () => {
    const expired = connRow({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    mockQueryResponse([expired]);
    const client = db._mockClient;
    client.query.mockResolvedValueOnce({}); // BEGIN
    client.query.mockResolvedValueOnce({ rows: [expired] }); // FOR UPDATE
    client.query.mockResolvedValueOnce({}); // ROLLBACK
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, 503));

    await expect(auth.getAccessToken('ALHAADIACADEMY')).rejects.toMatchObject({ retryable: true });
    const sqls = client.query.mock.calls.map((c) => c[0]);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some((s) => /needs_reconnect/.test(s))).toBe(false);
  });

  it('flags the connection when the stored token cannot be decrypted (key rotated)', async () => {
    mockQueryResponse([connRow({ access_token: 'garbage', access_token_expires_at: new Date(Date.now() + 3600e3).toISOString() })]);
    mockQueryResponse([{}]); // markNeedsReconnect
    await expect(auth.getAccessToken('ALHAADIACADEMY')).rejects.toBeInstanceOf(auth.NeedsReconnectError);
    expect(db.query.mock.calls.some(([sql]) => /needs_reconnect/.test(sql))).toBe(true);
  });
});

describe('qboAuth configuration errors', () => {
  it('treats a missing encryption key as a configuration error, not a revoked grant', async () => {
    mockQueryResponse([connRow()]);
    delete process.env.QBO_TOKEN_ENC_KEY;
    await expect(auth.getAccessToken('ALHAADIACADEMY')).rejects.toThrow(/QBO_TOKEN_ENC_KEY/);
    expect(db.query.mock.calls.some(([sql]) => /needs_reconnect/.test(sql))).toBe(false);
    process.env.QBO_TOKEN_ENC_KEY = KEY;
  });
});

describe('qboAuth.buildAuthUrl / exchangeCode', () => {
  it('builds the Intuit consent URL with the accounting scope and signed state', () => {
    const url = new URL(auth.buildAuthUrl({ state: 'abc.def' }));
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('redirect_uri')).toBe(process.env.QBO_REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe('abc.def');
  });

  it('exchanges the code for tokens with the authorization_code grant', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
    await expect(auth.exchangeCode('the-code')).resolves.toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    const [, init] = fetchSpy.mock.calls[0];
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(String(init.body)).toContain('code=the-code');
    expect(String(init.body)).toContain(`redirect_uri=${encodeURIComponent(process.env.QBO_REDIRECT_URI)}`);
  });

  it('throws when OAuth env is missing', () => {
    const saved = process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_ID;
    expect(() => auth.buildAuthUrl({ state: 'x' })).toThrow(/QBO_CLIENT_ID/);
    process.env.QBO_CLIENT_ID = saved;
  });
});

describe('qboAuth.saveConnection', () => {
  it('stores encrypted tokens and never the plaintext', async () => {
    mockQueryResponse([{ connection_id: 'c1', school: 'ALHAADIACADEMY', realm_id: '913', status: 'active' }]);
    await auth.saveConnection({ school: 'ALHAADIACADEMY', realmId: '913', companyName: 'Al Haadi', userId: 'u1',
      tokens: { accessToken: 'acc', refreshToken: 'ref', expiresIn: 3600 } });
    const [sql, params] = db.query.mock.calls.find(([s]) => /INSERT INTO finance_qbo_connections/.test(s));
    expect(sql).toMatch(/ON CONFLICT \(school\)/);
    expect(params).not.toContain('ref');
    expect(params).not.toContain('acc');
    expect(params.some((p) => typeof p === 'string' && p.split(':').length === 3 && crypto.decryptToken(p) === 'ref')).toBe(true);
  });
});
