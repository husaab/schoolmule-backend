// utils/tokenCrypto.js
//
// Symmetric encryption for credentials held at rest.
//
// A refresh token is a long-lived key to a school's data (its Drive files, its
// QuickBooks books), so it is never stored in readable form. AES-256-GCM is
// authenticated: tampering with the stored value makes decryption throw rather
// than silently returning altered bytes.
//
// Each integration gets its own key via createTokenCrypto(envVar), so a leaked
// key for one service never unlocks another's tokens. The bare exports keep the
// original Google-only API for existing callers.
//
// Payload format is `iv:authTag:ciphertext`, each base64.

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/**
 * Builds an encrypt/decrypt pair keyed by the named environment variable
 * (a base64 string decoding to exactly 32 bytes).
 */
function createTokenCrypto(envVar) {
  function key() {
    const raw = process.env[envVar];
    if (!raw) {
      throw new Error(`${envVar} is not set — cannot handle tokens`);
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== KEY_BYTES) {
      // Failing loudly beats silently encrypting with a short key.
      throw new Error(`${envVar} must decode to ${KEY_BYTES} bytes (got ${buf.length})`);
    }
    return buf;
  }

  /** Encrypts a token for storage. A fresh random IV each call, so identical
   *  tokens never produce identical ciphertext. */
  function encryptToken(plain) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key(), iv);
    const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return [
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      data.toString('base64'),
    ].join(':');
  }

  /** Reverses encryptToken. Throws on a malformed, tampered, or wrong-key payload. */
  function decryptToken(payload) {
    const parts = String(payload).split(':');
    if (parts.length !== 3 || parts.some((p) => !p)) {
      throw new Error('Malformed encrypted token');
    }
    const [iv, tag, data] = parts;
    const tagBuf = Buffer.from(tag, 'base64');
    // GCM accepts tags as short as 4 bytes unless told otherwise; a short tag is
    // a forgery attempt, not a token we wrote.
    if (tagBuf.length !== TAG_BYTES) throw new Error('Malformed encrypted token');
    const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(iv, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  return { encryptToken, decryptToken };
}

const google = createTokenCrypto('GOOGLE_TOKEN_ENC_KEY');

module.exports = {
  createTokenCrypto,
  encryptToken: google.encryptToken,
  decryptToken: google.decryptToken,
};
