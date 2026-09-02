// services/google/sheetReconciler.js
//
// Works out what to write into a form's sheet tab.
//
// Pure and dependency-free: given what is currently in the sheet and what
// should be there, it returns a list of writes. No Google calls, no database.
// Every edge case a real sheet throws at us — a school re-sorting rows, adding
// their own columns, pasting a row by hand — is therefore cheap to test.
//
// Two invariants the whole design rests on:
//
//   1. Column 0 holds the submission ID. That is what lets a row be found
//      again after the school sorts or filters the sheet: the ID travels with
//      the row. A row with a blank ID is the school's own and is never touched.
//
//   2. We only ever write within the first `ownedColumns` columns. Everything
//      to the right belongs to the school and is neither read nor written.

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

function rowsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => String(v ?? '') === String(b[i] ?? ''));
}

/**
 * Compare a desired row against what the sheet holds, ignoring any columns
 * beyond our block — the school's columns must never make a row look stale.
 */
function matchesExisting(existingRow, desired) {
  return rowsEqual((existingRow || []).slice(0, desired.length), desired);
}

/**
 * Plan the writes needed to bring one tab up to date.
 *
 * @param grid        string[][] — the tab's current values, row 0 the header.
 *                    Row indices are 0-based and match the sheet.
 * @param submissions the form's submissions, oldest first
 * @param fields      the form's fields, in display order
 *
 * @returns {{
 *   insertColumns: number,        // columns to insert before writing values
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
  const ownedColumns = header.length;

  // Widen only. A removed field must not delete a column: the school's data
  // sits immediately to the right and would shift left over our header.
  const currentWidth = grid.length > 0 ? (grid[0] || []).length : ownedColumns;
  const insertColumns = Math.max(0, ownedColumns - currentWidth);

  const headerWrite = rowsEqual((grid[0] || []).slice(0, ownedColumns), header)
    ? null
    : { rowIndex: 0, values: header };

  // Map submission id → row. First occurrence wins, so a row the school
  // duplicated by hand does not produce two conflicting writes.
  const idToRow = new Map();
  for (let i = 1; i < grid.length; i++) {
    const id = String((grid[i] || [])[0] ?? '').trim();
    if (!id || idToRow.has(id)) continue;
    idToRow.set(id, i);
  }

  const updates = [];
  const appends = [];
  const seen = new Set();

  for (const submission of submissions) {
    const desired = buildRow(submission, fields);
    seen.add(String(submission.submission_id));

    const rowIndex = idToRow.get(String(submission.submission_id));
    if (rowIndex === undefined) {
      appends.push(desired);
      continue;
    }
    if (!matchesExisting(grid[rowIndex], desired)) {
      updates.push({ rowIndex, values: desired });
    }
  }

  // Rows in the sheet with no matching submission: mark, never delete.
  for (const [id, rowIndex] of idToRow) {
    if (seen.has(id)) continue;
    const existing = (grid[rowIndex] || []).slice(0, ownedColumns);
    if (existing[2] === DELETED_MARKER) continue; // already marked

    // Carry the existing values across and change only the status cell, so the
    // school still sees who the row was about.
    const values = Array.from({ length: ownedColumns }, (_, i) => String(existing[i] ?? ''));
    values[2] = DELETED_MARKER;
    updates.push({ rowIndex, values });
  }

  return {
    insertColumns,
    headerWrite,
    updates,
    appends,
    appendStartRow: Math.max(grid.length, 1),
    ownedColumns,
    isNoop: !headerWrite && updates.length === 0 && appends.length === 0 && insertColumns === 0,
  };
}

module.exports = {
  FIXED_COLUMNS,
  DELETED_MARKER,
  buildHeaderRow,
  buildRow,
  planReconcile,
};
