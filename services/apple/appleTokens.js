// services/apple/appleTokens.js
//
// Apple asks every app with Sign in with Apple to revoke the person's Apple
// tokens when they delete their account (guideline 5.1.1(v)). Revoking needs
// a token Apple issued us, so the first sign-in trades the app's one-time
// authorization code for a refresh token, kept encrypted on the user
// (users.apple_refresh_token), and account deletion revokes it.
//
// Talking to Apple needs a client secret: a short JWT signed with our Sign in
// with Apple key. Configured by:
//   APPLE_TEAM_ID              the developer team id
//   APPLE_SIGNIN_KEY_ID        the key's id
//   APPLE_SIGNIN_PRIVATE_KEY   the .p8 contents (newlines may be written \n)
//   APPLE_TOKEN_ENC_KEY        base64 of 32 bytes, encrypts the stored token
// Without them sign-in works as before and nothing is exchanged or revoked.

const jwt = require('jsonwebtoken');
const logger = require('../../logger');
const { createTokenCrypto } = require('../../utils/tokenCrypto');

const APPLE = 'https://appleid.apple.com';
const crypt = createTokenCrypto('APPLE_TOKEN_ENC_KEY');

const clientId = () => (process.env.APPLE_AUDIENCES || 'com.schoolmule.app').split(',')[0].trim();

let warned = false;
/** Whether tokens can be exchanged and revoked (logs once when they can't). */
function configured() {
  const ok = Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_SIGNIN_KEY_ID
    && process.env.APPLE_SIGNIN_PRIVATE_KEY && process.env.APPLE_TOKEN_ENC_KEY);
  if (!ok && !warned) {
    warned = true;
    logger.warn('Sign in with Apple token revocation is off: set APPLE_TEAM_ID, APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY and APPLE_TOKEN_ENC_KEY');
  }
  return ok;
}

const clientSecret = () =>
  jwt.sign({}, process.env.APPLE_SIGNIN_PRIVATE_KEY.replace(/\\n/g, '\n'), {
    algorithm: 'ES256',
    keyid: process.env.APPLE_SIGNIN_KEY_ID,
    issuer: process.env.APPLE_TEAM_ID,
    audience: APPLE,
    subject: clientId(),
    expiresIn: '5m',
  });

async function post(path, fields) {
  const res = await fetch(`${APPLE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...fields }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Apple ${path} answered ${res.status}`);
  return res.status === 200 ? res.json().catch(() => ({})) : {};
}

/**
 * Trades the app's authorization code for a refresh token, encrypted for
 * storage; null when not configured or Apple refused. Never throws.
 */
async function exchangeCode(authorizationCode) {
  if (typeof authorizationCode !== 'string' || !authorizationCode || !configured()) return null;
  try {
    const { refresh_token: refreshToken } = await post('/auth/token', { code: authorizationCode, grant_type: 'authorization_code' });
    return refreshToken ? crypt.encryptToken(refreshToken) : null;
  } catch (error) {
    logger.warn({ err: error.message }, 'Could not exchange a Sign in with Apple code');
    return null;
  }
}

/** Revokes a stored (encrypted) refresh token at Apple. Never throws; true when Apple took it. */
async function revoke(storedToken) {
  if (!storedToken || !configured()) return false;
  try {
    await post('/auth/revoke', { token: crypt.decryptToken(storedToken), token_type_hint: 'refresh_token' });
    return true;
  } catch (error) {
    logger.warn({ err: error.message }, 'Could not revoke a Sign in with Apple token');
    return false;
  }
}

module.exports = { exchangeCode, revoke, configured };
