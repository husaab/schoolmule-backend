// services/classroom/classroomDigest.js
//
// The classroom emails' pure rules (no database): the America/Toronto clock
// the schedule runs on, the digest keys that keep each email to one per
// recipient (see classroom_email_jobs' unique index), the subjects and labels
// of the P3 board, and which work rows land in which section of the missing
// alert and the weekly (or daily) summary. classroomNotifier.js does the I/O.

const TZ = 'America/Toronto';
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 15 * 60 * 1000;

// Gates, Toronto time (spec §7): due-tomorrow reminders at 5 pm, the missing
// alert and the summaries at 4 pm.
const DUE_REMINDER_HOUR = 17;
const MISSING_ALERT_HOUR = 16;
const SUMMARY_HOUR = 16;
const DEFAULT_SUMMARY_DOW = 5; // Friday
// The summary's Missing section: work still missing that was due (or dated)
// in the last 14 days, the same window as the parent's "Needs you".
const MISSING_DAYS = 14;
const DUE_NEXT_DAYS = 7;

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const partsFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
});

const time = (v) => (v == null ? null : new Date(v).getTime());

/** The Toronto calendar date, hour (0-23) and weekday (0 = Sunday) of an instant. */
function torontoParts(now) {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, dow: WEEKDAYS[p.weekday] };
}

/** 'YYYY-MM-DD' plus n calendar days. */
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant a Toronto wall-clock hour falls on, for a 'YYYY-MM-DD' (DST-safe:
 * the offset is read back from the Toronto clock, not assumed).
 */
function torontoInstant(date, hour) {
  const [y, m, d] = date.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d, hour) + 5 * 60 * 60 * 1000; // EST guess
  for (let i = 0; i < 3; i += 1) {
    const p = torontoParts(t);
    const diffDays = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / DAY_MS);
    const diff = diffDays * 24 + (hour - p.hour);
    if (diff === 0) break;
    t += diff * 60 * 60 * 1000;
  }
  return new Date(t);
}

/**
 * The fixed windows the daily sweeps read, anchored to 4 pm Toronto so a
 * re-run later the same day (a restart, another instance) reads exactly the
 * same window: the missing alert and the daily summary cover (yesterday
 * 4 pm, today 4 pm], the weekly summary (a week ago 4 pm, today 4 pm].
 */
function sweepWindows(now) {
  const { date } = torontoParts(now);
  const until = torontoInstant(date, SUMMARY_HOUR);
  return {
    until,
    day: torontoInstant(addDays(date, -1), SUMMARY_HOUR),
    week: torontoInstant(addDays(date, -7), SUMMARY_HOUR),
  };
}

