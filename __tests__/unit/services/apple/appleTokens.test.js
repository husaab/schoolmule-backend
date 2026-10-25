// Sign in with Apple tokens: the code exchange at sign-in and the revoke at
// account deletion, with Apple's endpoints stubbed and a real ES256 key.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ENV = {
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_SIGNIN_KEY_ID: 'KEY1234567',
  APPLE_SIGNIN_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).replace(/\n/g, '\\n'),
  APPLE_TOKEN_ENC_KEY: crypto.randomBytes(32).toString('base64'),
};

let appleTokens;
let fetchMock;
beforeEach(() => {
  jest.resetModules();
  Object.assign(process.env, ENV);
  delete process.env.APPLE_AUDIENCES;
  fetchMock = jest.fn();
  global.fetch = fetchMock;
  appleTokens = require('../../../../services/apple/appleTokens');
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const answer = (status, body = {}) => ({ ok: status < 400, status, json: async () => body });
const formOf = (call) => Object.fromEntries(new URLSearchParams(call[1].body));

describe('appleTokens', () => {
  it('trades the code for a refresh token, signed as our team and key, and keeps it encrypted', async () => {
    fetchMock.mockResolvedValue(answer(200, { refresh_token: 'apple-refresh-1', access_token: 'a' }));

    const stored = await appleTokens.exchangeCode('one-time-code');

    expect(fetchMock.mock.calls[0][0]).toBe('https://appleid.apple.com/auth/token');
    const form = formOf(fetchMock.mock.calls[0]);
    expect(form).toMatchObject({ client_id: 'com.schoolmule.app', code: 'one-time-code', grant_type: 'authorization_code' });
    const secret = jwt.verify(form.client_secret, publicKey, { algorithms: ['ES256'] });
    expect(secret).toMatchObject({ iss: 'TEAM123456', aud: 'https://appleid.apple.com', sub: 'com.schoolmule.app' });
    expect(jwt.decode(form.client_secret, { complete: true }).header.kid).toBe('KEY1234567');
    expect(stored).toBeTruthy();
    expect(stored).not.toContain('apple-refresh-1');
  });

  it('revokes what it stored', async () => {
    fetchMock.mockResolvedValueOnce(answer(200, { refresh_token: 'apple-refresh-2' }));
    const stored = await appleTokens.exchangeCode('code');
    fetchMock.mockResolvedValueOnce(answer(200));

    await expect(appleTokens.revoke(stored)).resolves.toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('https://appleid.apple.com/auth/revoke');
    expect(formOf(fetchMock.mock.calls[1])).toMatchObject({ token: 'apple-refresh-2', token_type_hint: 'refresh_token' });
  });

  it('never throws: Apple refusing gives null or false', async () => {
    fetchMock.mockResolvedValue(answer(400, { error: 'invalid_grant' }));
    await expect(appleTokens.exchangeCode('stale')).resolves.toBeNull();
    await expect(appleTokens.revoke('not:a:token')).resolves.toBe(false);
  });

  it('does nothing without a key', async () => {
    delete process.env.APPLE_SIGNIN_PRIVATE_KEY;
    await expect(appleTokens.exchangeCode('code')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
