// services/staffAttendance/assembly.js
//
// Turns raw attendance rows into what every staff-attendance surface shows:
// each person's records over a date range with assumed-present days and paid
// holidays filled in, their work days, working-day counts and hours worked.
// Shared by the HTTP controller (month view, pay-period view, PDF) and the
// Google Sheet sync engine, which has no request to hang this off.

const db = require("../../config/database");
const teacherAttendanceQueries = require("../../queries/teacherAttendance.queries");
const payPeriods = require("../payPeriods");
const { statHolidaysBetween } = require("./statHolidays");

/**
 * Staff are assumed present on every open school day from this date onward
 * unless they — or an admin — recorded something else. Floored at the start of
 * the 2026-2027 year so earlier years keep exactly the records they have.
 * Combined with the calendar rule, the first assumed day for a school is its
 * first non-closed weekday: Sept 8, 2026 for Al Haadi (Sept 7 is Labour Day).
 */
const ASSUMED_PRESENT_FROM = "2026-09-01";

/** Hours a work day is worth when neither the school nor the person says. */
const DEFAULT_HOURS_PER_DAY = 7.5;

const EVERY_WEEKDAY = [1, 2, 3, 4, 5];

/** Normalize a pg DATE (or ISO string) to a YYYY-MM-DD key without shifting timezone. */
const dateKey = (value) => {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).substring(0, 10);
};

/** Today for every tenant (all Ontario schools), matching selectOpenSchoolDays' is_elapsed. */
const torontoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

/** First and last day of a YYYY-MM month. */
const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { start: `${month}-01`, end: payPeriods.clampedDay(y, m, 31) };
};

/** ISO weekday (Monday = 1 … Sunday = 7) of a YYYY-MM-DD key, in local time. */
const isoWeekday = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 ? 7 : dow;
};

const mapRecord = (row) => ({
  attendanceDate: row.attendance_date,
  status: row.status,
  notes: row.notes ?? null,
  hours: row.hours === null || row.hours === undefined ? null : Number(row.hours),
});

// ─── Loaders ──────────────────────────────────────────────────────────────

/**
 * Sorts the school's weekdays (selectSchoolDays rows) into what staff get:
 *  - openDays: days they are expected in — no closure, or a closure the
 *    school marked as a staff work day (a PA day)
 *  - paidHolidays: Ontario stat holidays (whatever the calendar says) and
 *    closures marked as paid, each with the name to show
 * Any other closure is an unpaid day off and appears in neither.
 */
const classifySchoolDays = (rows) => {
  const openDays = [];
  const paidHolidays = [];
  if (rows.length === 0) return { openDays, paidHolidays };

  const stats = statHolidaysBetween(rows[0].day, rows[rows.length - 1].day);
  for (const row of rows) {
    const day = { day: row.day, isElapsed: row.is_elapsed };
    const staffDay = row.closed_staff_day ?? null;
    if (stats.has(row.day)) paidHolidays.push({ ...day, name: stats.get(row.day) });
    else if (staffDay === "paid") paidHolidays.push({ ...day, name: row.closure_title });
    else if (staffDay === null || staffDay === "work") openDays.push(day);
  }
  return { openDays, paidHolidays };
};

const loadSchoolDays = async (start, end, school) => {
  const { rows } = await db.query(teacherAttendanceQueries.selectSchoolDays, [start, end, school]);
  return classifySchoolDays(rows);
};

/**
 * Each staff member's work profile over a range, keyed by user_id: the days
 * they work (admin override → schedule planner → every weekday) and their
 * admin-set hours per day, if any. `source` lets the UI say where days came from.
 */
const loadWorkDays = async (start, end, school, userId = null) => {
  const { rows } = await db.query(teacherAttendanceQueries.selectWorkDayInputs, [school, start, end, userId]);
  const byUser = new Map();
  for (const row of rows) {
    const hoursPerDay = row.hours_per_day === null || row.hours_per_day === undefined ? null : Number(row.hours_per_day);
    if (row.is_archived) {
      // Archived staff work no days: nothing is assumed, only real check-ins show.
      byUser.set(row.user_id, { days: [], source: "archived", hoursPerDay });
    } else if (row.custom_days?.length) {
      byUser.set(row.user_id, { days: row.custom_days.map(Number), source: "custom", hoursPerDay });
    } else if (row.planner_days?.length) {
      byUser.set(row.user_id, { days: row.planner_days.map(Number), source: "planner", hoursPerDay });
    } else {
      byUser.set(row.user_id, { days: EVERY_WEEKDAY, source: "default", hoursPerDay });
    }
  }
  return byUser;
};

const DEFAULT_PROFILE = { days: EVERY_WEEKDAY, source: "default", hoursPerDay: null };

