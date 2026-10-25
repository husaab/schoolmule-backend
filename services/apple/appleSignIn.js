// services/apple/appleSignIn.js
//
// "Sign in with Apple" from the iOS app: turns the identity token Apple hands
// the app into a verified Apple identity.
//
// The token is a JWT signed by one of Apple's published keys
// (https://appleid.apple.com/auth/keys). It must name Apple as the issuer and
// our app's bundle id as the audience (APPLE_AUDIENCES, comma-separated;
// com.schoolmule.app by default), and it must not have expired.
//
// Replay protection: the app makes a random nonce for every sign-in, gives
// Apple its SHA-256 (hex), and sends us the nonce itself. Apple copies the
// hash into the token, so a token lifted from another sign-in can't be
// replayed without the nonce that went with it.
//
// Apple shares the address only on the first authorization, and the person
// may choose "Hide My Email" (an @privaterelay.appleid.com address that
// forwards to them). Either way Apple has verified it.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../../logger');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
const KEYS_TTL_MS = 60 * 60 * 1000;
// A token signed with a key we haven't seen refetches the key set, at most this often.
const REFETCH_GAP_MS = 60 * 1000;

/**
 * The token could not be turned into a signed-in Apple identity for a reason
 * the person can retry (expired, tampered with, not for this app). Distinct
 * from Apple being unreachable, which stays a 500.
 */
class AppleSignInError extends Error {
  constructor(message = 'Sign in with Apple failed. Please try again.') {
    super(message);
    this.name = 'AppleSignInError';
  }
}

let keys = new Map();
let fetchedAt = 0;

async function loadKeys() {
  const res = await fetch(APPLE_KEYS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Apple's signing keys answered ${res.status}`);
  const { keys: jwks = [] } = await res.json();
  const next = new Map();
  for (const jwk of jwks) {
    try {
      next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // One key we can't read doesn't cost us the others.
    }
  }
  keys = next;
}

async function keyFor(kid) {
  const age = Date.now() - fetchedAt;
  if (age > KEYS_TTL_MS || (!keys.has(kid) && age > REFETCH_GAP_MS)) {
    try {
      await loadKeys();
      fetchedAt = Date.now();
    } catch (error) {
      // Apple unreachable: keys we already have still verify; try again in a minute.
      if (!keys.size) throw error;
      logger.warn({ err: error.message }, "Couldn't refresh Apple's signing keys; using the cached ones");
      fetchedAt = Date.now() - KEYS_TTL_MS + REFETCH_GAP_MS;
    }
  }
  return keys.get(kid) || null;
}

const audiences = () =>
  (process.env.APPLE_AUDIENCES || 'com.schoolmule.app').split(',').map((a) => a.trim()).filter(Boolean);

const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Apple sends these booleans as either true or "true".
const truthy = (v) => v === true || v === 'true';

/**
 * Verifies an identity token from the app.
 *
 * @param {string} identityToken the JWT from AppleAuthentication.signInAsync
 * @param {string} nonce the raw nonce the app made (Apple got its SHA-256)
 * @returns {Promise<{ sub: string, email: string|null, emailVerified: boolean, privateEmail: boolean }>}
 */
async function verifyIdentityToken(identityToken, nonce) {
  if (typeof identityToken !== 'string' || !identityToken || typeof nonce !== 'string' || nonce.length < 16) {
    throw new AppleSignInError();
  }
  const header = jwt.decode(identityToken, { complete: true })?.header;
  if (!header?.kid || header.alg !== 'RS256') throw new AppleSignInError();

  const key = await keyFor(header.kid);
  if (!key) throw new AppleSignInError();

  let payload;
  try {
    payload = jwt.verify(identityToken, key, { algorithms: ['RS256'], issuer: APPLE_ISSUER, audience: audiences() });
  } catch {
    throw new AppleSignInError();
  }
  if (!payload.sub || payload.nonce !== sha256Hex(nonce)) throw new AppleSignInError();

  const email = typeof payload.email === 'string' && payload.email ? payload.email : null;
  return {
    sub: payload.sub,
    email,
    emailVerified: Boolean(email) && truthy(payload.email_verified),
    privateEmail: truthy(payload.is_private_email) || Boolean(email && /@privaterelay\.appleid\.com$/i.test(email)),
  };
}

/** Forget the cached keys (tests). */
function resetKeys() {
  keys = new Map();
  fetchedAt = 0;
}

module.exports = { verifyIdentityToken, AppleSignInError, sha256Hex, resetKeys };
