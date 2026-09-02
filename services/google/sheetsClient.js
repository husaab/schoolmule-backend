// services/google/sheetsClient.js
//
// Thin wrapper over the Google Sheets and Drive APIs. Deliberately mechanical:
// all the decision-making lives in sheetReconciler, so this module can stay a
// direct translation of a plan into API calls.

const { google } = require('googleapis');

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

const sheetsApi = (auth) => google.sheets({ version: 'v4', auth });
const driveApi = (auth) => google.drive({ version: 'v3', auth });

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
 *  drive.file precisely because we created it. */
async function createSpreadsheet(auth, title) {
  const { data } = await sheetsApi(auth).spreadsheets.create({
    requestBody: { properties: { title } },
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

/** Confirms we can still write, and returns the file's name for display. */
async function getFileName(auth, fileId) {
  const { data } = await driveApi(auth).files.get({ fileId, fields: 'name' });
  return data.name;
}

/**
 * Applies a reconciler plan in a single batch.
 *
 * Order matters: a column insert must land before any value write, or the
 * values go into the wrong columns.
 */
async function applyPlan(auth, { spreadsheetId, sheetTabId, tabName, plan }) {
  const requests = [];

  if (plan.insertColumns > 0) {
    requests.push({
      insertDimension: {
        range: {
          sheetId: sheetTabId,
          dimension: 'COLUMNS',
          // Insert immediately before the school's columns so their data shifts
          // right intact rather than being overwritten.
          startIndex: plan.ownedColumns - plan.insertColumns,
          endIndex: plan.ownedColumns,
        },
        inheritFromBefore: true,
      },
    });
  }

  if (requests.length > 0) {
    await sheetsApi(auth).spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }

  // Values go through values.batchUpdate, which takes A1 ranges bounded to our
  // owned width — the mechanism that guarantees we never touch their columns.
  const valueData = [];
  if (plan.headerWrite) {
    valueData.push({
      range: rowRange(tabName, plan.headerWrite.rowIndex, plan.ownedColumns),
      values: [plan.headerWrite.values],
    });
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

  if (valueData.length === 0) return { writes: 0 };

  await sheetsApi(auth).spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: valueData },
  });
  return { writes: valueData.length };
}

module.exports = {
  columnLetter,
  rowRange,
  blockRange,
  readGrid,
  getSpreadsheetMeta,
  createSpreadsheet,
  addTab,
  getFileName,
  applyPlan,
};
