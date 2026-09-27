const { encryptToken, decryptToken } = require('../../../utils/tokenCrypto');

describe('tokenCrypto', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');

  beforeEach(() => { process.env.GOOGLE_TOKEN_ENC_KEY = KEY; });

  it('round-trips a token', () => {
    const token = '1//0abcdefghijklmnop-refresh-token';
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it('produces different ciphertext each time, so a repeated token is not recognizable', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });

  it('never leaks the plaintext into the ciphertext', () => {
    expect(encryptToken('SECRET123')).not.toContain('SECRET123');
  });

  it('rejects tampered ciphertext rather than returning garbage', () => {
    const [iv, tag, data] = encryptToken('token').split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptToken(`${iv}:${tag}:${flipped.toString('base64')}`)).toThrow();
  });

  it('rejects ciphertext whose auth tag has been swapped', () => {
    const [iv, , data] = encryptToken('token').split(':');
    const otherTag = encryptToken('different').split(':')[1];
    expect(() => decryptToken(`${iv}:${otherTag}:${data}`)).toThrow();
  });

  it('rejects a truncated auth tag rather than accepting a weaker one', () => {
    const [iv, tag, data] = encryptToken('token').split(':');
    const short = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptToken(`${iv}:${short}:${data}`)).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decryptToken('not-a-valid-payload')).toThrow(/Malformed/);
  });

  it('throws a clear error when the key is missing', () => {
    delete process.env.GOOGLE_TOKEN_ENC_KEY;
    expect(() => encryptToken('x')).toThrow(/GOOGLE_TOKEN_ENC_KEY/);
  });

  it('throws when the key is the wrong length rather than silently weakening', () => {
    process.env.GOOGLE_TOKEN_ENC_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptToken('x')).toThrow(/32 bytes/);
  });

  it('cannot decrypt with a different key', () => {
    const enc = encryptToken('token');
    process.env.GOOGLE_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(() => decryptToken(enc)).toThrow();
  });

  it('handles a realistically long refresh token', () => {
    const long = '1//' + 'a'.repeat(512);
    expect(decryptToken(encryptToken(long))).toBe(long);
  });
});

describe('createTokenCrypto', () => {
  const { createTokenCrypto } = require('../../../utils/tokenCrypto');
  const KEY_A = Buffer.alloc(32, 3).toString('base64');
  const KEY_B = Buffer.alloc(32, 4).toString('base64');

  beforeEach(() => {
    process.env.GOOGLE_TOKEN_ENC_KEY = KEY_A;
    process.env.QBO_TOKEN_ENC_KEY = KEY_B;
  });

  it('round-trips with the named key', () => {
    const qbo = createTokenCrypto('QBO_TOKEN_ENC_KEY');
    expect(qbo.decryptToken(qbo.encryptToken('rt-123'))).toBe('rt-123');
  });

  it('keeps the two integrations cryptographically separate', () => {
    const { encryptToken } = require('../../../utils/tokenCrypto');
    const qbo = createTokenCrypto('QBO_TOKEN_ENC_KEY');
    // A token encrypted under the Google key must not open with the QBO key.
    expect(() => qbo.decryptToken(encryptToken('secret'))).toThrow();
  });

  it('names the missing variable in its error', () => {
    delete process.env.QBO_TOKEN_ENC_KEY;
    const qbo = createTokenCrypto('QBO_TOKEN_ENC_KEY');
    expect(() => qbo.encryptToken('x')).toThrow(/QBO_TOKEN_ENC_KEY/);
  });
});
