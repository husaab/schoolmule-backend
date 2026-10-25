// Sign in with Apple: identity token verification against a real RSA key,
// with Apple's key endpoint stubbed.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyIdentityToken, AppleSignInError, sha256Hex, resetKeys } = require('../../../../services/apple/appleSignIn');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
const jwk = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });

const NONCE = 'raw-nonce-0123456789abcdef';

const token = (claims = {}, { key = privateKey, kid = KID, expiresIn = '10m' } = {}) =>
  jwt.sign(
    {
      sub: '001234.abcdef.1234',
      email: 'parent.demo@example.test',
      email_verified: 'true',
      nonce: sha256Hex(NONCE),
      ...claims,
    },
    key,
    { algorithm: 'RS256', keyid: kid, issuer: 'https://appleid.apple.com', audience: 'com.schoolmule.app', expiresIn },
  );

let fetchMock;
beforeEach(() => {
  resetKeys();
  delete process.env.APPLE_AUDIENCES;
  fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ keys: [jwk(publicKey, KID)] }) });
  global.fetch = fetchMock;
});

describe('appleSignIn.verifyIdentityToken', () => {
  it('returns the Apple ID and the verified address', async () => {
    await expect(verifyIdentityToken(token(), NONCE)).resolves.toEqual({
      sub: '001234.abcdef.1234',
      email: 'parent.demo@example.test',
      emailVerified: true,
      privateEmail: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://appleid.apple.com/auth/keys', expect.anything());
  });

  it('reuses the cached keys for the next sign-in', async () => {
    await verifyIdentityToken(token(), NONCE);
    await verifyIdentityToken(token(), NONCE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks a Hide My Email address as private', async () => {
    const t = token({ email: 'x7k2q9@privaterelay.appleid.com', is_private_email: 'true' });
    await expect(verifyIdentityToken(t, NONCE)).resolves.toMatchObject({ privateEmail: true, emailVerified: true });
  });

  it('accepts a token without an address (Apple sends it only on the first authorization)', async () => {
    const t = token({ email: undefined, email_verified: undefined });
    await expect(verifyIdentityToken(t, NONCE)).resolves.toMatchObject({ email: null, emailVerified: false });
  });

  it.each([
    ['a token for another app', () => jwt.sign({ sub: 's', nonce: sha256Hex(NONCE) }, privateKey, { algorithm: 'RS256', keyid: KID, issuer: 'https://appleid.apple.com', audience: 'com.other.app' })],
    ['a token from another issuer', () => jwt.sign({ sub: 's', nonce: sha256Hex(NONCE) }, privateKey, { algorithm: 'RS256', keyid: KID, issuer: 'https://evil.example', audience: 'com.schoolmule.app' })],
    ['an expired token', () => token({}, { expiresIn: -10 })],
    ['a token signed by someone else with our key id', () => token({}, { key: other.privateKey })],
    ['a nonce that does not match', () => token({ nonce: sha256Hex('some-other-nonce-value') })],
    ['a token with no nonce', () => token({ nonce: undefined })],
  ])('refuses %s', async (_label, make) => {
    await expect(verifyIdentityToken(make(), NONCE)).rejects.toBeInstanceOf(AppleSignInError);
  });

  it('refuses a missing or short nonce before fetching keys', async () => {
    await expect(verifyIdentityToken(token(), undefined)).rejects.toBeInstanceOf(AppleSignInError);
    await expect(verifyIdentityToken(token(), 'short')).rejects.toBeInstanceOf(AppleSignInError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses garbage', async () => {
    await expect(verifyIdentityToken('not-a-jwt', NONCE)).rejects.toBeInstanceOf(AppleSignInError);
  });

  it('refuses a token whose key Apple does not publish', async () => {
    await expect(verifyIdentityToken(token({}, { kid: 'unknown-kid' }), NONCE)).rejects.toBeInstanceOf(AppleSignInError);
  });

  it('accepts the audiences configured in APPLE_AUDIENCES', async () => {
    process.env.APPLE_AUDIENCES = 'com.schoolmule.app, com.schoolmule.app.dev';
    const t = jwt.sign({ sub: 's', nonce: sha256Hex(NONCE) }, privateKey, { algorithm: 'RS256', keyid: KID, issuer: 'https://appleid.apple.com', audience: 'com.schoolmule.app.dev' });
    await expect(verifyIdentityToken(t, NONCE)).resolves.toMatchObject({ sub: 's' });
  });

  it('lets an unreachable Apple through as a plain error (a 500, not a retry message)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const err = await verifyIdentityToken(token(), NONCE).catch((e) => e);
    expect(err).not.toBeInstanceOf(AppleSignInError);
    expect(err.message).toMatch(/503/);
  });
});
