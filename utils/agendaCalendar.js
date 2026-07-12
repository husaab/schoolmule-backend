// src/utils/agendaCalendar.js
//
// Pure date math for the agenda feature. All functions work on plain
// { year, month, day } integers (month 1-12) so results are identical
// regardless of server timezone.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Day of week for a calendar date: 0 = Sunday .. 6 = Saturday. */
function dayOfWeek(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Number of days in a month (handles leap years). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add days to a date, returning { year, month, day }. */
function addDays(year, month, day, delta) {
  const d = new Date(Date.UTC(year, month - 1, day) + delta * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Parse '2026-2027' into { startYear: 2026, endYear: 2027 }.
 * Throws on malformed input (defense for user-supplied academic years).
 */
function parseAcademicYear(academicYear) {
  const match = /^(\d{4})-(\d{4})$/.exec(academicYear || '');
  if (!match) {
    throw new Error(`Invalid academic year "${academicYear}" — expected format YYYY-YYYY`);
  }
  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  if (endYear !== startYear + 1) {
    throw new Error(`Invalid academic year "${academicYear}" — years must be consecutive`);
  }
  return { startYear, endYear };
}

/**
 * Date window for an academic year, for calendar-event queries:
 * '2026-2027' -> { from: '2026-08-01', to: '2027-07-31' }.
 */
function academicYearToRange(academicYear) {
  const { startYear, endYear } = parseAcademicYear(academicYear);
  return { from: `${startYear}-08-01`, to: `${endYear}-07-31` };
}

/**
 * Ordered [{ year, month }] for an agenda's months. Months >= startMonth
 * belong to the academic year's first calendar year, the rest to the second.
 * Default September (9) .. June (6).
 */
function academicMonthSequence(academicYear, startMonth = 9, endMonth = 6) {
  const { startYear, endYear } = parseAcademicYear(academicYear);
  const months = [];
  let month = startMonth;
  for (;;) {
    months.push({ year: month >= startMonth ? startYear : endYear, month });
    if (month === endMonth) break;
    month = (month % 12) + 1;
    if (months.length > 12) throw new Error('Invalid start/end month combination');
  }
  return months;
}

/**
 * Month-overview grid: array of weeks (Sunday..Saturday), each cell
 * { day, inMonth }. Cells outside the month have inMonth: false and a
 * null day so templates render them empty (matching the printed agenda).
 */
function monthGrid(year, month) {
  const firstDow = dayOfWeek(year, month, 1);
  const totalDays = daysInMonth(year, month);
  const weeks = [];
  let week = new Array(firstDow).fill(null).map(() => ({ day: null, inMonth: false }));

  for (let day = 1; day <= totalDays; day++) {
    week.push({ day, inMonth: true });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push({ day: null, inMonth: false });
    weeks.push(week);
  }
  return weeks;
}

/**
 * School weeks for a month's planner section, matching the printed agenda:
 * every Monday–Friday week containing at least one weekday of this month
 * is included, and weeks spanning a month boundary appear in BOTH months.
 * Days outside the month have inMonth: false (rendered as a blank date box).
 *
 * Returns [{ mondayIso, days: [{ weekday, year, month, day, inMonth }] }].
 */
function schoolWeeksForMonth(year, month) {
  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  // Monday of the week containing the 1st (dayOfWeek: Monday=1).
  const firstDow = dayOfWeek(year, month, 1);
  const offsetToMonday = ((firstDow + 6) % 7); // days back from the 1st to Monday
  let monday = addDays(year, month, 1, -offsetToMonday);

  const weeks = [];
  for (;;) {
    const days = WEEKDAY_NAMES.map((weekday, i) => {
      const d = addDays(monday.year, monday.month, monday.day, i);
      return {
        weekday,
        year: d.year,
        month: d.month,
        day: d.day,
        inMonth: d.year === year && d.month === month,
      };
    });

    if (days.some(d => d.inMonth)) {
      weeks.push({
        mondayIso: `${monday.year}-${String(monday.month).padStart(2, '0')}-${String(monday.day).padStart(2, '0')}`,
        days,
      });
    } else if (weeks.length > 0) {
      break; // past the month
    }

    monday = addDays(monday.year, monday.month, monday.day, 7);
    // Safety: a month never spans more than 6 Monday-Friday weeks.
    if (weeks.length > 6) throw new Error('schoolWeeksForMonth exceeded 6 weeks');
    if (monday.year > year + 1) break;
  }
  return weeks;
}

module.exports = {
  parseAcademicYear,
  academicYearToRange,
  academicMonthSequence,
  monthGrid,
  schoolWeeksForMonth,
  daysInMonth,
  dayOfWeek,
  addDays,
};
