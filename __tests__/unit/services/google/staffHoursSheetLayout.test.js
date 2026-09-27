const layout = require('../../../../services/google/staffHoursSheetLayout');
const { longDate } = require('../../../../templates/staffAttendanceTemplate');

const monthly25 = { frequency: 'MONTHLY', payDayOfMonth: 25 };

const teacher = (over = {}) => ({
  teacherId: 't1',
  firstName: 'Aisha',
  lastName: 'Khan',
  username: 'akhan',
  records: [],
  workDays: [1, 2, 3, 4, 5],
  workingDays: 21,
  elapsedWorkingDays: 14,
  presentDays: 13,
  absentDays: 1,
  hoursPerDay: 6.5,
  hoursWorked: 84.5,
  ...over,
});

const period = (over = {}) => ({
  payDate: '2026-09-25',
  startDate: '2026-08-26',
  endDate: '2026-09-25',
  throughDate: '2026-09-25',
  isComplete: true,
  teachers: [teacher()],
  ...over,
});

describe('periodsForYear', () => {
  it('runs from the first pay day on/after the year start through the period in progress', () => {
    const periods = layout.periodsForYear(monthly25, '2026-09-01', '2026-09-26');
    expect(periods.map((p) => p.payDate)).toEqual(['2026-09-25', '2026-10-25']);
    expect(periods[0]).toMatchObject({ startDate: '2026-08-26', endDate: '2026-09-25' });
  });

  it('includes only the in-progress period when the year has just started', () => {
    expect(layout.periodsForYear(monthly25, '2026-09-01', '2026-09-10').map((p) => p.payDate))
      .toEqual(['2026-09-25']);
  });

  it('steps biweekly periods from the anchor', () => {
    const biweekly = { frequency: 'BIWEEKLY', anchorPayDate: '2026-09-04' };
    expect(layout.periodsForYear(biweekly, '2026-09-01', '2026-09-26').map((p) => p.payDate))
      .toEqual(['2026-09-04', '2026-09-18', '2026-10-02']);
  });

  it('is empty before the school year starts', () => {
    expect(layout.periodsForYear(monthly25, '2026-09-01', '2026-06-01')).toEqual([]);
  });
});

describe('date helpers', () => {
  it('names a tab after its pay day in words, and remembers the old name for renaming', () => {
    expect(layout.periodTabTitle(period())).toBe('September 25, 2026 Pay Day');
    expect(layout.legacyPeriodTabTitle(period())).toBe('Pay day 2026-09-25');
    expect(layout.longMonthDate('2026-10-05')).toBe('October 5, 2026');
  });

  it('lists every calendar date in the period, inclusive', () => {
    const dates = layout.datesIn({ startDate: '2026-08-30', endDate: '2026-09-02' });
    expect(dates).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });

  it('renders a date header without any timezone shift', () => {
    expect(layout.dateHeader('2026-08-26')).toBe('Wed 26 Aug');
    expect(layout.dateHeader('2026-09-25')).toBe('Fri 25 Sept');
  });
});

describe('dayCell', () => {
  const workDays = [1, 2, 3, 4, 5];

  it('shows P or A for a recorded or assumed day', () => {
    expect(layout.dayCell({ record: { status: 'PRESENT', hours: null }, key: '2026-09-08', workDays })).toBe('P');
    expect(layout.dayCell({ record: { status: 'ABSENT', hours: null }, key: '2026-09-08', workDays })).toBe('A');
  });

  it('appends the hours when an admin overrode the day', () => {
    expect(layout.dayCell({ record: { status: 'PRESENT', hours: 4 }, key: '2026-09-08', workDays })).toBe('P 4h');
    expect(layout.dayCell({ record: { status: 'PRESENT', hours: 3.5 }, key: '2026-09-08', workDays })).toBe('P 3.5h');
  });

  it('marks a weekday this person does not work, and leaves weekends blank', () => {
    expect(layout.dayCell({ record: null, key: '2026-09-09', workDays: [1, 2, 4, 5] })).toBe('–'); // Wednesday
    expect(layout.dayCell({ record: null, key: '2026-09-12', workDays })).toBe(''); // Saturday
    expect(layout.dayCell({ record: null, key: '2026-09-10', workDays })).toBe(''); // future / closed
  });
});

