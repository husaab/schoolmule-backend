// utils/calendarDate.js
//
// A date someone typed, read as a real day of the calendar.
//
// Accepts ISO (what a date input produces) and D/M/Y typed into a text field
// with /, - or . between the parts (read day-first, the en-CA convention used
// across the app). Refuses a day that doesn't exist, such as 31 February or
// 31 April: Postgres refuses those too, and a refused cast inside an import
// used to cancel every other row with it.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD when year/month/day name a real day, else null. */
function isoFromParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  // Date.UTC rolls an impossible day over into the next month, so a date that
  // doesn't come back unchanged was never a real one.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * { ok: true, value: 'YYYY-MM-DD' }, or { ok: false, reason } where reason is
 * 'format' (not written as a date at all) or 'impossible' (written as a date,
 * but that day doesn't exist).
 */
function parseCalendarDate(raw) {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();

  let parts = null;
  const iso = text.match(ISO_RE);
  if (iso) {
    parts = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    const dmy = text.match(DMY_RE);
    if (dmy) parts = [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
  }
  if (!parts) return { ok: false, reason: 'format' };

  const value = isoFromParts(...parts);
  return value ? { ok: true, value } : { ok: false, reason: 'impossible' };
}

/** The sentence shown for a date that couldn't be read. */
function dateError(raw, reason) {
  return reason === 'impossible'
    ? `"${raw}" is not a real date`
    : `"${raw}" is not a recognizable date`;
}

/**
 * The same reading, with the sentence to show when it fails:
 * { ok: true, value: 'YYYY-MM-DD' } or { ok: false, error }.
 */
function readCalendarDate(raw) {
  const parsed = parseCalendarDate(raw);
  return parsed.ok ? parsed : { ok: false, error: dateError(String(raw).trim(), parsed.reason) };
}

module.exports = { parseCalendarDate, readCalendarDate, isoFromParts, dateError };
