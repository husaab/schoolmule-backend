const {
  buildHeaderRow,
  buildRow,
  planReconcile,
} = require('../../../../services/google/sheetReconciler');

const fields = [
  { field_id: 'f1', label: 'Name', sort_order: 0 },
  { field_id: 'f2', label: 'Grade', sort_order: 1 },
];

const sub = (id, name, grade, status = 'New') => ({
  submission_id: id,
  submitted_at: '2026-08-24T00:00:00Z',
  status_label: status,
  answers: { f1: name, f2: grade },
});

const header = ['Submission ID', 'Submitted', 'Status', 'Name', 'Grade'];

describe('buildHeaderRow', () => {
  it('leads with the ID column, then the fixed columns, then field labels', () => {
    expect(buildHeaderRow(fields)).toEqual(header);
  });

  it('handles a form with no fields', () => {
    expect(buildHeaderRow([])).toEqual(['Submission ID', 'Submitted', 'Status']);
  });
});

describe('buildRow', () => {
  it('aligns answers to the field order', () => {
    expect(buildRow(sub('s1', 'Ahmad', '2'), fields))
      .toEqual(['s1', '2026-08-24', 'New', 'Ahmad', '2']);
  });

  it('emits an empty string for an unanswered field, keeping columns aligned', () => {
    const s = {
      submission_id: 's1',
      submitted_at: '2026-08-24T00:00:00Z',
      status_label: 'New',
      answers: { f1: 'Ahmad' },
    };
    expect(buildRow(s, fields)).toEqual(['s1', '2026-08-24', 'New', 'Ahmad', '']);
  });

  it('accepts a Date as well as a string for submitted_at', () => {
    const s = { ...sub('s1', 'Ahmad', '2'), submitted_at: new Date('2026-08-24T00:00:00Z') };
    expect(buildRow(s, fields)[1]).toBe('2026-08-24');
  });

  it('tolerates a null answers blob', () => {
    const s = { submission_id: 's1', submitted_at: '2026-08-24T00:00:00Z', status_label: 'New', answers: null };
    expect(buildRow(s, fields)).toEqual(['s1', '2026-08-24', 'New', '', '']);
  });
});

