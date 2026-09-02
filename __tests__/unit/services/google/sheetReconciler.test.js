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
