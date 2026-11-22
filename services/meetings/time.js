// services/meetings/time.js
//
// When things happen for a meetings event, Toronto wall clock (DST-safe via
// classroomDigest.torontoInstant). A day's cutoff is when families can no
// longer book, change or cancel for it; the teacher's list goes out then.

const { torontoInstant, addDays } = require('../classroom/classroomDigest');

const MIN_MS = 60 * 1000;
const DEFAULT_TEACHER_LIST_MIN = 20 * 60;

/** The instant of `minutes` after midnight on a Toronto date. */
const torontoAt = (date, minutes) =>
  new Date(torontoInstant(date, Math.floor(minutes / 60)).getTime() + (minutes % 60) * MIN_MS);

/** Families can book, change and cancel for `day` until then. */
const cutoffAt = (event, day) => (event.cutoff_min == null
  ? torontoAt(day.day_date, day.start_min)
  : torontoAt(addDays(day.day_date, -1), event.cutoff_min));

const reminderAt = (event, day) => torontoAt(addDays(day.day_date, -1), event.reminder_min);

const teacherListAt = (event, day) =>
  torontoAt(addDays(day.day_date, -1), event.cutoff_min ?? DEFAULT_TEACHER_LIST_MIN);

/** The end of the event's last day (meetings over). */
const finishedAt = (days) => {
  const last = days[days.length - 1];
  return last ? torontoAt(last.day_date, Math.max(...days.filter((d) => d.day_date === last.day_date).map((d) => d.end_min))) : null;
};

/**
 * draft | scheduled | open (some day still bookable) | closed (every cutoff
 * passed, meetings still to come) | finished.
 */
function phaseOf(event, days, now = new Date()) {
  if (event.status === 'draft' || event.status === 'scheduled') return event.status;
  const end = finishedAt(days);
  if (end && now >= end) return 'finished';
  if (days.length && days.every((d) => now >= cutoffAt(event, d))) return 'closed';
  return 'open';
}

/** 'Monday, November 30' */
const longDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
  timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
});
/** 'Mon, Nov 30' */
const shortDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
  timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
});
/** 'Monday' */
const weekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });

/** 'Tue, Nov 24, 7:00 PM' for an instant, Toronto. */
const instantLabel = (at) => new Date(at).toLocaleString('en-US', {
  timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

module.exports = {
  torontoAt, cutoffAt, reminderAt, teacherListAt, finishedAt, phaseOf, longDay, shortDay, weekday, instantLabel,
  DEFAULT_TEACHER_LIST_MIN,
};
