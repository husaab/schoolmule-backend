// controllers/sheetSharing.controller.js
//
// Sharing a linked Google Sheet with other people: list who has access, add
// someone as a viewer or editor, remove someone. The Drive permissions are
// the connected Google account's own — we act on its behalf under the same
// drive.file grant the sync uses.
//
// One set of handlers serves both a form's sheet and the school's staff-hours
// sheet; the caller supplies how to find the spreadsheet for a request.

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/googleSheets.queries');
const googleAuth = require('../services/google/googleAuth');
const sheetsClient = require('../services/google/sheetsClient');

// Google's role names; the UI says Viewer / Editor.
const ROLES = ['reader', 'writer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (res, code, message, extra = {}) =>
  res.status(code).json({ status: 'failed', message, ...extra });

/** Google's own reasons a share can fail, turned into something an admin can act on. */
const explainDriveError = (error) => {
  const status = error?.code || error?.response?.status;
  if (status === 403) return [403, "Only the sheet's owner or an editor can change who it is shared with"];
  if (status === 404) return [404, 'The spreadsheet could not be found — it may have been deleted or the link removed'];
  return null;
};

/**
 * @param resolveSpreadsheet async (req) → { spreadsheetId, googleEmail } | null
 *        null means "nothing linked" and yields a 404. googleEmail is the
 *        connected account, which is never removable from its own file.
 */
const makeShareHandlers = (resolveSpreadsheet) => {
  const withSheet = async (req, res, run) => {
    try {
      const sheet = await resolveSpreadsheet(req);
      if (!sheet) return fail(res, 404, 'No linked sheet');

      let auth;
      try {
        auth = await googleAuth.getAuthorizedClient(req.user.school);
      } catch (error) {
        if (error.needsReconnect) {
          return fail(res, 409, 'Connect a Google account first', { code: 'NEEDS_RECONNECT' });
        }
        throw error;
      }

      try {
        return await run(auth, sheet);
      } catch (error) {
        const explained = explainDriveError(error);
        if (explained) return fail(res, explained[0], explained[1]);
        throw error;
      }
    } catch (error) {
      logger.error({ err: error }, 'Sheet sharing request failed');
      return fail(res, 500, 'Could not update sharing');
    }
  };

  const shape = (permission, connectedEmail) => ({
    ...permission,
    isOwner: permission.role === 'owner',
    // The connected account keeps its access: removing it would cut off the sync.
    isConnectedAccount: !!permission.email && permission.email.toLowerCase() === String(connectedEmail || '').toLowerCase(),
  });

  const listShares = (req, res) => withSheet(req, res, async (auth, sheet) => {
    const permissions = await sheetsClient.listPermissions(auth, sheet.spreadsheetId);
    return res.status(200).json({
      status: 'success',
      data: { shares: permissions.map((p) => shape(p, sheet.googleEmail)) },
    });
  });

  const addShare = (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'writer');
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'Enter a valid email address');
    if (!ROLES.includes(role)) return fail(res, 400, 'role must be reader or writer');

    return withSheet(req, res, async (auth, sheet) => {
      const permission = await sheetsClient.sharePermission(auth, sheet.spreadsheetId, { email, role });
      logger.info({ school: req.user.school, spreadsheetId: sheet.spreadsheetId, role }, 'Sheet shared');
      return res.status(200).json({ status: 'success', data: { share: shape(permission, sheet.googleEmail) } });
    });
  };

  const removeShare = (req, res) => withSheet(req, res, async (auth, sheet) => {
    const { permissionId } = req.params;
    const current = await sheetsClient.listPermissions(auth, sheet.spreadsheetId);
    const target = current.find((p) => p.id === permissionId);
    if (!target) return fail(res, 404, 'That person no longer has access');
    if (target.role === 'owner') return fail(res, 400, "The sheet's owner cannot be removed");
    if (shape(target, sheet.googleEmail).isConnectedAccount) {
      return fail(res, 400, 'The connected Google account keeps its access — removing it would stop the sync');
    }

    await sheetsClient.removePermission(auth, sheet.spreadsheetId, permissionId);
    logger.info({ school: req.user.school, spreadsheetId: sheet.spreadsheetId }, 'Sheet share removed');
    return res.status(200).json({ status: 'success', data: { removed: true } });
  });

  return { listShares, addShare, removeShare };
};

/** The school's connected Google account email, for marking its own permission. */
const connectedEmail = async (school) => {
  const { rows } = await db.query(queries.selectConnection, [school]);
  return rows[0]?.google_email || null;
};

module.exports = { makeShareHandlers, connectedEmail, ROLES };