describe('buildPeriodTab', () => {
  it('lays out the info row, the header, one row per person, and a pinned Total', () => {
    const tab = layout.buildPeriodTab(period({
      teachers: [teacher({ records: [
        { attendanceDate: '2026-09-08', status: 'PRESENT', hours: null },
        { attendanceDate: '2026-09-09', status: 'ABSENT', hours: null },
        { attendanceDate: '2026-09-10', status: 'PRESENT', hours: 4 },
      ] })],
    }));

    expect(tab.title).toBe('September 25, 2026 Pay Day');
    expect(tab.legacyTitles).toEqual(['Pay day 2026-09-25']);
    expect(tab.width).toBe(8 + 31); // Aug 26 – Sept 25
    expect(tab.headerRows[0][0]).toBe(`September 25, 2026 Pay Day · ${longDate('2026-08-26')} – ${longDate('2026-09-25')}`);
    expect(tab.headerRows[0][1]).toBe('Period complete');
    expect(tab.headerRows[1].slice(0, 8)).toEqual(layout.FIXED_COLUMNS);
    expect(tab.headerRows[1][8]).toBe('Wed 26 Aug');
    expect(tab.headerRows[1]).toHaveLength(tab.width);

    const row = tab.rows[0];
    expect(row.id).toBe('t1');
    expect(row.values.slice(0, 8)).toEqual(['t1', 'Aisha Khan', 13, 1, '14 / 21', 6.5, 84.5, 1]);
    // Column index of a date = 8 + days since the period start.
    const col = (key) => 8 + layout.datesIn(period()).indexOf(key);
    expect(row.values[col('2026-09-08')]).toBe('P');
    expect(row.values[col('2026-09-09')]).toBe('A');
    expect(row.values[col('2026-09-10')]).toBe('P 4h');
    expect(row.values[col('2026-09-12')]).toBe('');

    const total = tab.rows.at(-1);
    expect(total.id).toBe(layout.TOTAL_ID);
    expect(total.values.slice(0, 7)).toEqual([layout.TOTAL_ID, 'Total', '', '', '', '', 84.5]);
    expect(tab.pinnedBottomId).toBe(layout.TOTAL_ID);
  });

  it('says how far an in-progress period has run', () => {
    const tab = layout.buildPeriodTab(period({
      payDate: '2026-10-25', startDate: '2026-09-26', endDate: '2026-10-25',
      throughDate: '2026-09-30', isComplete: false,
    }));
    expect(tab.headerRows[0][1]).toBe(`Through ${longDate('2026-09-30')} — pay day is still ahead`);
  });

  it('writes numbers, not strings, for the numeric columns', () => {
    const tab = layout.buildPeriodTab(period());
    const [, , present, absent, , perDay, worked, overrides] = tab.rows[0].values;
    [present, absent, perDay, worked, overrides].forEach((v) => expect(typeof v).toBe('number'));
  });

  it('sorts staff by last name then first name', () => {
    const tab = layout.buildPeriodTab(period({ teachers: [
      teacher({ teacherId: 'b', firstName: 'Zed', lastName: 'Ali' }),
      teacher({ teacherId: 'a', firstName: 'Amy', lastName: 'Ali' }),
      teacher({ teacherId: 'c', firstName: 'Bob', lastName: 'Adams' }),
    ] }));
    expect(tab.rows.slice(0, 3).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('marks a row that is no longer on staff instead of deleting it', () => {
    const tab = layout.buildPeriodTab(period());
    expect(tab.missing.mark(['t9', 'Old Teacher', 1, 0])).toEqual(['t9', 'Old Teacher (removed)', 1, 0]);
    // Idempotent: a second sync must not append the suffix twice.
    expect(tab.missing.mark(['t9', 'Old Teacher (removed)', 1, 0])[1]).toBe('Old Teacher (removed)');
  });
});

describe('buildOverviewTab', () => {
  it('is a staff × pay day matrix of hours with totals both ways', () => {
    const periods = [
      period({ teachers: [teacher({ hoursWorked: 84.5 }), teacher({ teacherId: 't2', firstName: 'Bilal', lastName: 'Ahmed', hoursWorked: 40 })] }),
      period({ payDate: '2026-10-25', startDate: '2026-09-26', endDate: '2026-10-25', isComplete: false,
        teachers: [teacher({ hoursWorked: 6.5 })] }),
    ];
    const tab = layout.buildOverviewTab(periods);

    expect(tab.title).toBe(layout.OVERVIEW_TAB);
    expect(tab.width).toBe(5);
    expect(tab.headerRows).toEqual([['Staff ID', 'Staff member', 'September 25, 2026 Pay Day', 'October 25, 2026 Pay Day', 'Total']]);
    expect(tab.rows[0].values).toEqual(['t2', 'Bilal Ahmed', 40, 0, 40]);
    expect(tab.rows[1].values).toEqual(['t1', 'Aisha Khan', 84.5, 6.5, 91]);
    expect(tab.rows[2].values).toEqual([layout.TOTAL_ID, 'Total', 124.5, 6.5, 131]);
    expect(tab.pinnedBottomId).toBe(layout.TOTAL_ID);
  });

  it('describes how the tab should look: frozen names, hidden id, a colour per person', () => {
    const tab = layout.buildOverviewTab([period()]);
    expect(tab.format).toMatchObject({ frozenRows: 1, frozenColumns: 2, hiddenColumns: [0], totalId: layout.TOTAL_ID });
    expect(tab.format.rowColours.get('t1')).toMatch(/^#[0-9A-F]{6}$/i);
    const periodTab = layout.buildPeriodTab(period());
    expect(periodTab.format).toMatchObject({ frozenRows: 2, frozenColumns: 2 });
    expect(periodTab.format.columnWidths.at(-1)).toEqual({ start: 8, end: periodTab.width, pixels: 76 });
  });

  it('handles a year with no periods yet', () => {
    const tab = layout.buildOverviewTab([]);
    expect(tab.width).toBe(3);
    expect(tab.rows).toEqual([{ id: layout.TOTAL_ID, values: [layout.TOTAL_ID, 'Total', 0] }]);
  });
});

describe('assignStaffColours', () => {
  const staff = (id) => ({ teacherId: id });

  it('gives each person a stable colour from the palette', () => {
    const a = layout.assignStaffColours([staff('aaa'), staff('bbb')]);
    const b = layout.assignStaffColours([staff('aaa'), staff('bbb')]);
    expect(a.get('aaa')).toBe(b.get('aaa'));
    expect(layout.STAFF_PALETTE).toContain(a.get('aaa'));
  });

  it('never gives two neighbours the same colour', () => {
    const ids = Array.from({ length: 60 }, (_, i) => staff(`user-${i}`));
    const colours = [...layout.assignStaffColours(ids).values()];
    for (let i = 1; i < colours.length; i++) expect(colours[i]).not.toBe(colours[i - 1]);
  });
});
