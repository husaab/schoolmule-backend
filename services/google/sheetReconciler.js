// services/google/sheetReconciler.js
//
// Works out what to write into a sheet tab we own a block of.
//
// Pure and dependency-free: given what is currently in the sheet and what
// should be there, it returns a list of writes. No Google calls, no database.
// Every edge case a real sheet throws at us — a school re-sorting rows, adding
// their own columns, pasting a row by hand — is therefore cheap to test.
//
// Two invariants the whole design rests on:
//
//   1. Column 0 holds the row's ID. That is what lets a row be found again
//      after the school sorts or filters the sheet: the ID travels with the
//      row. A row with a blank ID is the school's own and is never touched.
//
//   2. We only ever write within the first `ownedColumns` columns. Everything
//      to the right belongs to the school and is neither read nor written.
//
// planReconcileGrid is the general planner (any ID-keyed rows under any
// header rows); planReconcile is the registration-form adapter on top of it.

const FIXED_COLUMNS = ['Submission ID', 'Submitted', 'Status'];

// Written into the Status cell when a submission has been deleted in
// SchoolMule. The row itself is kept: deleting it would take the school's
// notes on that family with it.
const DELETED_MARKER = '(deleted)';

/** Renders a timestamp as YYYY-MM-DD. Accepts a Date or an ISO string. */
function formatDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

/** The header for a form's owned block: fixed columns, then one per field. */
function buildHeaderRow(fields) {
  return [...FIXED_COLUMNS, ...fields.map((f) => f.label)];
}

/** One submission as a row of owned-column values. */
function buildRow(submission, fields) {
  const answers = submission.answers || {};
  return [
    submission.submission_id,
    formatDate(submission.submitted_at),
    submission.status_label || submission.status || '',
    ...fields.map((f) => {
      const v = answers[f.field_id];
      return v === null || v === undefined ? '' : String(v);
    }),
  ];
}

/** Pads (or trims) a row to exactly `width` cells. */
function fitRow(row, width) {
  const out = Array.from({ length: width }, (_, i) => (row || [])[i] ?? '');
  return out;
}

/**
 * Cell-by-cell equality over `width` cells, blank-padded. Sheets trims
 * trailing empty cells on read, so a row that ends in blanks must not look
 * stale just because the sheet handed it back shorter.
 */
function rowsEqualTo(existing, desired, width) {
  const a = fitRow(existing, width);
  const b = fitRow(desired, width);
  return a.every((v, i) => String(v ?? '') === String(b[i] ?? ''));
}

/**
 * Plan the writes needed to bring one tab's owned block up to date.
 *
 * @param grid           string[][] — the tab's current owned block, row 0 first.
 * @param headerRows     string[][] — rows written above the data (a title row,
 *                       the column header, …). Always rewritten when different.
 * @param rows           Array<{id, values}> — desired ID-keyed rows, in order.
 * @param width          how many leading columns we own. Every write is padded
 *                       to it so stale trailing cells are blanked.
 * @param previousWidth  what we owned last time (stored by the caller). Growth
 *                       inserts columns so the school's own columns shift right
 *                       intact. Omitted → inferred from the grid.
 * @param missing        { mark(existingValues) → newValues } | null — how to
 *                       treat a row in the sheet with no matching desired row.
 *                       Rows are never deleted. null leaves them alone.
 * @param pinnedBottomId a row id kept last: when it is currently the last row
 *                       and there are appends, the appends take its place and
 *                       it is re-emitted after them.
 *
 * @returns {{
 *   insertColumns: number,
 *   headerWrites: Array<{rowIndex, values}>,
 *   updates: Array<{rowIndex, values}>,
 *   appends: string[][],
 *   appendStartRow: number,
 *   ownedColumns: number,
 *   isNoop: boolean
 * }}
 */
