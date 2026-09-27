// services/finance/qboAuth.js
//
// OAuth for QuickBooks Online: the consent URL, the code exchange, and the
// only sanctioned way to get a bearer token for a school.
//
// Intuit refresh tokens ROTATE on every use: the response carries a new one
// and the old one dies. Two processes refreshing from the same stored token
// therefore race, and the loser gets `invalid_grant` — which looks exactly
// like a revoked grant. getAccessToken() serializes refreshes with a row lock
// held across the HTTP call, and persists the rotated token before COMMIT.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/finance.queries');
const { createTokenCrypto } = require('../../utils/tokenCrypto');
const { NeedsReconnectError, QboApiError } = require('./errors');

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';

// Access tokens last an hour; refresh this far before expiry so an in-flight
// sync never sees a token die mid-page.
const EXPIRY_MARGIN_S = 120;
const FRESH_MARGIN_MS = 90 * 1000;
const TOKEN_TIMEOUT_MS = 15 * 1000;

const tokenCrypto = createTokenCrypto('QBO_TOKEN_ENC_KEY');

function oauthConfig() {
  const { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI } = process.env;
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REDIRECT_URI) {
    throw new Error('QuickBooks OAuth is not configured (QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_REDIRECT_URI)');
  }
  return { clientId: QBO_CLIENT_ID, clientSecret: QBO_CLIENT_SECRET, redirectUri: QBO_REDIRECT_URI };
}