describe('planReconcile', () => {
  it('writes the header and appends everything into an empty tab', () => {
    const plan = planReconcile({ grid: [], submissions: [sub('s1', 'Ahmad', '2')], fields });
    expect(plan.headerWrite).toEqual({ rowIndex: 0, values: header });
    expect(plan.appends).toEqual([['s1', '2026-08-24', 'New', 'Ahmad', '2']]);
    expect(plan.updates).toEqual([]);
    expect(plan.ownedColumns).toBe(5);
  });

  it('updates an existing row in place rather than appending a duplicate', () => {
    const grid = [header, ['s1', '2026-08-24', 'New', 'Ahmad', '2']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '3', 'Waitlist')], fields });
    expect(plan.appends).toEqual([]);
    expect(plan.updates).toEqual([{ rowIndex: 1, values: ['s1', '2026-08-24', 'Waitlist', 'Ahmad', '3'] }]);
  });

  it('finds a row by ID after the school re-sorted the sheet', () => {
    const grid = [header, ['s2', '', '', '', ''], ['s1', '', '', '', '']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '2')], fields });
    expect(plan.updates[0].rowIndex).toBe(2);
  });

  it('skips rows the school inserted themselves (blank ID)', () => {
    const grid = [header, ['', 'my own note row', '', '', ''], ['s1', '', '', '', '']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '2')], fields });
    expect(plan.updates).toEqual([{ rowIndex: 2, values: ['s1', '2026-08-24', 'New', 'Ahmad', '2'] }]);
    expect(plan.appends).toEqual([]);
  });

  it('treats a whitespace-only ID as the school\'s own row', () => {
    const grid = [header, ['   ', 'note', '', '', ''], ['s1', '', '', '', '']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '2')], fields });
    expect(plan.updates[0].rowIndex).toBe(2);
  });

  it('marks a row whose submission was deleted, without removing the row', () => {
    const grid = [header, ['s1', '2026-08-24', 'New', 'Ahmad', '2']];
    const plan = planReconcile({ grid, submissions: [], fields });
    expect(plan.updates).toEqual([{ rowIndex: 1, values: ['s1', '2026-08-24', '(deleted)', 'Ahmad', '2'] }]);
    expect(plan.appends).toEqual([]);
  });

  it('does not re-mark a row that is already marked deleted', () => {
    const grid = [header, ['s1', '2026-08-24', '(deleted)', 'Ahmad', '2']];
    const plan = planReconcile({ grid, submissions: [], fields });
    expect(plan.updates).toEqual([]);
  });

  it('appends new submissions below the last used row', () => {
    const grid = [header, ['s1', '2026-08-24', 'New', 'Ahmad', '2']];
    const plan = planReconcile({
      grid,
      submissions: [sub('s1', 'Ahmad', '2'), sub('s2', 'Zaynab', 'JK')],
      fields,
    });
    expect(plan.appends).toEqual([['s2', '2026-08-24', 'New', 'Zaynab', 'JK']]);
    expect(plan.appendStartRow).toBe(2);
  });

  it('requests column insertion when the form gained a field', () => {
    const grid = [['Submission ID', 'Submitted', 'Status', 'Name']]; // 4 wide
    const plan = planReconcile({ grid, submissions: [], fields });   // needs 5
    expect(plan.insertColumns).toBe(1);
    expect(plan.ownedColumns).toBe(5);
  });

  it('does not insert columns when the width already matches', () => {
    expect(planReconcile({ grid: [header], submissions: [], fields }).insertColumns).toBe(0);
  });

  it('does not insert columns into a brand new tab', () => {
    expect(planReconcile({ grid: [], submissions: [], fields }).insertColumns).toBe(0);
  });

  it('never shrinks the owned block when a field is removed', () => {
    // Losing a field must not delete a column — the school's data sits to the
    // right and deleting would shift it left, over our own header.
    const wide = ['Submission ID', 'Submitted', 'Status', 'Name', 'Grade', 'Extra'];
    const plan = planReconcile({ grid: [wide], submissions: [], fields });
    expect(plan.insertColumns).toBe(0);
  });

  it('keeps the first row when the sheet contains a duplicated ID', () => {
    const grid = [header, ['s1', '', '', '', ''], ['s1', '', '', '', '']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '2')], fields });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].rowIndex).toBe(1);
  });

  it('rewrites a header that has drifted from the current fields', () => {
    const grid = [['Submission ID', 'Submitted', 'Status', 'Old label', 'Grade']];
    const plan = planReconcile({ grid, submissions: [], fields });
    expect(plan.headerWrite).toEqual({ rowIndex: 0, values: header });
  });

  it('leaves the header alone when it already matches', () => {
    expect(planReconcile({ grid: [header], submissions: [], fields }).headerWrite).toBeNull();
  });

  it('emits no writes at all when the sheet is already correct', () => {
    const grid = [header, ['s1', '2026-08-24', 'New', 'Ahmad', '2']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '2')], fields });
    expect(plan.headerWrite).toBeNull();
    expect(plan.updates).toEqual([]);
    expect(plan.appends).toEqual([]);
    expect(plan.isNoop).toBe(true);
  });

  it('never produces a row wider than the owned block, so the school\'s columns are safe', () => {
    const grid = [header.concat(['Called?', 'Notes']), ['s1', '2026-08-24', 'New', 'Ahmad', '2', 'Yes', 'left VM']];
    const plan = planReconcile({ grid, submissions: [sub('s1', 'Ahmad', '3')], fields });
    for (const u of plan.updates) expect(u.values).toHaveLength(plan.ownedColumns);
    for (const a of plan.appends) expect(a).toHaveLength(plan.ownedColumns);
  });

  it('preserves the school\'s columns when marking a row deleted', () => {
    const grid = [header, ['s1', '2026-08-24', 'New', 'Ahmad', '2']];
    const plan = planReconcile({ grid, submissions: [], fields });
    // Only the status cell changes; the rest of our block is carried over.
    expect(plan.updates[0].values).toEqual(['s1', '2026-08-24', '(deleted)', 'Ahmad', '2']);
  });

  it('handles a large batch without duplicating or dropping rows', () => {
    const submissions = Array.from({ length: 200 }, (_, i) => sub(`s${i}`, `Name${i}`, '2'));
    const grid = [header, ...submissions.slice(0, 120).map((s) => buildRow(s, fields))];
    const plan = planReconcile({ grid, submissions, fields });
    expect(plan.appends).toHaveLength(80);
    expect(plan.updates).toHaveLength(0); // the first 120 already match exactly
  });
});

// ─── planReconcileGrid (the general planner the form adapter sits on) ───────

const { planReconcileGrid } = require('../../../../services/google/sheetReconciler');

