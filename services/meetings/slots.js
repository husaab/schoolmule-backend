// services/meetings/slots.js
//
// A teacher's meeting times, computed (never stored): their window on the
// day, their meeting length and the breaks. Pure functions, mirrored by the
// web's src/lib/meetingSlots.ts (and the app's copy of it), so a page shows
// exactly the times the API accepts.
//
// Minutes from midnight throughout (Toronto wall clock): 930 = 3:30 PM.
//
// - Breaks (everyone's, and the teacher's own) shape the grid: a time that
//   would overlap one starts again at the break's end, so 15-minute times
//   realign after a 20-minute Maghrib.
// - Closed times (a teacher's Close) don't move the grid: the times under
//   them stay where they are, marked closed, and can be reopened.

/** The times from `start` to `end`, `length` long, around `breaks` ([{ start, end }]). */
function slotsFor(start, end, length, breaks = []) {
  const out = [];
  if (!(length > 0) || !(end > start)) return out;
  const sorted = [...breaks].sort((a, b) => a.start - b.start);
  let t = start;
  while (t + length <= end) {
    const hit = sorted.find((b) => b.start < t + length && b.end > t);
    if (hit) {
      t = hit.end;
      continue;
    }
    out.push({ start: t, end: t + length });
    t += length;
  }
  return out;
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

/**
 * A teacher's plan for one day.
 * @param {object} p
 * @param {{ start_min, end_min, everyone, day_id }} p.day
 * @param {{ works, start_min, end_min } | undefined} p.own   their ptm_teacher_days row
 * @param {number} p.length                                   their meeting length
 * @param {Array<{ teacher_id, start_min, end_min, kind }>} p.breaks  the day's breaks (all teachers)
 * @param {string} p.teacherId
 * @returns {{ works, start, end, ownHours, length, breaks, closed, slots: [{ start, end, closed }] }}
 */
function teacherDayPlan({ day, own, length, breaks, teacherId }) {
  const works = own ? own.works : day.everyone !== false;
  const ownHours = Boolean(own && own.works && own.start_min != null);
  const start = ownHours ? own.start_min : day.start_min;
  const end = ownHours ? own.end_min : day.end_min;
  const mine = breaks.filter((b) => !b.teacher_id || b.teacher_id === teacherId);
  const shaping = mine.filter((b) => b.kind !== 'closed').map((b) => ({ start: b.start_min, end: b.end_min }));
  const closed = mine.filter((b) => b.kind === 'closed').map((b) => ({ start: b.start_min, end: b.end_min }));
  const slots = works
    ? slotsFor(start, end, length, shaping).map((s) => ({ ...s, closed: closed.some((c) => overlaps(c, s)) }))
    : [];
  return { works, start, end, ownHours, length, breaks: shaping, closed, slots };
}

/** The bookings (start_min/end_min) that are no longer one of `slots`' times. */
function orphanedBookings(slots, bookings) {
  return bookings.filter((b) => !slots.some((s) => s.start === b.start_min && s.end === b.end_min));
}

/** '3:30 PM' for 930. */
function timeLabel(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** '3:30–7:30 PM', or '9:00 AM–1:00 PM' across noon. */
function rangeLabel(start, end) {
  const a = timeLabel(start);
  const b = timeLabel(end);
  const [aTime, aPart] = a.split(' ');
  const [, bPart] = b.split(' ');
  return aPart === bPart ? `${aTime}–${b}` : `${a}–${b}`;
}

module.exports = { slotsFor, overlaps, teacherDayPlan, orphanedBookings, timeLabel, rangeLabel };
