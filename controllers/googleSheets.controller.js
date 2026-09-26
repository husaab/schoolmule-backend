// controllers/googleSheets.controller.js
//
// HTTP surface for the Google Sheets integration: connecting a Google account,
// linking a form to a spreadsheet tab, and reporting sync state.

const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/googleSheets.queries');
const registrationQueries = require('../queries/registration.queries');
const googleAuth = require('../services/google/googleAuth');
const sheetsClient = require('../services/google/sheetsClient');
const { buildHeaderRow } = require('../services/google/sheetReconciler');
const { makeShareHandlers, connectedEmail } = require('./sheetSharing.controller');

// ─── OAuth state nonce ────────────────────────────────────────────────
// The `state` parameter must survive the round trip to Google and prove the
// callback belongs to the school that started it. Signing it with the app's
// JWT secret avoids adding a session store for a value that lives ~60 seconds.

const STATE_TTL_MS = 10 * 60 * 1000;

// Where the browser lands after Google's callback. An allowlist rather than a
// free-form URL: the value rides through Google in the state parameter, and
// an open redirect there would be an easy phishing hop.
const RETURN_PATHS = ['/admin-panel/forms/submissions', '/staff-attendance'];
const safeReturnTo = (path) => (RETURN_PATHS.includes(path) ? path : RETURN_PATHS[0]);

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.iat || Date.now() - payload.iat > STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Shaping ──────────────────────────────────────────────────────────

// Note the refresh token is never included — it must not leave the server.
const toCamelConnection = (row) => (row ? {
  connected: true,
  googleEmail: row.google_email,
  status: row.status,
  connectedAt: row.connected_at,
} : { connected: false, googleEmail: null, status: null, connectedAt: null });

const toCamelLink = (row) => (row ? {
  linked: true,
  spreadsheetId: row.spreadsheet_id,
  spreadsheetName: row.spreadsheet_name,
  sheetTabId: row.sheet_tab_id,
  sheetTabName: row.sheet_tab_name,
  ownedColumns: row.owned_columns,
  lastSyncedAt: row.last_synced_at,
  lastError: row.last_error,
} : { linked: false });

/** The link, the school's connection, and the state of its latest job, as one payload. */
const sheetStatusPayload = (link, connRow, jobRow) => ({
  ...link,
  connection: toCamelConnection(connRow),
  pendingSync: jobRow ? jobRow.state !== 'failed' : false,
  jobError: jobRow?.state === 'failed' ? jobRow.last_error : null,
});

async function loadForm(formId, school) {
  const { rows } = await db.query(registrationQueries.selectFormById, [formId, school]);
  return rows[0] || null;
}

// ─── Connection ───────────────────────────────────────────────────────

