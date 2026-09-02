// services/google/googleAuth.js
//
// OAuth for the Google Sheets integration: building the consent URL, exchanging
// the code, and handing out authorized clients for background syncing.
//
// Drive access is deliberately just `drive.file` — the specific files the user
// picks or that we create, and nothing else in their Drive. Every scope we ask
// for is non-sensitive, which is what lets the app be published without
// sensitive-scope verification.

const { google } = require('googleapis');
const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/googleSheets.queries');
const { encryptToken, decryptToken } = require('../../utils/tokenCrypto');

// drive.file  — the specific files the user picks or that we create.
// openid + userinfo.email — only to record which Google account connected, so
// the UI can show "Connected as …". All three are non-sensitive scopes, so the
// app stays out of sensitive-scope verification. Never add `spreadsheets`.
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.file',
];

/**
 * Raised when Google says the stored grant is dead — revoked by the user,
 * expired, or the account removed.
 *
 * Distinct from a transient failure on purpose: retrying cannot revive a dead
 * grant, so callers stop rather than burning backoff attempts, and the UI asks
 * the school to reconnect.
 */
class NeedsReconnectError extends Error {
  constructor(message = 'Google access needs to be reconnected') {
    super(message);
    this.name = 'NeedsReconnectError';
    this.needsReconnect = true;
  }
}

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

/**
 * The consent URL to send an admin to.
 *
 * `access_type: 'offline'` is what asks for a refresh token at all, and
 * `prompt: 'consent'` forces Google to issue a new one even on re-consent —
 * without it a reconnect returns only an access token and the integration
 * silently becomes single-session.
 */
function buildAuthUrl({ nonce }) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    include_granted_scopes: true,
    state: nonce,
  });
}

/** Exchanges the callback code for a refresh token and the account's email. */
async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    // Almost always means prompt=consent was dropped from the auth URL.
    throw new Error('Google did not return a refresh token — re-authorize with prompt=consent');
  }

  client.setCredentials(tokens);
  const { data } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

  return { refreshToken: tokens.refresh_token, email: data.email };
}

/** Stores (or replaces) a school's connection. The token is encrypted at rest. */
async function saveConnection({ school, email, refreshToken, userId }) {
  const { rows } = await db.query(queries.upsertConnection, [
    school, email, encryptToken(refreshToken), userId || null,
  ]);
  return rows[0];
}

// Google reports a dead grant as `invalid_grant`, but where that string appears
// varies by failure mode, so check the places it can surface.
function isInvalidGrant(error) {
  const direct = error?.response?.data?.error || error?.data?.error || '';
  return direct === 'invalid_grant' || /invalid_grant/i.test(error?.message || '');
}

/**
 * An OAuth2 client authorized for a school's Google account, ready to pass to
 * the Sheets API.
 *
 * @throws NeedsReconnectError when the school has never connected, has been
 *         flagged for reconnect, or the grant has since been revoked.
 */
async function getAuthorizedClient(school) {
  const { rows } = await db.query(queries.selectConnection, [school]);
  const connection = rows[0];

  if (!connection) throw new NeedsReconnectError('No Google account connected for this school');
  if (connection.status === 'needs_reconnect') throw new NeedsReconnectError();

  const client = oauthClient();
  client.setCredentials({ refresh_token: decryptToken(connection.refresh_token) });

  try {
    await client.getAccessToken();
  } catch (error) {
    if (isInvalidGrant(error)) {
      await db.query(queries.markConnectionNeedsReconnect, [school]);
      logger.warn({ school }, 'Google grant revoked; reconnect required');
      throw new NeedsReconnectError();
    }
    // Anything else (network, 5xx, rate limit) stays retryable — misreporting
    // it as a dead grant would make the school reconnect for no reason.
    throw error;
  }

  return client;
}

module.exports = {
  SCOPES,
  NeedsReconnectError,
  buildAuthUrl,
  exchangeCode,
  saveConnection,
  getAuthorizedClient,
  isInvalidGrant,
};
