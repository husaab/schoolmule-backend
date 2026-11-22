// services/meetings/booking.js
//
// Booking, moving and cancelling meetings, first come, first served.
//
// Every write to an event (a booking, or a change to its setup) runs inside
// withEvent: one transaction holding the event's advisory lock, reading the
// event fresh after taking it. So two families racing for 4:10 PM are
// served one after the other, and the second is told the time is gone.
//
// The rules (parents and office alike, except where noted):
// - the time is one of the teacher's times now, not closed, not booked, and
//   not already started;
// - each child is that teacher's (report-card classes or homeroom), and has
//   no other meeting with them;
// - the family (children joined by a shared guardian) has nothing else at
//   that time;
// - siblings share one meeting only when the school allows it;
// - parents: only their own children, only while the event is open and
//   before the day's cutoff. The office books any family, any time.
//
// Each change queues the family's update email (outbox kind
// ptm_family_update) inside the same transaction.

const crypto = require('crypto');
const db = require('../../config/database');
const q = require('../../queries/meetings.queries');
const outbox = require('../email/outbox');
const S = require('./state');
const { overlaps, timeLabel } = require('./slots');
const { cutoffAt, torontoAt, phaseOf, weekday, instantLabel } = require('./time');

class MeetingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const FAMILY_UPDATE = 'ptm_family_update';
const PARENT_HOLD_SECONDS = 120;
const OFFICE_HOLD_SECONDS = 60;

/** Run `work` in a transaction holding the event's lock, with the event and its people read fresh. */
async function withEvent(school, eventId, work, { people: needPeople = true } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(q.lockKeys, [[`ptm:${eventId}`]]);
    const state = await S.loadEvent(client, eventId, school);
    if (!state) throw new MeetingError(404, 'NOT_FOUND', 'These meetings were not found');
    const people = needPeople ? await S.loadPeople(client, state.event) : null;
    if (people) S.orderBookings(state, people);
    const result = await work({ client, state, people });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const unique = (values) => [...new Set(values)];
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`);

/** The children a parent account is a guardian of, this year. */
const childrenOf = (people, userId) =>
  new Set([...people.students.values()].filter((s) => s.guardians.some((g) => g.userId === userId)).map((s) => s.id));

function checkTime({ state, people, actor, item, now, extra = [], exceptBookingId = null }) {
  const { event } = state;
  const day = state.days.find((d) => d.day_id === item.dayId);
  if (!day) throw new MeetingError(404, 'DAY_NOT_FOUND', 'That day is not part of these meetings');
  const teacherId = item.teacherId;
  if (actor.userId === teacherId && actor.kind === 'parent') {
    throw new MeetingError(400, 'OWN_MEETING', "You can't book a meeting with yourself");
  }
  if (!S.takingPart(state, people, teacherId)) {
    throw new MeetingError(409, 'NOT_TAKING_PART', "This teacher isn't taking meetings");
  }
  const teacher = people.teachers.get(teacherId);
  const studentIds = S.byAge(people, unique(item.studentIds || []));
  if (!studentIds.length) throw new MeetingError(400, 'NO_CHILD', 'Choose which child the meeting is about');
  for (const id of studentIds) {
    if (actor.kind === 'parent' && !actor.childIds.has(id)) {
      throw new MeetingError(403, 'NOT_YOUR_CHILD', 'Not authorized for this student');
    }
    if (!teacher.studentIds.has(id)) {
      throw new MeetingError(400, 'NOT_THEIR_TEACHER', `${people.students.get(id)?.firstName || 'This child'} isn't in ${teacher.name}'s classes`);
    }
  }
  if (studentIds.length > 1) {
    if (!event.siblings_share) throw new MeetingError(400, 'SEPARATE_MEETINGS', 'Each child has their own meeting at this school');
    if (new Set(studentIds.map((id) => people.familyOf.get(id))).size > 1) {
      throw new MeetingError(400, 'NOT_ONE_FAMILY', 'A shared meeting is for one family');
    }
  }
  if (actor.kind === 'parent') {
    if (phaseOf(event, state.days, now) === 'draft' || event.status !== 'open') {
      throw new MeetingError(409, 'NOT_OPEN', "Booking isn't open yet");
    }
    if (now >= cutoffAt(event, day)) {
      throw new MeetingError(409, 'PAST_CUTOFF', `Booking for ${weekday(day.day_date)} closed ${instantLabel(cutoffAt(event, day))}`);
    }
  }
  const slot = S.planFor(state, teacherId, day).slots.find((s) => s.start === item.startMin);
  if (!slot || slot.closed || torontoAt(day.day_date, slot.start) <= now) {
    throw new MeetingError(409, 'TIME_GONE', "That time isn't available any more");
  }
  const others = [...state.bookings, ...extra].filter((b) => b.booking_id !== exceptBookingId);
  const asRange = (b) => ({ start: b.start_min, end: b.end_min });
  if (others.some((b) => b.teacher_id === teacherId && b.day_id === day.day_id && overlaps(asRange(b), slot))) {
    throw new MeetingError(409, 'TIME_TAKEN', 'Someone just booked that time. Please pick another.');
  }
  for (const id of studentIds) {
    if (others.some((b) => b.teacher_id === teacherId && b.student_ids.includes(id))) {
      throw new MeetingError(409, 'ALREADY_BOOKED', `${people.students.get(id).firstName} already has a meeting with ${teacher.name}`);
    }
  }
  const family = new Set([...S.familyStudents(people, studentIds), ...(actor.kind === 'parent' ? actor.childIds : [])]);
  const clash = others.find((b) => b.day_id === day.day_id && overlaps(asRange(b), slot) && b.student_ids.some((id) => family.has(id)));
  if (clash) {
    const who = people.teachers.get(clash.teacher_id)?.name || 'another teacher';
    throw new MeetingError(409, 'FAMILY_BUSY', `There's already a meeting at ${timeLabel(clash.start_min)} (${who})`);
  }
  return { day, slot, studentIds, teacher };
}

