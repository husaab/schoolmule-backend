// services/google/sheetSyncEngine.js
//
// Brings one form's sheet tab up to date: load state, plan, apply, record.
//
// The engine holds no sync logic of its own — sheetReconciler decides what to
// write and sheetsClient performs it. This module is the seam where the
// database, Google, and those two pure-ish pieces meet.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/googleSheets.queries');
const registrationQueries = require('../../queries/registration.queries');
const googleAuth = require('./googleAuth');
const sheetsClient = require('./sheetsClient');
const { planReconcile, buildHeaderRow } = require('./sheetReconciler');

/**
 * Sync one form to its linked tab.
 *
 * Returns `{ synced: false, reason }` when there is nothing to do — an unlinked
 * form is a normal state, not an error, since jobs can outlive a link.
 *
 * Throws on a real failure so the worker can retry; a NeedsReconnectError
 * propagates untouched so the worker can stop retrying it.
 */
async function syncForm(formId) {
  const { rows: linkRows } = await db.query(queries.selectLinkByFormUnscoped, [formId]);
  const link = linkRows[0];
  if (!link) return { synced: false, reason: 'not_linked' };

  const school = link.school;

  const [{ rows: fields }, { rows: submissions }] = await Promise.all([
    db.query(registrationQueries.selectFieldsByFormId, [formId]),
    db.query(queries.selectSubmissionsForSync, [formId, school]),
  ]);

  const width = buildHeaderRow(fields).length;

  try {
    const auth = await googleAuth.getAuthorizedClient(school);

    const grid = await sheetsClient.readGrid(auth, {
      spreadsheetId: link.spreadsheet_id,
      tabName: link.sheet_tab_name,
      width,
    });

    const plan = planReconcile({ grid, submissions, fields });

    if (!plan.isNoop) {
      await sheetsClient.applyPlan(auth, {
        spreadsheetId: link.spreadsheet_id,
        sheetTabId: link.sheet_tab_id,
        tabName: link.sheet_tab_name,
        plan,
      });
    }

    await db.query(queries.updateLinkSynced, [formId, plan.ownedColumns]);
    logger.info(
      { formId, school, updates: plan.updates.length, appends: plan.appends.length },
      'Sheet synced',
    );

    return {
      synced: true,
      rows: submissions.length,
      updates: plan.updates.length,
      appends: plan.appends.length,
    };
  } catch (error) {
    // Record the reason so the UI can explain a stale sheet instead of the
    // school discovering the drift themselves.
    await db.query(queries.updateLinkError, [formId, String(error.message || error)]).catch(() => {});
    throw error;
  }
}

module.exports = { syncForm };