const basicAuth = ({ clientId, clientSecret }) => `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

/** The consent URL to send an admin to. `state` must already be signed. */
function buildAuthUrl({ state }) {
  const cfg = oauthConfig();
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function postToken(params) {
  const cfg = oauthConfig();
  const body = new URLSearchParams(params);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(cfg),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  if (res.ok && json.access_token) {
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: Number(json.expires_in) || 3600 };
  }
  if (res.status === 400 || res.status === 401) {
    const err = new QboApiError(`Intuit token endpoint refused: ${json.error || res.status}`, { status: res.status, code: json.error || null, retryable: false });
    err.invalidGrant = json.error === 'invalid_grant' || json.error === 'invalid_client';
    throw err;
  }
  throw new QboApiError(`Intuit token endpoint failed (${res.status})`, { status: res.status, retryable: true });
}

/** Exchanges the callback code for tokens. */
function exchangeCode(code) {
  const cfg = oauthConfig();
  return postToken({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri });
}

/** Stores (or replaces) a school's connection. Tokens are encrypted at rest. */
async function saveConnection({ school, realmId, companyName, tokens, userId, settings }) {
  const { rows } = await db.query(queries.upsertConnection, [
    school, String(realmId), companyName || null,
    tokenCrypto.encryptToken(tokens.refreshToken),
    tokenCrypto.encryptToken(tokens.accessToken),
    Math.max(60, (tokens.expiresIn || 3600) - EXPIRY_MARGIN_S),
    userId || null,
    settings ? JSON.stringify(settings) : null,
  ]);
  return rows[0];
}

async function markNeedsReconnect(school, client = db) {
  await client.query(queries.markConnectionNeedsReconnect, [school]);
}

function isFresh(row) {
  if (!row.access_token || !row.access_token_expires_at) return false;
  return new Date(row.access_token_expires_at).getTime() - Date.now() > FRESH_MARGIN_MS;
}

function decryptOrFlag(school, ciphertext, client) {
  try {
    return tokenCrypto.decryptToken(ciphertext);
  } catch (error) {
    // A missing or malformed key is a deployment problem, not a dead grant:
    // flagging every school for reconnect would be wrong and noisy.
    if (/QBO_TOKEN_ENC_KEY/.test(error.message)) throw error;
    // Otherwise the key changed. Same remedy as a revoked grant.
    logger.error({ school, err: error.message }, 'Stored QuickBooks token could not be decrypted; reconnect required');
    return null;
  }
}

/**
 * A valid bearer token for the school, refreshing (under a row lock) when needed.
 * @throws NeedsReconnectError when the school has no usable grant.
 */
async function getAccessToken(school, { force = false } = {}) {
  const { rows } = await db.query(queries.selectConnection, [school]);
  const row = rows[0];
  if (!row) throw new NeedsReconnectError('QuickBooks is not connected for this school');
  if (row.status !== 'active') throw new NeedsReconnectError();

  if (!force && isFresh(row)) {
    const token = decryptOrFlag(school, row.access_token);
    if (token !== null) return token;
    await markNeedsReconnect(school);
    throw new NeedsReconnectError();
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = (await client.query(queries.selectConnectionForUpdate, [school])).rows[0];
    if (!locked || locked.status !== 'active') {
      await client.query('COMMIT');
      throw new NeedsReconnectError();
    }
    // Someone else may have refreshed while we waited for the lock.
    if (!force && isFresh(locked)) {
      const token = decryptOrFlag(school, locked.access_token);
      await client.query('COMMIT');
      if (token !== null) return token;
      await markNeedsReconnect(school);
      throw new NeedsReconnectError();
    }

    const refreshToken = locked.refresh_token ? decryptOrFlag(school, locked.refresh_token, client) : null;
    if (refreshToken === null) {
      await markNeedsReconnect(school, client);
      await client.query('COMMIT');
      throw new NeedsReconnectError();
    }

    let tokens;
    try {
      tokens = await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    } catch (error) {
      if (error.invalidGrant) {
        await markNeedsReconnect(school, client);
        await client.query('COMMIT');
        logger.warn({ school }, 'QuickBooks grant revoked; reconnect required');
        throw new NeedsReconnectError();
      }
      // Network / 5xx: leave the stored token alone so the next attempt can retry.
      await client.query('ROLLBACK');
      throw error;
    }

    const { rowCount } = await client.query(queries.updateTokens, [
      school,
      tokenCrypto.encryptToken(tokens.refreshToken || refreshToken),
      tokenCrypto.encryptToken(tokens.accessToken),
      Math.max(60, tokens.expiresIn - EXPIRY_MARGIN_S),
      locked.refresh_token_version,
    ]);
    if (rowCount === 0) {
      // Should be unreachable under the row lock; if it happens the rotated
      // token would be lost, which is exactly the failure this module exists to prevent.
      logger.error({ school, version: locked.refresh_token_version }, 'QuickBooks token version guard rejected the update');
    }
    await client.query('COMMIT');
    return tokens.accessToken;
  } catch (error) {
    if (!(error instanceof NeedsReconnectError) && !(error instanceof QboApiError)) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Best-effort revoke of a refresh token at Intuit. Never throws. */
async function revokeToken(refreshToken, context = {}) {
  if (!refreshToken) return false;
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { Authorization: basicAuth(oauthConfig()), Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    return true;
  } catch (error) {
    logger.warn({ ...context, err: error.message }, 'QuickBooks token revoke failed');
    return false;
  }
}

/** Revoke the stored grant (best effort), then drop it locally. */
async function disconnect(school, { revoke = true } = {}) {
  if (revoke) {
    try {
      const { rows } = await db.query(queries.selectConnection, [school]);
      const row = rows[0];
      const rt = row?.refresh_token ? decryptOrFlag(school, row.refresh_token) : null;
      await revokeToken(rt, { school });
    } catch (error) {
      logger.warn({ school, err: error.message }, 'QuickBooks token revoke skipped; continuing with local disconnect');
    }
  }
  const { rows } = await db.query(queries.disconnectConnection, [school]);
  return rows[0] || null;
}

module.exports = {
  SCOPE,
  NeedsReconnectError,
  buildAuthUrl,
  exchangeCode,
  saveConnection,
  getAccessToken,
  markNeedsReconnect,
  revokeToken,
  disconnect,
  tokenCrypto,
};