/** A change as the family's email reads it (kept in the outbox payload: a cancelled booking is gone). */
function changeOf(state, people, type, b, { from = null } = {}) {
  const day = state.days.find((d) => d.day_id === b.day_id);
  const fromDay = from ? state.days.find((d) => d.day_id === from.day_id) : null;
  return {
    type,
    bookingId: b.booking_id,
    sequence: b.sequence ?? 0,
    teacherId: b.teacher_id,
    teacherName: people.teachers.get(b.teacher_id)?.name || 'A teacher',
    studentNames: joinNames(b.student_ids.map((id) => people.students.get(id)?.firstName).filter(Boolean)),
    day: day?.day_date || null,
    start: b.start_min,
    end: b.end_min,
    room: S.roomFor(state, people, b.teacher_id, b.student_ids),
    fromDay: fromDay?.day_date || null,
    fromStart: from ? from.start_min : null,
    fromEnd: from ? from.end_min : null,
  };
}

/** Queue the update email to every guardian account in the families these children belong to. */
async function queueFamilyUpdate(client, { state, people, studentIds, changes, byOffice, actorId }) {
  if (!changes.length) return 0;
  const family = S.familyStudents(people, studentIds);
  const seen = new Set();
  const rows = [];
  const actionId = crypto.randomUUID();
  for (const id of family) {
    for (const g of people.students.get(id).guardians) {
      if (!g.userId || !g.email || seen.has(g.userId)) continue;
      seen.add(g.userId);
      rows.push({
        kind: FAMILY_UPDATE,
        school: state.event.school,
        recipientEmail: g.email,
        recipientUserId: g.userId,
        subjectType: 'ptm_event',
        subjectId: state.event.event_id,
        studentId: id,
        dedupeKey: `update:${actionId}`,
        coalesceKey: `ptm:${state.event.event_id}`,
        payload: { eventId: state.event.event_id, byOffice: Boolean(byOffice), changes },
        priority: 4,
        delaySeconds: byOffice ? OFFICE_HOLD_SECONDS : PARENT_HOLD_SECONDS,
        createdBy: actorId,
      });
    }
  }
  return outbox.enqueue(client, rows);
}

async function insertBooking(client, state, { teacherId, day, slot, studentIds, actor }) {
  const { rows: [row] } = await client.query(q.insertBooking, [
    state.event.event_id, day.day_id, teacherId, slot.start, slot.end, actor.userId, actor.kind === 'office',
  ]);
  if (!row) throw new MeetingError(409, 'TIME_TAKEN', 'Someone just booked that time. Please pick another.');
  const { rows: added } = await client.query(q.insertBookingStudents, [row.booking_id, state.event.event_id, teacherId, studentIds]);
  if (added.length !== studentIds.length) throw new MeetingError(409, 'ALREADY_BOOKED', 'Already booked with this teacher');
  return {
    booking_id: row.booking_id, event_id: state.event.event_id, day_id: day.day_id, teacher_id: teacherId,
    start_min: slot.start, end_min: slot.end, student_ids: studentIds, sequence: 0,
  };
}