describe('planReconcileGrid', () => {
  const info = ['Pay day Sept 25, 2026', 'Period complete'];
  const head = ['Staff ID', 'Staff member', 'Hours'];
  const rows = [
    { id: 't1', values: ['t1', 'Aisha Khan', 84.5] },
    { id: 't2', values: ['t2', 'Bilal Ahmed', 40] },
  ];
  const total = { id: '__total__', values: ['__total__', 'Total', 124.5] };
  const mark = (existing) => {
    const v = [...existing];
    if (!String(v[1]).endsWith(' (removed)')) v[1] = `${v[1]} (removed)`;
    return v;
  };

  it('writes every header row and appends every row into an empty tab', () => {
    const plan = planReconcileGrid({ grid: [], headerRows: [info, head], rows: [...rows, total], width: 3, pinnedBottomId: '__total__' });
    expect(plan.insertColumns).toBe(0);
    expect(plan.headerWrites).toEqual([
      { rowIndex: 0, values: ['Pay day Sept 25, 2026', 'Period complete', ''] },
      { rowIndex: 1, values: head },
    ]);
    expect(plan.appends).toEqual([rows[0].values, rows[1].values, total.values]);
    expect(plan.appendStartRow).toBe(2);
  });

  it('is a no-op when the sheet matches, even though Sheets trims trailing blanks', () => {
    const grid = [
      ['Pay day Sept 25, 2026', 'Period complete'], // short: trailing blank trimmed by Sheets
      head,
      ['t1', 'Aisha Khan', '84.5'],
      ['t2', 'Bilal Ahmed', '40'],
      ['__total__', 'Total', '124.5'],
    ];
    const plan = planReconcileGrid({ grid, headerRows: [info, head], rows: [...rows, total], width: 3, pinnedBottomId: '__total__' });
    expect(plan.isNoop).toBe(true);
  });

  it('does not mistake a short title row for a narrow block', () => {
    const grid = [['Pay day Sept 25, 2026'], head, ['t1', 'Aisha Khan', '84.5']];
    const plan = planReconcileGrid({ grid, headerRows: [info, head], rows, width: 3 });
    expect(plan.insertColumns).toBe(0);
  });

  it('inserts columns based on the stored previous width, not the grid', () => {
    // The block grew from 3 to 4 columns and the school has a notes column
    // sitting right where the new column must go: the read at width 4
    // returns their notes in column D.
    const grid = [[...head, 'Notes'], ['t1', 'Aisha Khan', '84.5', 'called Monday']];
    const plan = planReconcileGrid({
      grid, headerRows: [[...head, 'Total']], rows: [{ id: 't1', values: ['t1', 'Aisha Khan', 84.5, 84.5] }],
      width: 4, previousWidth: 3,
    });
    expect(plan.insertColumns).toBe(1);
    expect(plan.headerWrites[0].values).toEqual([...head, 'Total']);
    expect(plan.updates).toEqual([{ rowIndex: 1, values: ['t1', 'Aisha Khan', 84.5, 84.5] }]);
  });

  it('keeps the pinned row last when new rows are appended', () => {
    const grid = [head, ['t1', 'Aisha Khan', '84.5'], ['__total__', 'Total', '84.5']];
    const plan = planReconcileGrid({ grid, headerRows: [head], rows: [...rows, total], width: 3, pinnedBottomId: '__total__' });
    // t2 takes the Total row's slot; Total is re-emitted after it.
    expect(plan.appendStartRow).toBe(2);
    expect(plan.appends).toEqual([rows[1].values, total.values]);
    expect(plan.updates).toEqual([]);
  });

  it('updates the pinned row in place when nothing is appended', () => {
    const grid = [head, ['t1', 'Aisha Khan', '84.5'], ['t2', 'Bilal Ahmed', '40'], ['__total__', 'Total', '0']];
    const plan = planReconcileGrid({ grid, headerRows: [head], rows: [...rows, total], width: 3, pinnedBottomId: '__total__' });
    expect(plan.appends).toEqual([]);
    expect(plan.updates).toEqual([{ rowIndex: 3, values: total.values }]);
  });

  it('falls back to a plain append when the school typed rows beneath the pinned one', () => {
    const grid = [head, ['t1', 'Aisha Khan', '84.5'], ['__total__', 'Total', '84.5'], ['', 'my own note', '']];
    const plan = planReconcileGrid({ grid, headerRows: [head], rows: [...rows, total], width: 3, pinnedBottomId: '__total__' });
    expect(plan.appendStartRow).toBe(4);
    expect(plan.appends).toEqual([rows[1].values]);
    expect(plan.updates).toEqual([{ rowIndex: 2, values: total.values }]);
  });

  it('marks rows with no matching id using the caller\'s rule, and never deletes them', () => {
    const grid = [head, ['t1', 'Aisha Khan', '84.5'], ['t9', 'Old Teacher', '10']];
    const plan = planReconcileGrid({ grid, headerRows: [head], rows: [rows[0]], width: 3, missing: { mark } });
    expect(plan.updates).toEqual([{ rowIndex: 2, values: ['t9', 'Old Teacher (removed)', '10'] }]);
    // Already marked → nothing to write.
    const again = planReconcileGrid({ grid: [head, ['t1', 'Aisha Khan', '84.5'], ['t9', 'Old Teacher (removed)', '10']], headerRows: [head], rows: [rows[0]], width: 3, missing: { mark } });
    expect(again.isNoop).toBe(true);
  });

  it('leaves unmatched rows alone when no missing rule is given', () => {
    const grid = [head, ['t9', 'Old Teacher', '10']];
    const plan = planReconcileGrid({ grid, headerRows: [head], rows: [], width: 3 });
    expect(plan.isNoop).toBe(true);
  });

  it('pads every write to the owned width so a shrunken block blanks its stale cells', () => {
    const plan = planReconcileGrid({ grid: [], headerRows: [head], rows: [rows[0]], width: 5 });
    expect(plan.headerWrites[0].values).toEqual([...head, '', '']);
    expect(plan.appends[0]).toEqual(['t1', 'Aisha Khan', 84.5, '', '']);
  });
});