function planReconcileGrid({
  grid = [],
  headerRows = [],
  rows = [],
  width,
  previousWidth = null,
  missing = null,
  pinnedBottomId = null,
}) {
  const ownedColumns = width;

  // Widen only. A narrower block must not delete a column: the school's data
  // sits immediately to the right and would shift left over our header.
  // Without a stored previous width, the widest row we read is the best guess
  // (a short title row must not make us think the block is narrow).
  const inferred = grid.length > 0 ? Math.max(0, ...grid.map((r) => (r || []).length)) : ownedColumns;
  const currentWidth = previousWidth === null || previousWidth === undefined ? inferred : previousWidth;
  const insertColumns = Math.max(0, ownedColumns - currentWidth);

  const headerWrites = [];
  headerRows.forEach((values, rowIndex) => {
    if (!rowsEqualTo(grid[rowIndex], values, ownedColumns)) {
      headerWrites.push({ rowIndex, values: fitRow(values, ownedColumns) });
    }
  });

  // Map id → row. First occurrence wins, so a row the school duplicated by
  // hand does not produce two conflicting writes.
  const idToRow = new Map();
  for (let i = headerRows.length; i < grid.length; i++) {
    const id = String((grid[i] || [])[0] ?? '').trim();
    if (!id || idToRow.has(id)) continue;
    idToRow.set(id, i);
  }

  const updates = [];
  const appends = [];
  const seen = new Set();
  let pinned = null;

  for (const row of rows) {
    const id = String(row.id);
    const desired = fitRow(row.values, ownedColumns);
    seen.add(id);

    const rowIndex = idToRow.get(id);
    if (rowIndex === undefined) {
      if (pinnedBottomId !== null && id === String(pinnedBottomId)) pinned = { rowIndex: null, values: desired };
      else appends.push(desired);
      continue;
    }
    if (pinnedBottomId !== null && id === String(pinnedBottomId)) {
      pinned = { rowIndex, values: desired };
      continue;
    }
    if (!rowsEqualTo(grid[rowIndex], desired, ownedColumns)) {
      updates.push({ rowIndex, values: desired });
    }
  }

  // Rows in the sheet with no matching desired row: mark, never delete.
  if (missing) {
    for (const [id, rowIndex] of idToRow) {
      if (seen.has(id)) continue;
      const existing = fitRow(grid[rowIndex], ownedColumns).map((v) => String(v ?? ''));
      const marked = fitRow(missing.mark(existing), ownedColumns);
      if (!rowsEqualTo(existing, marked, ownedColumns)) updates.push({ rowIndex, values: marked });
    }
  }

  let appendStartRow = Math.max(grid.length, headerRows.length);

  if (pinned) {
    const isLast = pinned.rowIndex !== null && pinned.rowIndex === grid.length - 1;
    if (pinned.rowIndex === null || (isLast && appends.length > 0)) {
      // A new pinned row goes at the bottom; an existing one that is still
      // last slides down past the new rows so it stays there.
      if (isLast) appendStartRow = pinned.rowIndex;
      appends.push(pinned.values);
    } else if (!rowsEqualTo(grid[pinned.rowIndex], pinned.values, ownedColumns)) {
      updates.push({ rowIndex: pinned.rowIndex, values: pinned.values });
    }
  }

  return {
    insertColumns,
    headerWrites,
    updates,
    appends,
    appendStartRow,
    ownedColumns,
    isNoop: headerWrites.length === 0 && updates.length === 0 && appends.length === 0 && insertColumns === 0,
  };
}

/**
 * Plan the writes for a registration form's tab: the original API, now an
 * adapter over planReconcileGrid.
 *
 * @param grid        string[][] — the tab's current values, row 0 the header.
 * @param submissions the form's submissions, oldest first
 * @param fields      the form's fields, in display order
 *
 * @returns {{
 *   insertColumns: number,
 *   headerWrite: {rowIndex, values}|null,
 *   updates: Array<{rowIndex, values}>,
 *   appends: string[][],
 *   appendStartRow: number,
 *   ownedColumns: number,
 *   isNoop: boolean
 * }}
 */
function planReconcile({ grid = [], submissions = [], fields = [] }) {
  const header = buildHeaderRow(fields);
  const plan = planReconcileGrid({
    grid,
    headerRows: [header],
    rows: submissions.map((s) => ({ id: s.submission_id, values: buildRow(s, fields) })),
    width: header.length,
    missing: {
      // Carry the existing values across and change only the status cell, so
      // the school still sees who the row was about.
      mark: (existing) => {
        const values = [...existing];
        values[2] = DELETED_MARKER;
        return values;
      },
    },
  });
  const { headerWrites, ...rest } = plan;
  return { ...rest, headerWrite: headerWrites[0] ?? null };
}

module.exports = {
  FIXED_COLUMNS,
  DELETED_MARKER,
  buildHeaderRow,
  buildRow,
  planReconcileGrid,
  planReconcile,
};
