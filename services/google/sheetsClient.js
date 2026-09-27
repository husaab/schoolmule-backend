// services/google/sheetsClient.js
//
// Thin wrapper over the Google Sheets and Drive APIs. Deliberately mechanical:
// all the decision-making lives in sheetReconciler, so this module can stay a
// direct translation of a plan into API calls.

/** Converts a 0-based column index to a spreadsheet letter: 0 → A, 26 → AA. */
function columnLetter(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** A1 range covering only our owned block on one row (1-based row number). */
function rowRange(tabName, rowIndex, width) {
  return `'${tabName.replace(/'/g, "''")}'!A${rowIndex + 1}:${columnLetter(width - 1)}${rowIndex + 1}`;
}

/** A1 range covering the whole owned block. Bounded by width, which is what
 *  keeps the school's columns out of every read and write. */
function blockRange(tabName, width) {
  return `'${tabName.replace(/'/g, "''")}'!A:${columnLetter(width - 1)}`;
}

// Lazy for the same reason as googleAuth: keep the ~230ms googleapis load off
// every test suite and off boot.
// eslint-disable-next-line global-require
const googleApi = () => require('googleapis').google;

const sheetsApi = (auth) => googleApi().sheets({ version: 'v4', auth });
const driveApi = (auth) => googleApi().drive({ version: 'v3', auth });

/** Reads the tab's current owned-block values as a grid. */
async function readGrid(auth, { spreadsheetId, tabName, width }) {
  const { data } = await sheetsApi(auth).spreadsheets.values.get({
    spreadsheetId,
    range: blockRange(tabName, width),
    majorDimension: 'ROWS',
  });
  return data.values || [];
}

/** Spreadsheet title plus its tabs, used to resolve or create the form's tab. */
async function getSpreadsheetMeta(auth, spreadsheetId) {
  const { data } = await sheetsApi(auth).spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties(sheetId,title,gridProperties)',
  });
  return {
    title: data.properties?.title || '',
    tabs: (data.sheets || []).map((s) => ({
      sheetId: s.properties.sheetId,
      title: s.properties.title,
      columnCount: s.properties.gridProperties?.columnCount || 0,
    })),
  };
}

/** Creates a spreadsheet owned by the connected account. Accessible to us under
 *  drive.file precisely because we created it. `firstTabTitle` names the tab
 *  Google creates anyway, so a sheet we lay out ourselves never starts with a
 *  stray "Sheet1". */
async function createSpreadsheet(auth, title, { firstTabTitle } = {}) {
  const requestBody = { properties: { title } };
  if (firstTabTitle) requestBody.sheets = [{ properties: { title: firstTabTitle } }];
  const { data } = await sheetsApi(auth).spreadsheets.create({
    requestBody,
    fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title)',
  });
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties.title,
    firstTab: {
      sheetId: data.sheets[0].properties.sheetId,
      title: data.sheets[0].properties.title,
    },
  };
}

/** Adds a tab, or returns the existing one when the title is already taken. */
async function addTab(auth, spreadsheetId, title) {
  const meta = await getSpreadsheetMeta(auth, spreadsheetId);
  const existing = meta.tabs.find((t) => t.title === title);
  if (existing) return { sheetId: existing.sheetId, title: existing.title };

  const { data } = await sheetsApi(auth).spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  const props = data.replies[0].addSheet.properties;
  return { sheetId: props.sheetId, title: props.title };
}

/**
 * Makes sure every wanted tab exists, in one batch: a tab found under one of
 * its `legacyTitles` is renamed in place, anything else missing is created.
 * Titles in `pinFirst` are created at index 0 (leftmost); everything else is
 * appended in the order given. Existing tabs are never moved.
 *
 * @param wanted  Array<string | { title, legacyTitles? }>
 * @returns Map<title, {sheetId, title}>
 */
async function ensureTabs(auth, spreadsheetId, wanted, { pinFirst = [] } = {}) {
  const meta = await getSpreadsheetMeta(auth, spreadsheetId);
  const byTitle = new Map(meta.tabs.map((t) => [t.title, { sheetId: t.sheetId, title: t.title }]));

  const requests = [];
  for (const item of wanted) {
    const { title, legacyTitles = [] } = typeof item === 'string' ? { title: item } : item;
    if (byTitle.has(title)) continue;

    const old = legacyTitles.find((t) => byTitle.has(t));
    if (old) {
      const { sheetId } = byTitle.get(old);
      requests.push({ updateSheetProperties: { properties: { sheetId, title }, fields: 'title' } });
      byTitle.delete(old);
      byTitle.set(title, { sheetId, title });
      continue;
    }

    requests.push({
      addSheet: { properties: pinFirst.includes(title) ? { title, index: 0 } : { title } },
    });
  }

  if (requests.length > 0) {
    const { data } = await sheetsApi(auth).spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
    for (const reply of data.replies || []) {
      if (!reply.addSheet) continue;
      const props = reply.addSheet.properties;
      byTitle.set(props.title, { sheetId: props.sheetId, title: props.title });
    }
  }
  return byTitle;
}

