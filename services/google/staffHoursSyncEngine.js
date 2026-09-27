// services/google/staffHoursSyncEngine.js
//
// Brings a school's staff-hours spreadsheet up to date: an Overview tab plus
// one tab per pay day from the start of the school year through the period in
// progress. Load state, lay out, plan, apply, record.
//
// Like sheetSyncEngine, this module holds no sync logic of its own —
// staffHoursSheetLayout decides what each tab should contain, sheetReconciler
// decides what to write, and sheetsClient performs it. It is the seam where
// the database, Google and those pieces meet.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/googleSheets.queries');
const schoolYearQueries = require('../../queries/schoolYear.queries');
const assembly = require('../staffAttendance/assembly');
const googleAuth = require('./googleAuth');
const sheetsClient = require('./sheetsClient');
const { planReconcileGrid } = require('./sheetReconciler');
const { buildFormatRequests } = require('./sheetFormatter');
const layout = require('./staffHoursSheetLayout');

const NOT_CONFIGURED = 'Set a pay schedule and an active school year first';

/**
 * Sync one school's staff-hours sheet.
 *
 * Returns `{ synced: false, reason }` when there is nothing to do — an
 * unlinked school is a normal state (jobs can outlive a link), and a school
 * with no pay schedule or active year cannot be laid out, so that is recorded
 * on the link rather than retried.
 *
 * Throws on a real failure so the worker can retry; a NeedsReconnectError
 * propagates untouched so the worker can stop retrying it.
 */
async function syncStaffHours(school) {
  const { rows: linkRows } = await db.query(queries.selectStaffHoursLink, [school]);
  const link = linkRows[0];
  if (!link) return { synced: false, reason: 'not_linked' };

  const [schedule, { rows: yearRows }] = await Promise.all([
    assembly.loadPaySchedule(school),
    db.query(schoolYearQueries.selectActiveYearBySchool, [school]),
  ]);
  const year = yearRows[0];
  if (!schedule || !year) {
    await db.query(queries.updateStaffHoursLinkError, [school, NOT_CONFIGURED]);
    return { synced: false, reason: 'not_configured' };
  }

  try {
    const periods = layout.periodsForYear(schedule, assembly.dateKey(year.start_date), assembly.torontoToday());
    const built = await assembly.buildPayPeriods(periods, school);
    const tabs = [layout.buildOverviewTab(built), ...built.map(layout.buildPeriodTab)];

    const auth = await googleAuth.getAuthorizedClient(school);
    const tabMeta = await sheetsClient.ensureTabs(
      auth, link.spreadsheet_id,
      tabs.map((t) => ({ title: t.title, legacyTitles: t.legacyTitles || [] })),
      { pinFirst: [layout.OVERVIEW_TAB] },
    );

    // Read (and write) at least as wide as we ever have for each tab, so a
    // block that shrank still gets its stale trailing cells blanked. A tab
    // renamed from a legacy title keeps the width stored under that title.
    const stored = link.tab_widths && typeof link.tab_widths === 'object' ? link.tab_widths : {};
    const storedWidth = (t) => {
      const key = [t.title, ...(t.legacyTitles || [])].find((k) => stored[k] !== undefined);
      return key === undefined ? undefined : Number(stored[key]);
    };
    const widths = tabs.map((t) => Math.max(t.width, storedWidth(t) || 0));

    const grids = await sheetsClient.readGrids(auth, {
      spreadsheetId: link.spreadsheet_id,
      tabs: tabs.map((t, i) => ({ tabName: t.title, width: widths[i] })),
    });

    const tabPlans = [];
    const formatRequests = [];
    let updates = 0;
    let appends = 0;
    tabs.forEach((t, i) => {
      const sheetId = tabMeta.get(t.title).sheetId;
      const previousWidth = storedWidth(t);
      const plan = planReconcileGrid({
        grid: grids[i],
        headerRows: t.headerRows,
        rows: t.rows,
        width: widths[i],
        previousWidth: previousWidth === undefined ? null : previousWidth,
        missing: t.missing,
        pinnedBottomId: t.pinnedBottomId,
      });
      // Formatting is re-applied every sync: it is idempotent, it lands in one
      // request, and it is what keeps a new person's row coloured on every tab.
      formatRequests.push(...buildFormatRequests({ sheetId, tab: t, rowIndexById: plan.rowIndexById }));
      if (plan.isNoop) return;
      updates += plan.updates.length;
      appends += plan.appends.length;
      tabPlans.push({ sheetTabId: sheetId, tabName: t.title, plan });
    });

    if (tabPlans.length > 0) {
      await sheetsClient.applyMultiTabPlan(auth, { spreadsheetId: link.spreadsheet_id, tabPlans });
    }
    // After the values, so column inserts have already shifted everything.
    await sheetsClient.applyRequests(auth, link.spreadsheet_id, formatRequests);

    const widthsByTitle = Object.fromEntries(tabs.map((t, i) => [t.title, widths[i]]));
    await db.query(queries.updateStaffHoursLinkSynced, [school, JSON.stringify(widthsByTitle)]);

    logger.info({ school, tabs: tabs.length, updates, appends }, 'Staff hours sheet synced');
    return { synced: true, tabs: tabs.length, updates, appends };
  } catch (error) {
    // Record the reason so the UI can explain a stale sheet instead of the
    // school discovering the drift themselves.
    await db.query(queries.updateStaffHoursLinkError, [school, String(error.message || error)]).catch(() => {});
    throw error;
  }
}

module.exports = { syncStaffHours, NOT_CONFIGURED };
