// services/google/staffHoursSheetLayout.js
//
// Lays out a school's staff-hours spreadsheet: an Overview tab (staff × pay
// day) and one tab per pay day (everyone's hours for that period, plus a
// per-day P/A grid). Pure: assembled pay periods in, tab descriptions out.
// Every tab description feeds planReconcileGrid unchanged.
//
// Column A on every tab holds the staff member's user id. That is what lets a
// row be found again after the school sorts the tab, and what lets them add
// their own columns to the right of ours.

const payPeriods = require('../payPeriods');
const { dateKey, isoWeekday } = require('../staffAttendance/assembly');
const { fmtHours, longDate, staffName } = require('../../templates/staffAttendanceTemplate');

const OVERVIEW_TAB = 'Overview';
const TOTAL_ID = '__total__';
const REMOVED_SUFFIX = ' (removed)';

// One colour per staff member, the same on every tab. Soft enough that black
// text stays readable; distinct enough that neighbouring rows read as
// different people.
const STAFF_PALETTE = [
  '#FDE2E2', '#FFE8D1', '#FFF4C2', '#E5F5D5', '#D5F0E8', '#D6EEF8',
  '#DCE3FA', '#E9DDF7', '#F8DCEC', '#EDE4D9', '#E2ECE0', '#E6E6E6',
];

