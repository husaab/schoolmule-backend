// services/reportEngine/data/format.js
//
// Pure mapping helpers for the ReportData assembler. No I/O here, so every
// rule is unit-testable on its own. The web reportkit has TypeScript twins of
// a few of these (schoolmule/src/reportkit/format.ts: termDisplay,
// gradeLabel, gradeNumber); keep them in step.

const DEFAULT_TIMEZONE = 'America/Toronto';

// The legacy formatTermDisplay map (templates/reportCardTemplate.js:701).
const TERM_DISPLAY = {
  'term 1': 'FIRST TERM',
  'term 2': 'SECOND TERM',
  'term 3': 'THIRD TERM',
  'term 4': 'FOURTH TERM',
  '1': 'FIRST TERM',
  '2': 'SECOND TERM',
  '3': 'THIRD TERM',
  '4': 'FOURTH TERM',
};

/**
 * "Term 1" → "FIRST TERM". Exactly the legacy formatTermDisplay: only the
 * bare names map; anything else is upper-cased ("Term 2 2025-2026" →
 * "TERM 2 2025-2026"), and an empty term is "TERM".
 */
function termLabel(term) {
  const normalized = String(term ?? '').toLowerCase().trim();
  return TERM_DISPLAY[normalized] || String(term ?? '').toUpperCase() || 'TERM';
}

/** The term's number: "Term 2" / "Term 2 2025-2026" / "T2" / "2" → 2, else null. */
function termNumber(term) {
  const s = String(term ?? '');
  const named = s.match(/\bt(?:erm)?\s*(\d+)\b/i);
  if (named) return parseInt(named[1], 10);
  const bare = s.match(/^\s*(\d+)\s*$/);
  return bare ? parseInt(bare[1], 10) : null;
}

/** "2026-2027" → "2026 - 2027". Anything that isn't a year pair is kept as is. */
function formatSchoolYearLabel(label) {
  const s = String(label ?? '').trim();
  const m = s.match(/^(\d{4})\s*[-–—]\s*(\d{4})$/);
  return m ? `${m[1]} - ${m[2]}` : s;
}

/**
 * The legacy academic-year rule (templates/reportCardTemplate.js:720): the
 * year rolls over in September. Applied to a YYYY-MM-DD date.
 */
function academicYearFor(isoDate) {
  const [y, m] = String(isoDate).split('-').map((n) => parseInt(n, 10));
  // m is 1-based here; the legacy getMonth() >= 8 is September onwards.
  return m >= 9 ? `${y} - ${y + 1}` : `${y - 1} - ${y}`;
}

/** 'JK' | 'SK' | '1'..'8' as text. */
function gradeText(grade) {
  return String(grade ?? '').trim().toUpperCase();
}

function gradeLabel(grade) {
  const g = gradeText(grade);
  if (g === 'JK') return 'Junior Kindergarten';
  if (g === 'SK') return 'Senior Kindergarten';
  return g ? `Grade ${g}` : '';
}

/** JK = -1, SK = 0, else the grade's integer (0 when it isn't one). */
function gradeNumber(grade) {
  const g = gradeText(grade);
  if (g === 'JK') return -1;
  if (g === 'SK') return 0;
  const n = parseInt(g, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** "Test Student A" → { firstName: "Test", lastName: "Student A" }. */
function splitName(name) {
  const s = String(name ?? '').trim();
  const i = s.search(/\s/);
  if (i < 0) return { firstName: s, lastName: '' };
  return { firstName: s.slice(0, i), lastName: s.slice(i).trim() };
}

/** "language_arts" → "Language Arts". */
function humanizeKey(key) {
  return String(key ?? '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The school enum value the legacy code compares against ("Al Haadi" → "ALHAADI"). */
function normalizeSchoolCode(school) {
  return String(school ?? '').replace(/\s+/g, '').toUpperCase();
}

/**
 * The Al Haadi Term-2 three-row report card applies (same test as
 * controllers/reportCard.controller.js:600-603).
 */
function isAlHaadiT2(school, term) {
  return normalizeSchoolCode(school) === 'ALHAADIACADEMY'
    && String(term || '').toLowerCase().includes('term 2');
}

/** Today (or `now`) as YYYY-MM-DD in `timeZone`; an unknown zone falls back to Toronto. */
function isoDateInTimeZone(timeZone, now = new Date()) {
  const format = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  try {
    return format(timeZone || DEFAULT_TIMEZONE);
  } catch (err) {
    return format(DEFAULT_TIMEZONE);
  }
}

/** The legacy generatedDate: today in en-CA (YYYY-MM-DD), server-local. */
function generatedDateToday(now = new Date()) {
  return now.toLocaleDateString('en-CA');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** null/undefined → '', everything else as text. */
function text(value) {
  return value == null ? '' : String(value);
}

module.exports = {
  DEFAULT_TIMEZONE,
  termLabel,
  termNumber,
  formatSchoolYearLabel,
  academicYearFor,
  gradeText,
  gradeLabel,
  gradeNumber,
  splitName,
  humanizeKey,
  normalizeSchoolCode,
  isAlHaadiT2,
  isoDateInTimeZone,
  generatedDateToday,
  isIsoDate,
  text,
};