const actorFor = (people, user, kind) => ({
  kind, userId: user.userId, childIds: kind === 'parent' ? childrenOf(people, user.userId) : new Set(),
});

/**
 * Book one or more meetings at once (Plan my visit books several): all or
 * nothing. items: [{ teacherId, dayId, startMin, studentIds }].
 * @returns {Promise<string[]>} the new booking ids
 */
async function book({ school, eventId, user, kind, items, now = new Date() }) {
  if (!Array.isArray(items) || !items.length || items.length > 30) {
    throw new MeetingError(400, 'NO_MEETINGS', 'Choose at least one meeting');
  }
  return withEvent(school, eventId, async ({ client, state, people }) => {
    const actor = actorFor(people, user, kind);
    const made = [];
    for (const item of items) {
      const { day, slot, studentIds } = checkTime({ state, people, actor, item, now, extra: made });
      made.push(await insertBooking(client, state, { teacherId: item.teacherId, day, slot, studentIds, actor }));
    }
    await queueFamilyUpdate(client, {
      state, people, studentIds: made.flatMap((b) => b.student_ids),
      changes: made.map((b) => changeOf(state, people, 'booked', b)), byOffice: kind === 'office', actorId: user.userId,
    });
    return made.map((b) => b.booking_id);
  });
}

function bookingFor(state, actor, bookingId) {
  const booking = state.bookings.find((b) => b.booking_id === bookingId);
  if (!booking) throw new MeetingError(404, 'BOOKING_NOT_FOUND', 'That meeting was not found');
  if (actor.kind === 'parent' && !booking.student_ids.some((id) => actor.childIds.has(id))) {
    throw new MeetingError(404, 'BOOKING_NOT_FOUND', 'That meeting was not found');
  }
  return booking;
}

function checkParentCanChange(state, actor, booking, now) {
  if (actor.kind !== 'parent') return;
  const day = state.days.find((d) => d.day_id === booking.day_id);
  if (now >= cutoffAt(state.event, day)) {
    throw new MeetingError(409, 'PAST_CUTOFF', `Changes for ${weekday(day.day_date)} closed ${instantLabel(cutoffAt(state.event, day))}. Please contact the school.`);
  }
}

/** Move a meeting to another of the same teacher's times. */
async function move({ school, eventId, user, kind, bookingId, dayId, startMin, now = new Date() }) {
  return withEvent(school, eventId, async ({ client, state, people }) => {
    const actor = actorFor(people, user, kind);
    const booking = bookingFor(state, actor, bookingId);
    checkParentCanChange(state, actor, booking, now);
    if (booking.day_id === dayId && booking.start_min === startMin) return bookingId;
    const { day, slot } = checkTime({
      state, people, actor, now, exceptBookingId: bookingId,
      item: { teacherId: booking.teacher_id, dayId, startMin, studentIds: booking.student_ids },
    });
    await client.query(q.moveBooking, [bookingId, day.day_id, slot.start, slot.end]);
    const moved = { ...booking, day_id: day.day_id, start_min: slot.start, end_min: slot.end, sequence: booking.sequence + 1 };
    await queueFamilyUpdate(client, {
      state, people, studentIds: booking.student_ids,
      changes: [changeOf(state, people, 'moved', moved, { from: booking })], byOffice: kind === 'office', actorId: user.userId,
    });
    return bookingId;
  });
}

/** Cancel a meeting; the family is emailed. */
async function cancel({ school, eventId, user, kind, bookingId, now = new Date() }) {
  return withEvent(school, eventId, async ({ client, state, people }) => {
    const actor = actorFor(people, user, kind);
    const booking = bookingFor(state, actor, bookingId);
    checkParentCanChange(state, actor, booking, now);
    await client.query(q.deleteBooking, [bookingId]);
    state.bookings = state.bookings.filter((b) => b.booking_id !== bookingId);
    await queueFamilyUpdate(client, {
      state, people, studentIds: booking.student_ids,
      changes: [changeOf(state, people, 'cancelled', booking)], byOffice: kind === 'office', actorId: user.userId,
    });
    return bookingId;
  });
}

module.exports = {
  MeetingError, FAMILY_UPDATE, withEvent, checkTime, changeOf, queueFamilyUpdate, childrenOf, book, move, cancel, joinNames,
};
