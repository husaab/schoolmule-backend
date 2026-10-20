// services/staffAttendance/statHolidays.js
//
// Ontario's public (statutory) holidays under the Employment Standards Act,
// worked out from the date alone. Every tenant is an Ontario school, so staff
// are paid for these without anyone entering them in the school calendar.
// Civic Holiday and Easter Monday are not on the list; a school that pays for
// them marks the calendar event as a paid holiday instead.

const pad = (n) => String(n).padStart(2, "0");
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Day of the week (Sunday = 0) of a date, computed in UTC so no timezone shifts it. */
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The nth Monday (1-based) of a month. */
const nthMonday = (y, m, n) => {
  const first = weekday(y, m, 1);
  return key(y, m, 1 + ((8 - first) % 7) + (n - 1) * 7);
};

/** Easter Sunday (Gregorian), by the anonymous computus. */
const easterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return key(year, month, day);
};

const shift = (dateKey, days) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return key(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
};

const isWeekend = (dateKey) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = weekday(y, m, d);
  return dow === 0 || dow === 6;
};

/**
 * One year's holidays as a Map of YYYY-MM-DD → name, in date order. A
 * fixed-date holiday that lands on a weekend is observed on the next weekday
 * that isn't already a holiday (Saturday Boxing Day → Monday; Sunday
 * Christmas → Tuesday, after a Monday Boxing Day).
 */
const ontarioStatHolidays = (year) => {
  const fixed = [
    [key(year, 1, 1), "New Year's Day"],
    [key(year, 7, 1), "Canada Day"],
    [key(year, 12, 25), "Christmas Day"],
    [key(year, 12, 26), "Boxing Day"],
  ];
  // Victoria Day: the Monday before May 25.
  const may25 = weekday(year, 5, 25);
  const moving = [
    [nthMonday(year, 2, 3), "Family Day"],
    [shift(easterSunday(year), -2), "Good Friday"],
    [key(year, 5, 25 - (may25 === 1 ? 7 : (may25 + 6) % 7)), "Victoria Day"],
    [nthMonday(year, 9, 1), "Labour Day"],
    [nthMonday(year, 10, 2), "Thanksgiving"],
  ];

  const all = [...fixed, ...moving].sort(([a], [b]) => a.localeCompare(b));
  const taken = new Set(all.filter(([day]) => !isWeekend(day)).map(([day]) => day));
  const observed = all.map(([day, name]) => {
    if (!isWeekend(day)) return [day, name];
    let next = shift(day, 1);
    while (isWeekend(next) || taken.has(next)) next = shift(next, 1);
    taken.add(next);
    return [next, `${name} (observed)`];
  });

  return new Map(observed.sort(([a], [b]) => a.localeCompare(b)));
};

/** Every holiday from start to end (YYYY-MM-DD, inclusive), as a Map of date → name. */
const statHolidaysBetween = (start, end) => {
  const out = new Map();
  for (let year = Number(start.substring(0, 4)); year <= Number(end.substring(0, 4)); year++) {
    for (const [day, name] of ontarioStatHolidays(year)) {
      if (day >= start && day <= end) out.set(day, name);
    }
  }
  return out;
};

module.exports = { easterSunday, ontarioStatHolidays, statHolidaysBetween };
