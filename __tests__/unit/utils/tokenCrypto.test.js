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