const FIXED_COLUMNS = [
  'Staff ID',
  'Staff member',
  'Present',
  'Absent',
  'Days elapsed / scheduled',
  'Hours / day',
  'Hours worked',
  'Day overrides',
];

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** "September 25, 2026" from a YYYY-MM-DD key, without any timezone shift. */
const longMonthDate = (key) => {
  const [y, m, d] = String(key).substring(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' });
};

/** "September 25, 2026 Pay Day" — the tab name, and its column on the Overview. */
const periodTabTitle = (period) => `${longMonthDate(period.payDate)} Pay Day`;

/** The title the first release used; ensureTabs renames a tab it finds under it. */
const legacyPeriodTabTitle = (period) => `Pay day ${period.payDate}`;

/** Stable colour per staff member: hashed from the id so adding someone does
 *  not recolour everyone, then nudged so two neighbours never share one. */
const assignStaffColours = (sortedStaff) => {
  const colours = new Map();
  let previous = -1;
  for (const t of sortedStaff) {
    const id = String(t.teacherId);
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    let index = hash % STAFF_PALETTE.length;
    if (index === previous) index = (index + 1) % STAFF_PALETTE.length;
    colours.set(id, STAFF_PALETTE[index]);
    previous = index;
  }
  return colours;
};

/**
 * Every pay period from the school year's start through the one in progress:
 * pay dates on/after the year start up to the next pay date on/after today.
 */
function periodsForYear(schedule, yearStart, today) {
  const last = payPeriods.nextPayDateOnOrAfter(schedule, today);
  if (!last || last < yearStart) return [];
  return payPeriods
    .payDatesBetween(schedule, yearStart, last)
    .map((payDate) => payPeriods.periodEndingOn(schedule, payDate));
}

/** Every calendar date in a period, inclusive. */
function datesIn(period) {
  const out = [];
  for (let d = period.startDate; d <= period.endDate; d = payPeriods.addDays(d, 1)) out.push(d);
  return out;
}

/** "Wed 26 Aug" from a YYYY-MM-DD key, without any timezone shift. */
function dateHeader(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return `${WEEKDAY_SHORT[dow]} ${d} ${MONTH_SHORT[m - 1]}`;
}

/**
 * What one person's cell says for one date:
 *   "P" / "A"        a recorded or assumed day
 *   "P 4h" / "A 0h"  the same, with an admin's hours override
 *   "–"              a weekday this person does not work
 *   ""               a weekend, a school closure, or a day still ahead
 */
function dayCell({ record, key, workDays }) {
  if (record) {
    const hasHours = record.hours !== null && record.hours !== undefined;
    return `${record.status === 'PRESENT' ? 'P' : 'A'}${hasHours ? ` ${fmtHours(record.hours)}h` : ''}`;
  }
  const dow = isoWeekday(key);
  if (dow <= 5 && !workDays.includes(dow)) return '–';
  return '';
}

/** Number of days an admin logged specific hours for. */
const overrideCount = (t) => t.records.filter((r) => r.hours !== null && r.hours !== undefined).length;

const sortStaff = (a, b) =>
  `${a.lastName || ''} ${a.firstName || ''}`.localeCompare(`${b.lastName || ''} ${b.firstName || ''}`);

/** Appends " (removed)" to the name of a row no longer at the school. */
const markRemoved = (existing) => {
  const values = [...existing];
  const name = String(values[1] ?? '');
  if (!name.endsWith(REMOVED_SUFFIX)) values[1] = `${name}${REMOVED_SUFFIX}`;
  return values;
};

/**
 * One pay-day tab. Row 1 names the period and how far it has run; row 2 is
 * the column header; then one row per staff member and a Total row.
 *
 * @param built a period from assembly.buildPayPeriods (teachers, throughDate, isComplete)
 */
function buildPeriodTab(built) {
  const dates = datesIn(built);
  const width = FIXED_COLUMNS.length + dates.length;

  const scope = built.isComplete
    ? 'Period complete'
    : `Through ${longDate(built.throughDate)} — pay day is still ahead`;
  const infoRow = [
    `${periodTabTitle(built)} · ${longDate(built.startDate)} – ${longDate(built.endDate)}`,
    scope,
  ];
  const headerRow = [...FIXED_COLUMNS, ...dates.map(dateHeader)];

  const teachers = [...built.teachers].sort(sortStaff);
  const rows = teachers.map((t) => {
    const byDate = new Map(t.records.map((r) => [dateKey(r.attendanceDate), r]));
    return {
      id: t.teacherId,
      values: [
        t.teacherId,
        staffName(t),
        t.presentDays,
        t.absentDays,
        `${t.elapsedWorkingDays} / ${t.workingDays}`,
        t.hoursPerDay,
        t.hoursWorked,
        overrideCount(t),
        ...dates.map((key) => dayCell({ record: byDate.get(key) || null, key, workDays: t.workDays || [1, 2, 3, 4, 5] })),
      ],
    };
  });

  const totalHours = Math.round(teachers.reduce((sum, t) => sum + (Number(t.hoursWorked) || 0), 0) * 100) / 100;
  rows.push({ id: TOTAL_ID, values: [TOTAL_ID, 'Total', '', '', '', '', totalHours, ''] });

  return {
    title: periodTabTitle(built),
    legacyTitles: [legacyPeriodTabTitle(built)],
    headerRows: [infoRow, headerRow],
    rows,
    width,
    pinnedBottomId: TOTAL_ID,
    missing: { mark: markRemoved },
    format: {
      frozenRows: 2,
      frozenColumns: 2,
      hiddenColumns: [0],
      columnWidths: [
        { start: 1, end: 2, pixels: 180 },
        { start: 2, end: FIXED_COLUMNS.length, pixels: 110 },
        { start: FIXED_COLUMNS.length, end: width, pixels: 76 },
      ],
      rowColours: assignStaffColours(teachers),
      totalId: TOTAL_ID,
    },
  };
}

/**
 * The Overview tab: one row per staff member, one column per pay day with
 * the hours worked in that period (hours to date for the one in progress),
 * and a Total column and row.
 */
function buildOverviewTab(builtPeriods) {
  const width = 3 + builtPeriods.length;

  const staff = new Map();
  builtPeriods.forEach((p, i) => {
    for (const t of p.teachers) {
      if (!staff.has(t.teacherId)) staff.set(t.teacherId, { ...t, hours: Array(builtPeriods.length).fill(0) });
      staff.get(t.teacherId).hours[i] = Number(t.hoursWorked) || 0;
    }
  });

  const round = (n) => Math.round(n * 100) / 100;
  const people = [...staff.values()].sort(sortStaff);
  const rows = people.map((t) => ({
    id: t.teacherId,
    values: [t.teacherId, staffName(t), ...t.hours.map(round), round(t.hours.reduce((a, b) => a + b, 0))],
  }));

  const columnTotals = builtPeriods.map((_, i) => round(people.reduce((sum, t) => sum + t.hours[i], 0)));
  rows.push({
    id: TOTAL_ID,
    values: [TOTAL_ID, 'Total', ...columnTotals, round(columnTotals.reduce((a, b) => a + b, 0))],
  });

  return {
    title: OVERVIEW_TAB,
    legacyTitles: [],
    headerRows: [['Staff ID', 'Staff member', ...builtPeriods.map(periodTabTitle), 'Total']],
    rows,
    width,
    pinnedBottomId: TOTAL_ID,
    missing: { mark: markRemoved },
    format: {
      frozenRows: 1,
      frozenColumns: 2,
      hiddenColumns: [0],
      columnWidths: [
        { start: 1, end: 2, pixels: 180 },
        { start: 2, end: width, pixels: 190 },
      ],
      rowColours: assignStaffColours(people),
      totalId: TOTAL_ID,
    },
  };
}

module.exports = {
  OVERVIEW_TAB,
  TOTAL_ID,
  REMOVED_SUFFIX,
  FIXED_COLUMNS,
  STAFF_PALETTE,
  longMonthDate,
  periodTabTitle,
  legacyPeriodTabTitle,
  assignStaffColours,
  periodsForYear,
  datesIn,
  dateHeader,
  dayCell,
  buildPeriodTab,
  buildOverviewTab,
};