const getConnectionStatus = async (req, res) => {
  try {
    const { rows } = await db.query(queries.selectConnection, [req.user.school]);
    return res.status(200).json({ status: 'success', data: toCamelConnection(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error loading Google connection');
    return res.status(500).json({ status: 'failed', message: 'Error loading Google connection' });
  }
};

/**
 * Returns the consent URL for the frontend to navigate to.
 *
 * Deliberately JSON rather than a redirect: a redirect would be a top-level
 * browser navigation carrying no Authorization header, so the server could not
 * tell which school was connecting. Handing the URL back to an authenticated
 * caller lets the school be baked into the signed state up front.
 */
const getAuthUrl = async (req, res) => {
  try {
    const url = googleAuth.buildAuthUrl({
      nonce: signState({
        school: req.user.school,
        userId: req.user.userId,
        returnTo: safeReturnTo(req.query.returnTo),
        iat: Date.now(),
      }),
    });
    return res.status(200).json({ status: 'success', data: { url } });
  } catch (error) {
    logger.error({ err: error }, 'Error building Google auth URL');
    return res.status(500).json({ status: 'failed', message: error.message });
  }
};

/**
 * Google's callback.
 *
 * Unauthenticated by necessity — Google sends the browser here with no JWT — so
 * the school is recovered from the HMAC-signed state issued by getAuthUrl. It
 * ends in a redirect back into the app rather than returning JSON.
 */
const oauthCallback = async (req, res) => {
  const appUrl = process.env.FRONTEND_URL || '';
  // Verified before anything else so even a declined consent returns the
  // admin to the page they started from.
  const state = verifyState(req.query.state);
  const back = (params) => res.redirect(`${appUrl}${safeReturnTo(state?.returnTo)}?${params}`);

  try {
    if (req.query.error) return back(`google=denied`);

    // The school comes from the signed state, never from a query parameter, so
    // a forged callback cannot attach a Google account to another tenant.
    if (!state) return back('google=invalid_state');
    if (!req.query.code) return back('google=missing_code');

    const { refreshToken, email } = await googleAuth.exchangeCode(req.query.code);
    await googleAuth.saveConnection({
      school: state.school, email, refreshToken, userId: state.userId,
    });

    logger.info({ school: state.school, email }, 'Google account connected');
    return back('google=connected');
  } catch (error) {
    logger.error({ err: error }, 'Google OAuth callback failed');
    return back('google=error');
  }
};

const disconnect = async (req, res) => {
  try {
    await db.query(queries.deleteConnection, [req.user.school]);
    logger.info({ school: req.user.school }, 'Google account disconnected');
    return res.status(200).json({ status: 'success', message: 'Google account disconnected' });
  } catch (error) {
    logger.error({ err: error }, 'Error disconnecting Google');
    return res.status(500).json({ status: 'failed', message: 'Error disconnecting Google' });
  }
};

// ─── Form ↔ sheet link ────────────────────────────────────────────────

const getSheetLink = async (req, res) => {
  try {
    const school = req.user.school;
    const form = await loadForm(req.params.formId, school);
    if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });

    const [{ rows: linkRows }, { rows: connRows }, { rows: jobRows }] = await Promise.all([
      db.query(queries.selectLinkByForm, [req.params.formId, school]),
      db.query(queries.selectConnection, [school]),
      db.query(queries.selectJobForForm, [req.params.formId]),
    ]);

    return res.status(200).json({
      status: 'success',
      data: sheetStatusPayload(toCamelLink(linkRows[0]), connRows[0], jobRows[0]),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading sheet link');
    return res.status(500).json({ status: 'failed', message: 'Error loading sheet link' });
  }
};

/**
 * Links a form to a spreadsheet tab.
 *
 * `spreadsheetId` comes from the Google Picker or from a spreadsheet we just
 * created — both are files drive.file grants us access to. A tab named after
 * the form is created if it doesn't exist, which is what keeps two forms in one
 * spreadsheet from overwriting each other.
 */
const linkSheet = async (req, res) => {
  try {
    const school = req.user.school;
    const { formId } = req.params;
    const { spreadsheetId, createNew, title } = req.body || {};

    const form = await loadForm(formId, school);
    if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });

    let auth;
    try {
      auth = await googleAuth.getAuthorizedClient(school);
    } catch (error) {
      if (error.needsReconnect) {
        return res.status(409).json({
          status: 'failed', code: 'NEEDS_RECONNECT',
          message: 'Connect a Google account first',
        });
      }
      throw error;
    }

    let targetId = spreadsheetId;
    let spreadsheetName = null;

    if (createNew) {
      const created = await sheetsClient.createSpreadsheet(
        auth, title || `${form.title} — Submissions`,
      );
      targetId = created.spreadsheetId;
      spreadsheetName = created.title;
    } else {
      if (!targetId) {
        return res.status(400).json({ status: 'failed', message: 'Choose a spreadsheet' });
      }
      spreadsheetName = await sheetsClient.getFileName(auth, targetId);
    }

    // One tab per form. Truncated because Google caps tab titles at 100 chars.
    const tabTitle = form.title.slice(0, 90);
    const tab = await sheetsClient.addTab(auth, targetId, tabTitle);

    const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);
    const ownedColumns = buildHeaderRow(fields).length;

    const { rows } = await db.query(queries.upsertLink, [
      formId, targetId, spreadsheetName, tab.sheetId, tab.title, ownedColumns,
    ]);

    // Populate it immediately — an empty sheet after linking looks broken.
    await db.query(queries.enqueueJob, [formId]);

    logger.info({ formId, school, spreadsheetId: targetId }, 'Form linked to sheet');
    return res.status(200).json({ status: 'success', data: toCamelLink(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error linking sheet');
    return res.status(500).json({ status: 'failed', message: 'Error linking sheet' });
  }
};

/** Forgets the link. The spreadsheet and its contents are the school's and are
 *  never modified or deleted by us. */
const unlinkSheet = async (req, res) => {
  try {
    const { rows } = await db.query(queries.deleteLink, [req.params.formId, req.user.school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'No linked sheet for this form' });
    }
    return res.status(200).json({
      status: 'success',
      message: 'Sheet unlinked. The spreadsheet itself was left untouched.',
    });
  } catch (error) {
    logger.error({ err: error }, 'Error unlinking sheet');
    return res.status(500).json({ status: 'failed', message: 'Error unlinking sheet' });
  }
};

const syncNow = async (req, res) => {
  try {
    const school = req.user.school;
    const form = await loadForm(req.params.formId, school);
    if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });

    const { rows: linkRows } = await db.query(queries.selectLinkByForm, [req.params.formId, school]);
    if (linkRows.length === 0) {
      return res.status(400).json({ status: 'failed', message: 'No sheet linked to this form' });
    }

    // Coalesced by the partial unique index: pressing this twice queues once.
    await db.query(queries.enqueueJob, [req.params.formId]);
    return res.status(200).json({ status: 'success', message: 'Sync queued', data: { queued: true } });
  } catch (error) {
    logger.error({ err: error }, 'Error queueing sync');
    return res.status(500).json({ status: 'failed', message: 'Error queueing sync' });
  }
};

// ─── Sharing ──────────────────────────────────────────────────────────

const shares = makeShareHandlers(async (req) => {
  const school = req.user.school;
  const { rows } = await db.query(queries.selectLinkByForm, [req.params.formId, school]);
  if (rows.length === 0) return null;
  return { spreadsheetId: rows[0].spreadsheet_id, googleEmail: await connectedEmail(school) };
});

module.exports = {
  toCamelConnection,
  sheetStatusPayload,
  safeReturnTo,
  listShares: shares.listShares,
  addShare: shares.addShare,
  removeShare: shares.removeShare,
  getConnectionStatus,
  getAuthUrl,
  oauthCallback,
  disconnect,
  getSheetLink,
  linkSheet,
  unlinkSheet,
  syncNow,
  signState,
  verifyState,
};