const mapSchedule = (row) =>
  row
    ? {
        frequency: row.frequency,
        payDayOfMonth: row.pay_day_of_month ?? null,
        secondPayDayOfMonth: row.second_pay_day_of_month ?? null,
        anchorPayDate: row.anchor_pay_date ? dateKey(row.anchor_pay_date) : null,
        defaultHoursPerDay: Number(row.default_hours_per_day),
        // pg returns TIME as "HH:MM:SS"; the API speaks "HH:MM".
        workDayStart: row.work_day_start ? String(row.work_day_start).substring(0, 5) : null,
        workDayStartLabel: payPeriods.describeWorkDayStart(row.work_day_start),
        description: payPeriods.describeSchedule({
          frequency: row.frequency,
          payDayOfMonth: row.pay_day_of_month,
          secondPayDayOfMonth: row.second_pay_day_of_month,
          anchorPayDate: row.anchor_pay_date ? dateKey(row.anchor_pay_date) : null,
        }),
        updatedAt: row.updated_at ?? null,
      }
    : null;

const loadPaySchedule = async (school) => {
  const { rows } = await db.query(teacherAttendanceQueries.selectPaySchedule, [school]);
  return mapSchedule(rows[0]);
};

// ─── Attendance assembly ──────────────────────────────────────────────────

/** Open school days this person actually works — their expected days. */
const expectedDaysFor = (openDays, workDays) =>
  openDays.filter((d) => workDays.days.includes(isoWeekday(d.day)));

/**
 * Fill in the days a teacher never explicitly recorded. Any elapsed expected
 * day (open school day they work) on or after ASSUMED_PRESENT_FROM with no
 * record of its own reads as PRESENT — assumed and confirmed days are
 * deliberately indistinguishable. Days they don't work stay empty, but a real
 * check-in on one (covering a shift) is kept and counts.
 *
 * Nothing is written to the database, so the dashboard check-in prompt is
 * unaffected: it reads teacher_attendance directly and keeps asking until a
 * real row exists.
 */
const withAssumedPresent = (records, expectedDays) => {
  const recorded = new Set(records.map((r) => dateKey(r.attendanceDate)));

  const assumed = expectedDays
    .filter((d) => d.isElapsed && d.day >= ASSUMED_PRESENT_FROM && !recorded.has(d.day))
    .map((d) => ({ attendanceDate: d.day, status: "PRESENT", notes: null, hours: null }));

  return [...records, ...assumed].sort((a, b) =>
    dateKey(a.attendanceDate).localeCompare(dateKey(b.attendanceDate))
  );
};

/**
 * Add a HOLIDAY record for each paid holiday that has passed, falls on one
 * of the person's work days and has no record of its own (a real record —
 * someone came in, or an admin set the hours — stands in for it). Like
 * assumed-present days, these are never written to the database. Floored at
 * ASSUMED_PRESENT_FROM so earlier years keep exactly the records they have.
 */
const withPaidHolidays = (records, paidHolidays, profile) => {
  const recorded = new Set(records.map((r) => dateKey(r.attendanceDate)));

  const holidays = paidHolidays
    .filter((d) => d.isElapsed && d.day >= ASSUMED_PRESENT_FROM && !recorded.has(d.day))
    .filter((d) => profile.days.includes(isoWeekday(d.day)))
    .map((d) => ({ attendanceDate: d.day, status: "HOLIDAY", notes: null, hours: null, holidayName: d.name }));

  return [...records, ...holidays].sort((a, b) =>
    dateKey(a.attendanceDate).localeCompare(dateKey(b.attendanceDate))
  );
};

/** One person's assembled range: records with assumed days and paid holidays, work days, hours. */
const assemblePerson = (records, openDays, profile, schoolHoursPerDay, paidHolidays = []) => {
  const expectedDays = expectedDaysFor(openDays, profile);
  const filled = withPaidHolidays(withAssumedPresent(records, expectedDays), paidHolidays, profile);
  const hoursPerDay = profile.hoursPerDay ?? schoolHoursPerDay;
  return {
    records: filled,
    workDays: profile.days,
    workDaysSource: profile.source,
    workingDays: expectedDays.length,
    elapsedWorkingDays: expectedDays.filter((d) => d.isElapsed).length,
    presentDays: filled.filter((r) => r.status === "PRESENT").length,
    absentDays: filled.filter((r) => r.status === "ABSENT").length,
    holidayDays: filled.filter((r) => r.status === "HOLIDAY").length,
    hoursPerDay,
    hoursPerDaySource: profile.hoursPerDay !== null ? "custom" : "school",
    hoursWorked: payPeriods.sumHours(filled, hoursPerDay),
  };
};

/**
 * Everything the assembly needs for a date range, loaded once: attendance
 * rows for every teacher (or one), open school days and paid holidays, work
 * profiles and the pay schedule. Kept separate from assembleRange so a caller
 * with several sub-ranges (the sheet sync, one tab per pay period) loads once
 * and slices.
 */
