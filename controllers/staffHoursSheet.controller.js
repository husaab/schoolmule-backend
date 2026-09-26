// controllers/staffHoursSheet.controller.js
//
// HTTP surface for a school's staff-hours Google Sheet: linking the school to
// a spreadsheet, reporting sync state, and queueing a sync. Google account
// connection itself is shared with the forms integration and lives in
// googleSheets.controller.js.
//
// Everything is keyed by req.user.school — there is one sheet per school —
// and admin-only, matching the rest of staff attendance.

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/googleSheets.queries');
const googleAuth = require('../services/google/googleAuth');
const sheetsClient = require('../services/google/sheetsClient');
const { sheetStatusPayload } = require('./googleSheets.controller');
const { OVERVIEW_TAB } = require('../services/google/staffHoursSheetLayout');

const isAdmin = (req) => req.user.role === 'ADMIN';
const forbid = (res) => res.status(403).json({ status: 'failed', message: 'Admin access required' });

// Same shape as a form's link (minus the tab fields, which the frontend
// already treats as optional), so one UI serves both.
const toCamelLink = (row) => (row ? {
  linked: true,
  spreadsheetId: row.spreadsheet_id,
  spreadsheetName: row.spreadsheet_name,
  lastSyncedAt: row.last_synced_at,
  lastError: row.last_error,
} : { linked: false });

// GET /sheet
const getSheetLink = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);
    const school = req.user.school;

    const [{ rows: linkRows }, { rows: connRows }, { rows: jobRows }] = await Promise.all([
      db.query(queries.selectStaffHoursLink, [school]),
      db.query(queries.selectConnection, [school]),
      db.query(queries.selectJobForStaffHours, [school]),
    ]);

    return res.status(200).json({
      status: 'success',
      data: sheetStatusPayload(toCamelLink(linkRows[0]), connRows[0], jobRows[0]),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading staff hours sheet link');
    return res.status(500).json({ status: 'failed', message: 'Error loading sheet link' });
  }
};

/**
 * Links the school to a spreadsheet.
 *
 * `spreadsheetId` comes from the Google Picker or from a spreadsheet we just
 * created — both are files drive.file grants us access to. The tabs are laid
 * out by the first sync, not here; a new spreadsheet just gets its first tab
 * named Overview so it never starts with a stray "Sheet1".
 */
const linkSheet = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);
    const school = req.user.school;
    const { spreadsheetId, createNew, title } = req.body || {};

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
        auth, title || `${school} — Staff hours`, { firstTabTitle: OVERVIEW_TAB },
      );
      targetId = created.spreadsheetId;
      spreadsheetName = created.title;
    } else {
      if (!targetId) {
        return res.status(400).json({ status: 'failed', message: 'Choose a spreadsheet' });
      }
      spreadsheetName = await sheetsClient.getFileName(auth, targetId);
    }

    const { rows } = await db.query(queries.upsertStaffHoursLink, [
      school, targetId, spreadsheetName, req.user.userId || null,
    ]);

    // Populate it immediately — an empty sheet after linking looks broken.
    await db.query(queries.enqueueStaffHoursJob, [school]);

    logger.info({ school, spreadsheetId: targetId }, 'Staff hours linked to sheet');
    return res.status(200).json({ status: 'success', data: toCamelLink(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error linking staff hours sheet');
    return res.status(500).json({ status: 'failed', message: 'Error linking sheet' });
  }
};

/** Forgets the link. The spreadsheet and its contents are the school's and are
 *  never modified or deleted by us. */
const unlinkSheet = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);
    const { rows } = await db.query(queries.deleteStaffHoursLink, [req.user.school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'No linked sheet for staff hours' });
    }
    return res.status(200).json({
      status: 'success',
      message: 'Sheet unlinked. The spreadsheet itself was left untouched.',
    });
  } catch (error) {
    logger.error({ err: error }, 'Error unlinking staff hours sheet');
    return res.status(500).json({ status: 'failed', message: 'Error unlinking sheet' });
  }
};

// POST /sheet/sync
const syncNow = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);
    const school = req.user.school;

    const { rows: linkRows } = await db.query(queries.selectStaffHoursLink, [school]);
    if (linkRows.length === 0) {
      return res.status(400).json({ status: 'failed', message: 'No sheet linked for staff hours' });
    }

    // Coalesced by the partial unique index: pressing this twice queues once.
    await db.query(queries.enqueueStaffHoursJob, [school]);
    return res.status(200).json({ status: 'success', message: 'Sync queued', data: { queued: true } });
  } catch (error) {
    logger.error({ err: error }, 'Error queueing staff hours sync');
    return res.status(500).json({ status: 'failed', message: 'Error queueing sync' });
  }
};

module.exports = { getSheetLink, linkSheet, unlinkSheet, syncNow };