/** The weekday (0 = Sunday) of a 'YYYY-MM-DD'. */
const dowOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The ISO week of the Toronto date, e.g. '2026-W42' (weeks start on Monday). */
function isoWeekKey(now) {
  const { date } = torontoParts(now);
  const [y, m, d] = date.split('-').map(Number);
  const day = Date.UTC(y, m - 1, d);
  const thursday = new Date(day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The 15-minute bucket a publish falls in; its key names the bucket's start. */
function gradedBucket(now) {
  const start = new Date(Math.floor(new Date(now).getTime() / BUCKET_MS) * BUCKET_MS);
  return { key: `graded:${start.toISOString()}`, start, end: new Date(start.getTime() + BUCKET_MS) };
}

/**
 * Which scheduled emails may go out now. The weekly summary goes on the
 * recipient's day: their own pick, else the school's, else Friday.
 */
function scheduleGates(now, { schoolDow = null, prefsDow = null } = {}) {
  const { hour, dow } = torontoParts(now);
  const day = prefsDow ?? schoolDow ?? DEFAULT_SUMMARY_DOW;
  return {
    dueReminder: hour >= DUE_REMINDER_HOUR,
    missingAlert: hour >= MISSING_ALERT_HOUR,
    dailySummary: hour >= SUMMARY_HOUR,
    weeklySummary: hour >= SUMMARY_HOUR && dow === Number(day),
  };
}

// ── Labels ─────────────────────────────────────────────────────────────────

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 'Oct 12–16', 'Oct 29–Nov 2', 'Oct 16' (dates are 'YYYY-MM-DD'). */
function weekLabel(from, to) {
  const [, fm, fd] = from.split('-').map(Number);
  const [, tm, td] = to.split('-').map(Number);
  if (from === to) return `${MONTHS[fm - 1]} ${fd}`;
  return fm === tm ? `${MONTHS[fm - 1]} ${fd}–${td}` : `${MONTHS[fm - 1]} ${fd}–${MONTHS[tm - 1]} ${td}`;
}

/**
 * The days a weekly summary's heading covers: the week up to the summary's
 * day, starting on Monday when the six days before begin on a weekend.
 */
function summaryRange(now) {
  const to = torontoParts(now).date;
  let from = addDays(to, -6);
  const dow = dowOf(from);
  if (dow === 6) from = addDays(from, 2);
  else if (dow === 0) from = addDays(from, 1);
  return { from, to };
}

// A child's counts for the subject, most pressing first, at most two (the
// board: a child with Missing, new grades and a post reads "1 missing, 2 new
// grades"), so the subject stays short enough for an inbox line.
const SUBJECT_PARTS = 2;
const childParts = (c) => [
  c.missing ? `${c.missing} missing` : null,
  c.newGrades ? plural(c.newGrades, 'new grade') : null,
  c.posts ? plural(c.posts, 'post') : null,
].filter(Boolean).slice(0, SUBJECT_PARTS);

/**
 * "Your week: Yusuf has 1 missing, 2 new grades · Maryam: 2 posts". Children
 * with nothing are left out; when no one has anything, the period's label.
 * @param {{ name, missing?, newGrades?, posts? }[]} children
 */
function summarySubject(children, { period = 'week', label = '' } = {}) {
  const prefix = period === 'day' ? 'Your day' : 'Your week';
  const shown = children.map((c) => ({ name: c.name, parts: childParts(c) })).filter((c) => c.parts.length);
  if (!shown.length) return label ? `${prefix}: ${label}` : prefix;
  return `${prefix}: ${shown.map((c, i) => `${c.name}${i === 0 ? ' has' : ':'} ${c.parts.join(', ')}`).join(' · ')}`;
}

/** "Missing work: Yusuf (1), Maryam (2)"; children with none are left out. */
function missingSubject(children) {
  const counts = children
    .map((c) => ({ name: c.name, n: c.count ?? (c.items ? c.items.length : 0) }))
    .filter((c) => c.n > 0);
  return `Missing work: ${counts.map((c) => `${c.name} (${c.n})`).join(', ')}`;
}

/** 'Tue, Oct 13' for an instant (Toronto) or a 'YYYY-MM-DD'. */
function dayLabel(value) {
  const isDate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const at = isDate ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return at.toLocaleDateString('en-US', { timeZone: isDate ? 'UTC' : TZ, weekday: 'short', month: 'short', day: 'numeric' });
}

/** 'Mon' for an instant, Toronto time. */
const weekdayShort = (value) => new Date(value).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });

/** '11:59 PM' for an instant, Toronto time. */
const timeLabel = (value) => new Date(value).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

/** 'Grade 5', or 'JK' / 'SK' as they are. */
const gradeLabel = (grade) => (grade === 'JK' || grade === 'SK' ? grade : `Grade ${grade}`);

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/** "Yusuf's", "Yusuf's and Maryam's", "A's, B's and C's". */
function possessiveNames(names) {
  const owned = names.map((n) => `${n}'s`);
  if (owned.length <= 1) return owned.join('');
  return `${owned.slice(0, -1).join(', ')} and ${owned[owned.length - 1]}`;
}

/** 'Fridays' for 5. */
const dowPlural = (dow) => `${DOW_NAMES[Number(dow)] ?? DOW_NAMES[DEFAULT_SUMMARY_DOW]}s`;

const num = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
};