const loadRangeInputs = async (start, end, school, userId = null) => {
  const [dataResult, { openDays, paidHolidays }, profiles, schedule] = await Promise.all([
    db.query(teacherAttendanceQueries.selectAllForSchoolRange, [start, end, school, userId]),
    loadSchoolDays(start, end, school),
    loadWorkDays(start, end, school, userId),
    loadPaySchedule(school),
  ]);
  return {
    rows: dataResult.rows,
    openDays,
    paidHolidays,
    profiles,
    schedule,
    schoolHoursPerDay: schedule?.defaultHoursPerDay ?? DEFAULT_HOURS_PER_DAY,
  };
};

/**
 * Assemble every teacher from inputs already loaded. With a `slice`, rows,
 * open days and paid holidays outside [slice.start, slice.end] are ignored, so
 * inputs loaded for a wider span (one query for a whole year of pay periods)
 * carve up correctly.
 * Without one, everything loaded counts — the queries already scoped it.
 */
const assembleRange = (inputs, slice = null) => {
  const { rows, profiles, schedule, schoolHoursPerDay } = inputs;
  const inSlice = (key) => !slice || (key >= slice.start && key <= slice.end);
  const openDays = inputs.openDays.filter((d) => inSlice(d.day));
  const paidHolidays = (inputs.paidHolidays ?? []).filter((d) => inSlice(d.day));

  const teacherMap = {};
  rows.forEach((row) => {
    const tid = row.teacher_id;
    if (!teacherMap[tid]) {
      teacherMap[tid] = {
        teacherId: tid,
        firstName: row.first_name,
        lastName: row.last_name,
        username: row.username,
        records: [],
      };
    }
    if (row.attendance_date && inSlice(dateKey(row.attendance_date))) {
      teacherMap[tid].records.push(mapRecord(row));
    }
  });

  const teachers = Object.values(teacherMap).map((t) => ({
    ...t,
    ...assemblePerson(t.records, openDays, profiles.get(t.teacherId) ?? DEFAULT_PROFILE, schoolHoursPerDay, paidHolidays),
  }));

  // Top-level workingDays stays the school's open days for older clients.
  return { teachers, workingDays: openDays.length, schedule, schoolHoursPerDay };
};

/**
 * Shared read path for the admin views, the pay-period views and the PDF:
 * every teacher at the school (or one, with userId) with their records over
 * a date range, assumed-present days and paid holidays included, plus work
 * days, working-day count and hours worked.
 */
const buildSchoolRange = async (start, end, school, userId = null) =>
  assembleRange(await loadRangeInputs(start, end, school, userId));

const buildSchoolMonth = (month, school) => {
  const { start, end } = monthRange(month);
  return buildSchoolRange(start, end, school);
};

/** Labels a period so a report can say "through Sept 23" while the pay day is still ahead. */
const withProgress = (period, teachers, today) => ({
  ...period,
  throughDate: period.endDate < today ? period.endDate : today,
  isComplete: period.endDate <= today,
  teachers,
});

/**
 * A pay period with everyone's hours: the range assembled for the period,
 * trimmed to what has elapsed, and labelled so a report can say "through
 * Sept 23" while the pay day is still ahead.
 */
const buildPayPeriod = async (period, school, userId = null) => {
  const { teachers } = await buildSchoolRange(period.startDate, period.endDate, school, userId);
  return withProgress(period, teachers, torontoToday());
};

/**
 * Several pay periods at once — the sheet sync's whole school year — with a
 * single set of queries over the span they cover rather than one per period.
 * Periods are returned in the order given.
 */
const buildPayPeriods = async (periods, school) => {
  if (periods.length === 0) return [];
  const start = periods.reduce((min, p) => (p.startDate < min ? p.startDate : min), periods[0].startDate);
  const end = periods.reduce((max, p) => (p.endDate > max ? p.endDate : max), periods[0].endDate);
  const inputs = await loadRangeInputs(start, end, school);
  const today = torontoToday();
  return periods.map((p) => withProgress(p, assembleRange(inputs, { start: p.startDate, end: p.endDate }).teachers, today));
};

module.exports = {
  ASSUMED_PRESENT_FROM,
  DEFAULT_HOURS_PER_DAY,
  EVERY_WEEKDAY,
  DEFAULT_PROFILE,
  dateKey,
  torontoToday,
  monthRange,
  isoWeekday,
  mapRecord,
  mapSchedule,
  classifySchoolDays,
  loadSchoolDays,
  loadWorkDays,
  loadPaySchedule,
  expectedDaysFor,
  withAssumedPresent,
  withPaidHolidays,
  assemblePerson,
  loadRangeInputs,
  assembleRange,
  buildSchoolRange,
  buildSchoolMonth,
  buildPayPeriod,
  buildPayPeriods,
};