/** One batchUpdate of arbitrary requests (formatting, dimensions, …). */
async function applyRequests(auth, spreadsheetId, requests) {
  if (requests.length === 0) return { requests: 0 };
  await sheetsApi(auth).spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return { requests: requests.length };
}

/** Reads several tabs' owned blocks in one call. Same order as `tabs`. */
async function readGrids(auth, { spreadsheetId, tabs }) {
  if (tabs.length === 0) return [];
  const { data } = await sheetsApi(auth).spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: tabs.map((t) => blockRange(t.tabName, t.width)),
    majorDimension: 'ROWS',
  });
  return tabs.map((_, i) => data.valueRanges?.[i]?.values || []);
}

/** Confirms we can still write, and returns the file's name for display. */
async function getFileName(auth, fileId) {
  const { data } = await driveApi(auth).files.get({ fileId, fields: 'name' });
  return data.name;
}

// ─── Sharing ─────────────────────────────────────────────────────────
// drive.file covers the Drive permissions of the files it grants, so a
// spreadsheet we created or the admin picked can be shared on the connected
// account's behalf — no wider scope needed.

const PERMISSION_FIELDS = 'permissions(id,type,role,emailAddress,displayName)';

/** Everyone the file is shared with, owner included. */
async function listPermissions(auth, fileId) {
  const { data } = await driveApi(auth).permissions.list({ fileId, fields: PERMISSION_FIELDS });
  return (data.permissions || []).map((p) => ({
    id: p.id,
    type: p.type,
    role: p.role,
    email: p.emailAddress || null,
    displayName: p.displayName || null,
  }));
}

/** Shares the file with one person. Google sends its usual "shared with you" email. */
async function sharePermission(auth, fileId, { email, role }) {
  const { data } = await driveApi(auth).permissions.create({
    fileId,
    sendNotificationEmail: true,
    fields: 'id,type,role,emailAddress,displayName',
    requestBody: { type: 'user', role, emailAddress: email },
  });
  return {
    id: data.id,
    type: data.type,
    role: data.role,
    email: data.emailAddress || email,
    displayName: data.displayName || null,
  };
}

async function removePermission(auth, fileId, permissionId) {
  await driveApi(auth).permissions.delete({ fileId, permissionId });
}

/**
 * Applies reconciler plans for one or more tabs of a spreadsheet: one
 * batchUpdate for every column insert, then one values.batchUpdate for every
 * cell write, whichever tab they belong to.
 *
 * Order matters: a column insert must land before any value write, or the
 * values go into the wrong columns.
 *
 * @param tabPlans Array<{ sheetTabId, tabName, plan }> where plan comes from
 *                 planReconcileGrid (headerWrites) or planReconcile (headerWrite).
 */
async function applyMultiTabPlan(auth, { spreadsheetId, tabPlans }) {
  const requests = [];
  const valueData = [];

  for (const { sheetTabId, tabName, plan } of tabPlans) {
    if (plan.insertColumns > 0) {
      requests.push({
        insertDimension: {
          range: {
            sheetId: sheetTabId,
            dimension: 'COLUMNS',
            // Insert immediately before the school's columns so their data
            // shifts right intact rather than being overwritten.
            startIndex: plan.ownedColumns - plan.insertColumns,
            endIndex: plan.ownedColumns,
          },
          inheritFromBefore: true,
        },
      });
    }

    const headerWrites = plan.headerWrites || (plan.headerWrite ? [plan.headerWrite] : []);
    for (const h of headerWrites) {
      valueData.push({ range: rowRange(tabName, h.rowIndex, plan.ownedColumns), values: [h.values] });
    }
    for (const u of plan.updates) {
      valueData.push({ range: rowRange(tabName, u.rowIndex, plan.ownedColumns), values: [u.values] });
    }
    plan.appends.forEach((row, i) => {
      valueData.push({
        range: rowRange(tabName, plan.appendStartRow + i, plan.ownedColumns),
        values: [row],
      });
    });
  }

  if (requests.length > 0) {
    await sheetsApi(auth).spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  if (valueData.length === 0) return { writes: 0 };

  // Values go through values.batchUpdate, which takes A1 ranges bounded to our
  // owned width — the mechanism that guarantees we never touch their columns.
  await sheetsApi(auth).spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: valueData },
  });
  return { writes: valueData.length };
}

/** Applies a single tab's plan. */
function applyPlan(auth, { spreadsheetId, sheetTabId, tabName, plan }) {
  return applyMultiTabPlan(auth, { spreadsheetId, tabPlans: [{ sheetTabId, tabName, plan }] });
}

module.exports = {
  columnLetter,
  rowRange,
  blockRange,
  readGrid,
  getSpreadsheetMeta,
  createSpreadsheet,
  addTab,
  ensureTabs,
  readGrids,
  applyRequests,
  getFileName,
  applyPlan,
  applyMultiTabPlan,
  listPermissions,
  sharePermission,
  removePermission,
};
