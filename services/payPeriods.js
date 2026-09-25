/**
 * Pay-period arithmetic for staff attendance. Pure date math, no DB.
 *
 * A school's pay schedule says when staff are paid. A pay period ENDS on the
 * pay day (inclusive) and starts the day after the previous pay day — so for
 * "monthly on the 25th", the period paid on Sept 25 covers Aug 26 – Sept 25.
 *
 * All dates are YYYY-MM-DD strings; nothing here touches timezones. The
 * caller decides what "today" is (see torontoToday in the controller).
 */

const FREQUENCIES = ["MONTHLY", "SEMI_MONTHLY", "BIWEEKLY", "WEEKLY"];

const pad = (n) => String(n).padStart(2, "0");

/** YYYY-MM-DD for a UTC-noon Date (noon so DST can never shift the day). */
const toKey = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const fromKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};

const addDays = (key, days) => {
  const date = fromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return toKey(date);
};

const daysBetween = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86_400_000);

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The pay day for (year, month): day-of-month clamped to the month's length. */
const clampedDay = (year, month, day) => `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;

/**
 * Every pay date with from <= date <= to, ascending.
 * Monthly frequencies walk the calendar months touching the range; weekly
 * frequencies step from the anchor. Both are cheap for any sane range.
 */
const payDatesBetween = (schedule, from, to) => {
  if (!schedule || from > to) return [];

  if (schedule.frequency === "MONTHLY" || schedule.frequency === "SEMI_MONTHLY") {
    const days = [schedule.payDayOfMonth];
    if (schedule.frequency === "SEMI_MONTHLY") days.push(schedule.secondPayDayOfMonth);

    const [fy, fm] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    const dates = [];
    for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
      for (const d of days) dates.push(clampedDay(y, m, d));
    }
    return [...new Set(dates)].filter((d) => d >= from && d <= to).sort();
  }

  const step = schedule.frequency === "WEEKLY" ? 7 : 14;
  const anchor = schedule.anchorPayDate;
  // First pay date on or after `from`.
  const offset = daysBetween(anchor, from);
  let k = Math.ceil(offset / step);
  const dates = [];
  for (let date = addDays(anchor, k * step); date <= to; k++, date = addDays(anchor, k * step)) {
    dates.push(date);
  }
  return dates;
};

// Wide enough to always contain the neighbouring pay date, for every frequency.
const LOOKBACK_DAYS = 70;

/** First pay date on or after `date`. */
const nextPayDateOnOrAfter = (schedule, date) =>
  payDatesBetween(schedule, date, addDays(date, LOOKBACK_DAYS))[0] ?? null;

/** Last pay date strictly before `date`. */
const previousPayDateBefore = (schedule, date) => {
  const dates = payDatesBetween(schedule, addDays(date, -LOOKBACK_DAYS), addDays(date, -1));
  return dates[dates.length - 1] ?? null;
};

/** The period paid on `payDate`: { payDate, startDate, endDate }. */
const periodEndingOn = (schedule, payDate) => ({
  payDate,
  startDate: addDays(previousPayDateBefore(schedule, payDate), 1),
  endDate: payDate,
});

/** The period that `date` falls in — the one paid on the next pay day. */
const periodContaining = (schedule, date) => {
  const payDate = nextPayDateOnOrAfter(schedule, date);
  return payDate ? periodEndingOn(schedule, payDate) : null;
};

/** Every period whose pay day falls inside a YYYY-MM month, ascending. */
const periodsPaidInMonth = (schedule, month) => {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = clampedDay(y, m, 31);
  return payDatesBetween(schedule, from, to).map((payDate) => periodEndingOn(schedule, payDate));
};

/**
 * Hours a single attendance record is worth. An explicit override on the
 * record wins (an admin logged a half day); otherwise a present day is a full
 * work day and an absence is nothing.
 */
const recordHours = (record, hoursPerDay) => {
  if (record.hours !== null && record.hours !== undefined) return Number(record.hours);
  return record.status === "PRESENT" ? Number(hoursPerDay) : 0;
};

const sumHours = (records, hoursPerDay) =>
  Math.round(records.reduce((total, r) => total + recordHours(r, hoursPerDay), 0) * 100) / 100;

/**
 * Validate a pay-schedule payload from the API. Returns { error } or
 * { value } with the normalized row-shaped object.
 */
const normalizeSchedule = (body) => {
  const frequency = String(body?.frequency ?? "").toUpperCase();
  if (!FREQUENCIES.includes(frequency)) {
    return { error: `frequency must be one of ${FREQUENCIES.join(", ")}` };
  }

  const hours = Number(body.defaultHoursPerDay ?? 7.5);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return { error: "defaultHoursPerDay must be between 0 and 24" };
  }

  // Optional "expected in by" time, HH:MM (24h). Empty clears it.
  let workDayStart = null;
  if (body.workDayStart !== null && body.workDayStart !== undefined && String(body.workDayStart).trim() !== "") {
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(body.workDayStart).trim());
    const hh = match ? Number(match[1]) : NaN;
    const mm = match ? Number(match[2]) : NaN;
    if (!match || hh > 23 || mm > 59) {
      return { error: "workDayStart must be a time of day (HH:MM)" };
    }
    workDayStart = `${String(hh).padStart(2, "0")}:${match[2]}`;
  }

  const dayOk = (d) => Number.isInteger(d) && d >= 1 && d <= 31;
  const value = {
    frequency,
    payDayOfMonth: null,
    secondPayDayOfMonth: null,
    anchorPayDate: null,
    defaultHoursPerDay: Math.round(hours * 100) / 100,
    workDayStart,
  };

  if (frequency === "MONTHLY" || frequency === "SEMI_MONTHLY") {
    const first = Number(body.payDayOfMonth);
    if (!dayOk(first)) return { error: "payDayOfMonth must be a day of the month (1-31)" };
    value.payDayOfMonth = first;
    if (frequency === "SEMI_MONTHLY") {
      const second = Number(body.secondPayDayOfMonth);
      if (!dayOk(second) || second === first) {
        return { error: "secondPayDayOfMonth must be a different day of the month (1-31)" };
      }
      // Keep them ordered so period math reads naturally.
      value.payDayOfMonth = Math.min(first, second);
      value.secondPayDayOfMonth = Math.max(first, second);
    }
  } else {
    const anchor = String(body.anchorPayDate ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || toKey(fromKey(anchor)) !== anchor) {
      return { error: "anchorPayDate must be a real date (YYYY-MM-DD)" };
    }
    value.anchorPayDate = anchor;
  }

  return { value };
};

/** Human label for a schedule, e.g. "Monthly on the 25th". */
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "8:30 a.m." from "08:30" / "08:30:00"; null when unset. */
const describeWorkDayStart = (time) => {
  if (!time) return null;
  const [hh, mm] = String(time).split(":").map(Number);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null;
  const suffix = hh < 12 ? "a.m." : "p.m.";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
};

const describeSchedule = (schedule) => {
  if (!schedule) return null;
  switch (schedule.frequency) {
    case "MONTHLY":
      return `Monthly on the ${ordinal(schedule.payDayOfMonth)}`;
    case "SEMI_MONTHLY":
      return `Twice a month, on the ${ordinal(schedule.payDayOfMonth)} and ${ordinal(schedule.secondPayDayOfMonth)}`;
    case "BIWEEKLY":
      return `Every second ${WEEKDAY_NAMES[fromKey(schedule.anchorPayDate).getUTCDay()]}`;
    case "WEEKLY":
      return `Every ${WEEKDAY_NAMES[fromKey(schedule.anchorPayDate).getUTCDay()]}`;
    default:
      return null;
  }
};

module.exports = {
  FREQUENCIES,
  addDays,
  clampedDay,
  payDatesBetween,
  nextPayDateOnOrAfter,
  previousPayDateBefore,
  periodEndingOn,
  periodContaining,
  periodsPaidInMonth,
  recordHours,
  sumHours,
  normalizeSchedule,
  describeSchedule,
  describeWorkDayStart,
};
