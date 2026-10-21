// scripts/seed/playground/timetable.js
//
// A clash-free week for the PLAYGROUND seed: every class group gets its
// periods per subject, no teacher is in two rooms at once, Math and Language
// Arts run at most twice a day and other subjects once, and part-time staff
// only teach on their days. Randomized greedy with restarts, seeded, so the
// same seed always gives the same timetable.

const C = require('./content');

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Friday's fifth period is Jumu'ah.
const SLOTS = [];
for (let day = 1; day <= 5; day += 1) {
  C.PERIODS.forEach((_, p) => { if (!(day === 5 && p === 4)) SLOTS.push({ day, p }); });
}

const dayCap = (subject) => {
  if (C.K_HOMEROOM.includes(subject)) return 4;
  return subject === 'Math' || subject === 'Language Arts' ? 2 : 1;
};

const staffByKey = Object.fromEntries(C.STAFF.map((s) => [s.key, s]));

// Timetable subjects per grade: kindergarten splits its homeroom time.
const timetableSubjects = (grade) => (grade === 'JK' || grade === 'SK' ? Object.keys(C.K_PERIODS) : C.subjectsFor(grade));
const periodsPerWeek = (grade, subject) => (grade === 'JK' || grade === 'SK' ? C.K_PERIODS : C.PERIODS_PER_WEEK)[subject];

function demandFor(grade) {
  return timetableSubjects(grade).map((subject) => ({ subject, left: periodsPerWeek(grade, subject), teacher: C.leadFor(grade, subject) }));
}

// Lessons go in hardest-first: part-timers, then the busiest teachers, with
// Kindergarten (one teacher, one room) filling whatever is left.
function attempt(rand) {
  const lessons = [];
  for (const grade of C.GRADES) {
    for (const d of demandFor(grade)) {
      for (let i = 0; i < d.left; i += 1) lessons.push({ grade, subject: d.subject, teacher: d.teacher });
    }
  }
  const load = {};
  for (const l of lessons) load[l.teacher] = (load[l.teacher] || 0) + 1;
  const rank = (l) => (C.K_HOMEROOM.includes(l.subject) ? -1000 : 0)
    + (staffByKey[l.teacher].workDays ? 500 : 0) + load[l.teacher] + rand() * 4;
  lessons.forEach((l) => { l.rank = rank(l); });
  lessons.sort((a, b) => b.rank - a.rank);

  const groupBusy = new Set();
  const teacherBusy = new Set();
  const perDay = {};
  const out = [];
  for (const l of lessons) {
    const days = staffByKey[l.teacher].workDays;
    const options = SLOTS.filter((s) => !groupBusy.has(`${l.grade}:${s.day}:${s.p}`)
      && !teacherBusy.has(`${l.teacher}:${s.day}:${s.p}`)
      && (!days || days.includes(s.day))
      && (perDay[`${l.grade}:${s.day}:${l.subject}`] || 0) < dayCap(l.subject));
    if (!options.length) return null;
    // Spread a subject across the week: prefer the day it has least of.
    const used = (s) => perDay[`${l.grade}:${s.day}:${l.subject}`] || 0;
    const fewest = Math.min(...options.map(used));
    const best = options.filter((s) => used(s) === fewest);
    const slot = best[Math.floor(rand() * best.length)];
    groupBusy.add(`${l.grade}:${slot.day}:${slot.p}`);
    teacherBusy.add(`${l.teacher}:${slot.day}:${slot.p}`);
    perDay[`${l.grade}:${slot.day}:${l.subject}`] = used(slot) + 1;
    const [startMin, endMin] = C.PERIODS[slot.p];
    out.push({ grade: l.grade, subject: l.subject, teacher: l.teacher, day: slot.day, startMin, endMin });
  }
  return out.sort((a, b) => a.grade.localeCompare(b.grade) || a.day - b.day || a.startMin - b.startMin);
}

function buildTimetable(seed = 2026) {
  const rand = mulberry32(seed);
  for (let tries = 1; tries <= 50000; tries += 1) {
    const result = attempt(rand);
    if (result) return result;
  }
  throw new Error('No clash-free timetable found');
}

module.exports = { buildTimetable, timetableSubjects, periodsPerWeek };