/** '8/10', '9' (no points), 'Excused', or null when there is no score to show. */
function scoreLabel({ score, maxScore, status }) {
  if (status === 'excused') return 'Excused';
  if (status === 'missing') return 'Missing';
  if (score === null || score === undefined) return null;
  return maxScore ? `${num(score)}/${num(maxScore)}` : num(score);
}

/** One line of a longer text, at most `max` characters. */
function excerpt(value, max = 140) {
  const flat = String(value || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The start of a longer text with its line breaks (at most one blank line), at most `max` characters. */
function excerptLines(value, max = 600) {
  const text = String(value || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ── Sections ───────────────────────────────────────────────────────────────
// Rows are a child's visible work (classroomEmail.queries.js selectChildWork):
// state is the one WorkStatus rule, the grade and feedback columns are set
// only when the child and parent may see them.

const isTurnIn = (r) => r.kind === 'quiz' || r.kind === 'assignment';
const itemDay = (r) => (r.due_at ? torontoParts(r.due_at).date : r.date || null);
const newestDueFirst = (a, b) => (time(b.due_at) ?? time(b.date)) - (time(a.due_at) ?? time(a.date)) || String(a.title).localeCompare(String(b.title));
const soonestDueFirst = (a, b) => time(a.due_at) - time(b.due_at) || String(a.title).localeCompare(String(b.title));
const within = (value, since, until) => value != null && time(value) > time(since) && (until == null || time(value) <= time(until));

/** Still missing now, newest due first (the missing alert's rows, re-read at send time). */
const stillMissing = (rows) => rows.filter((r) => r.state === 'missing').sort(newestDueFirst);

/**
 * The summary's sections for one child's rows.
 * - missing: still missing, due or dated in the last 14 days;
 * - grades: a grade (or, on work with no gradebook column, feedback) that
 *   reached the child in (since, until]; kindergarten classes are graded on
 *   skills elsewhere, so their columns are left out as in the parent portal;
 * - due: not turned in and still to come, by the end of tomorrow (daily) or
 *   within a week (weekly).
 */
function summarySections(rows, { since, until = null, now, frequency = 'weekly' }) {
  const today = torontoParts(now).date;
  const missingFrom = addDays(today, -MISSING_DAYS);
  const dueTo = addDays(today, frequency === 'daily' ? 1 : DUE_NEXT_DAYS);
  const missing = rows.filter((r) => r.state === 'missing' && (itemDay(r) ?? '') >= missingFrom).sort(newestDueFirst);
  const grades = rows
    .filter((r) => (r.grade_visible
      ? r.status !== 'missing' && within(r.grade_published_at, since, until) && r.class_grade !== 'JK' && r.class_grade !== 'SK'
      : !r.assessment_id && Boolean(r.feedback) && within(r.feedback_published_at, since, until)))
    .sort((a, b) => time(a.grade_published_at ?? a.feedback_published_at) - time(b.grade_published_at ?? b.feedback_published_at));
  const due = rows
    .filter((r) => r.state === 'assigned' && isTurnIn(r) && r.due_at && time(r.due_at) > time(now) && itemDay(r) <= dueTo)
    .sort(soonestDueFirst);
  return { missing, grades, due };
}

/** "was due Tue, Oct 13", "on Tue, Oct 13" (a dated assessment), or null. */
function whenLabel(row) {
  if (row.due_at) return `was due ${dayLabel(row.due_at)}`;
  if (row.date) return `on ${dayLabel(row.date)}`;
  return null;
}

module.exports = {
  TZ,
  DEFAULT_SUMMARY_DOW,
  MISSING_DAYS,
  torontoParts,
  torontoInstant,
  sweepWindows,
  addDays,
  isoWeekKey,
  gradedBucket,
  scheduleGates,
  weekLabel,
  summaryRange,
  summarySubject,
  missingSubject,
  dayLabel,
  weekdayShort,
  timeLabel,
  gradeLabel,
  firstName,
  possessiveNames,
  dowPlural,
  scoreLabel,
  excerpt,
  excerptLines,
  stillMissing,
  summarySections,
  whenLabel,
};
