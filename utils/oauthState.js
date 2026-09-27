// utils/oauthState.js
//
// The OAuth `state` parameter has to survive a round trip through a third
// party (Google, Intuit) and prove on return that the callback belongs to the
// school that started it. Signing it with the app's JWT secret avoids adding a
// session store for a value that lives about a minute.

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;

const secret = () => {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return process.env.JWT_SECRET;
};

/** Signs a JSON payload (which must carry `iat` in ms) → `body.sig`, base64url. */
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * The payload if the signature checks out, it is younger than ttlMs, and (when
 * `purpose` is given) it was minted for that purpose; else null. The purpose
 * binding is what stops one integration's state from completing another's
 * callback.
 */
function verifyState(state, { ttlMs = DEFAULT_TTL_MS, purpose } = {}) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.iat || Date.now() - payload.iat > ttlMs) return null;
    if (purpose !== undefined && payload.purpose !== purpose) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { signState, verifyState, DEFAULT_TTL_MS };
