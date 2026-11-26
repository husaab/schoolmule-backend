// services/meetings/setup.js
//
// The office's setup of a meetings event, and a teacher's own hours.
//
// A booked time never disappears: every setup change runs in the event's
// transaction, the event is read again after it, and if any booking no
// longer matches one of its teacher's times (hours shortened, a break over
// it, a new length, the teacher left out), the change is rolled back with
// 409 BOOKED_TIMES listing those meetings, so the office moves them first.

const q = require('../../queries/meetings.queries');
const S = require('./state');
const { timeLabel } = require('./slots');
const { shortDay } = require('./time');
const { MeetingError, withEvent, changeOf, queueFamilyUpdate } = require('./booking');

const isMin = (v, max = 1440) => Number.isInteger(v) && v >= 0 && v <= max;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkWindow(start, end, what = 'hours') {
  if (!isMin(start, 1439) || !isMin(end) || end <= start) {
    throw new MeetingError(400, 'BAD_TIME', `Check the ${what}: the end must be after the start`);
  }
}
const checkLength = (v) => {
  if (!Number.isInteger(v) || v < 5 || v > 60) throw new MeetingError(400, 'BAD_LENGTH', 'A meeting is 5 to 60 minutes');
};
const cleanLabel = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null);

/** The teachers a day is for (a day only for some teachers): at least one, each with families to meet. */
function pickedTeachers(people, ids) {
  const picked = [...new Set(Array.isArray(ids) ? ids : [])];
  if (!picked.length) throw new MeetingError(400, 'PICK_TEACHERS', 'Pick the teachers who meet families that day');
  if (picked.some((id) => !people.teachers.has(id))) {
    throw new MeetingError(404, 'TEACHER_NOT_FOUND', "One of these teachers has no students' families to meet");
  }
  return picked;
}

/** The meetings a change would leave without a time, as the 409 lists them. */
function describe(state, people, bookings) {
  return bookings.map((b) => {
    const day = state.days.find((d) => d.day_id === b.day_id);
    const kids = b.student_ids.map((id) => people.students.get(id)?.name).filter(Boolean).join(', ');
    return {
      bookingId: b.booking_id,
      label: `${day ? shortDay(day.day_date) : ''} ${timeLabel(b.start_min)} · ${people.teachers.get(b.teacher_id)?.name || 'Teacher'} · ${kids}`.trim(),
    };
  });
}

/** Run a setup change; roll it back if it would leave a booked family without a time. */
function guarded(school, eventId, work) {
  return withEvent(school, eventId, async (ctx) => {
    const result = await work(ctx);
    const fresh = await S.loadEvent(ctx.client, eventId, school);
    const lost = S.orphans(fresh);
    if (lost.length) {
      throw new MeetingError(
        409,
        'BOOKED_TIMES',
        lost.length === 1
          ? 'A family is booked at a time this change would remove. Move or cancel that meeting first.'
          : `${lost.length} families are booked at times this change would remove. Move or cancel those meetings first.`,
        { bookings: describe(fresh, ctx.people, lost) },
      );
    }
    return result;
  });
}

// ── Events ───────────────────────────────────────────────────

async function createEvent(client, { school, schoolYearId, userId, title, slotMinutes = 10, days = [] }) {
  checkLength(slotMinutes);
  if (!Array.isArray(days) || days.length > 14) throw new MeetingError(400, 'BAD_DAYS', 'Up to 14 days');
  const seen = new Set();
  for (const d of days) {
    if (!DATE_RE.test(d.date || '') || seen.has(d.date)) throw new MeetingError(400, 'BAD_DAYS', 'Each day needs its own date');
    seen.add(d.date);
    checkWindow(d.start, d.end);
  }
  const { rows: [row] } = await client.query(q.insertEvent, [
    school, schoolYearId, cleanLabel(title) || 'Parent–teacher meetings', slotMinutes, userId,
  ]);
  for (const d of days) await client.query(q.insertDay, [row.event_id, d.date, d.start, d.end, true]);
  return row.event_id;
}

const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/** Settings (Meetings and booking, Emails). Only fields present change. */
function updateSettings({ school, eventId, userId, body }) {
  return guarded(school, eventId, async ({ client, state }) => {
    const e = state.event;
    const next = {
      title: body.title !== undefined ? (cleanLabel(body.title) || e.title) : e.title,
      slot: body.slotMinutes !== undefined ? body.slotMinutes : e.slot_minutes,
      cutoff: body.cutoffMin !== undefined ? body.cutoffMin : e.cutoff_min,
      lastCallAt: body.lastCallAt !== undefined ? body.lastCallAt : e.last_call_at,
      reminderMin: body.reminderMin !== undefined ? body.reminderMin : e.reminder_min,
      opensAt: body.opensAt !== undefined ? body.opensAt : e.opens_at,
    };
    checkLength(next.slot);
    if (next.cutoff !== null && !isMin(next.cutoff, 1439)) throw new MeetingError(400, 'BAD_TIME', 'Check the change cutoff');
    if (!isMin(next.reminderMin, 1439)) throw new MeetingError(400, 'BAD_TIME', 'Check the reminder time');
    for (const at of [next.lastCallAt, next.opensAt]) {
      if (at !== null && Number.isNaN(Date.parse(at))) throw new MeetingError(400, 'BAD_TIME', 'Check the date and time');
    }
    await client.query(q.updateEvent, [
      eventId, next.title, next.slot, next.cutoff,
      bool(body.useGradeRoom, e.use_grade_room), bool(body.siblingsShare, e.siblings_share),
      bool(body.teachersEditHours, e.teachers_edit_hours), bool(body.emailInvite, e.email_invite),
      bool(body.emailLastCall, e.email_last_call), next.lastCallAt, bool(body.emailReminder, e.email_reminder),
      next.reminderMin, bool(body.emailTeacherList, e.email_teacher_list), next.opensAt, userId,
      bool(body.allowPhone, e.allow_phone),
    ]);
  });
}

// ── Days and everyone's breaks ───────────────────────────────

function addDay({ school, eventId, body }) {
  return guarded(school, eventId, async ({ client, state, people }) => {
    if (!DATE_RE.test(body.date || '')) throw new MeetingError(400, 'BAD_DAYS', 'Pick a date');
    if (state.days.some((d) => d.day_date === body.date)) throw new MeetingError(409, 'DAY_EXISTS', 'That day is already there');
    const start = body.start ?? state.days[0]?.start_min ?? 930;
    const end = body.end ?? state.days[0]?.end_min ?? 1170;
    checkWindow(start, end);
    const everyone = bool(body.everyone, true);
    // A day just for some teachers: they work it with the hours given.
    const picked = everyone ? [] : pickedTeachers(people, body.teacherIds);
    const { rows: [row] } = await client.query(q.insertDay, [eventId, body.date, start, end, everyone]);
    for (const teacherId of picked) await client.query(q.upsertTeacherDay, [row.day_id, teacherId, true, null, null]);
    return row.day_id;
  });
}

/**
 * Change a day's date, school hours, or who it is for. `everyone: false` with
 * `teacherIds` makes it a day only for those teachers (they keep any hours of
 * their own on it; the others stop working it); `everyone: true` gives it
 * back to every teacher, except the ones switched off for it.
 */
function updateDay({ school, eventId, dayId, body }) {
  return guarded(school, eventId, async ({ client, state, people }) => {
    const day = state.days.find((d) => d.day_id === dayId);
    if (!day) throw new MeetingError(404, 'DAY_NOT_FOUND', 'That day was not found');
    const date = body.date ?? day.day_date;
    if (!DATE_RE.test(date)) throw new MeetingError(400, 'BAD_DAYS', 'Pick a date');
    if (date !== day.day_date) {
      if (state.days.some((d) => d.day_date === date)) throw new MeetingError(409, 'DAY_EXISTS', 'That day is already there');
      if (state.bookings.some((b) => b.day_id === dayId)) {
        throw new MeetingError(409, 'BOOKED_TIMES', 'Families are booked on this day. Move or cancel their meetings before changing the date.');
      }
    }
    const start = body.start ?? day.start_min;
    const end = body.end ?? day.end_min;
    checkWindow(start, end);
    const everyone = bool(body.everyone, day.everyone);
    await client.query(q.updateDay, [dayId, eventId, date, start, end, everyone]);
    const ownDay = (teacherId) => state.teacherDays.get(`${dayId}:${teacherId}`);
    // Becoming a day for some teachers always names them: a day nobody works helps no one.
    if (!everyone && (body.teacherIds !== undefined || day.everyone)) {
      const picked = new Set(pickedTeachers(people, body.teacherIds));
      for (const teacherId of people.teachers.keys()) {
        const own = ownDay(teacherId);
        if (picked.has(teacherId)) {
          const hours = own?.works && own.start_min != null;
          await client.query(q.upsertTeacherDay, [dayId, teacherId, true, hours ? own.start_min : null, hours ? own.end_min : null]);
        } else if (own) {
          await client.query(q.deleteTeacherDay, [dayId, teacherId]);
        }
      }
    } else if (everyone && !day.everyone) {
      // Working it with school hours is every teacher's default again: no row needed.
      for (const teacherId of people.teachers.keys()) {
        const own = ownDay(teacherId);
        if (own?.works && own.start_min == null) await client.query(q.deleteTeacherDay, [dayId, teacherId]);
      }
    }
  });
}

function deleteDay({ school, eventId, dayId }) {
  return withEvent(school, eventId, async ({ client, state }) => {
    const n = state.bookings.filter((b) => b.day_id === dayId).length;
    if (n) {
      throw new MeetingError(409, 'BOOKED_TIMES', `${n === 1 ? 'A family is' : `${n} families are`} booked on this day. Move or cancel ${n === 1 ? 'that meeting' : 'those meetings'} first.`);
    }
    const { rows } = await client.query(q.deleteDay, [dayId, eventId]);
    if (!rows.length) throw new MeetingError(404, 'DAY_NOT_FOUND', 'That day was not found');
  }, { people: false });
}

function addBreak({ school, eventId, dayId, teacherId = null, body, userId, kind = 'break' }) {
  return guarded(school, eventId, async ({ client, state }) => {
    if (!state.days.some((d) => d.day_id === dayId)) throw new MeetingError(404, 'DAY_NOT_FOUND', 'That day was not found');
    checkWindow(body.start, body.end, kind === 'closed' ? 'times' : 'break');
    if (kind === 'closed') {
      const hit = state.bookings.find((b) => b.teacher_id === teacherId && b.day_id === dayId && b.start_min < body.end && body.start < b.end_min);
      if (hit) {
        throw new MeetingError(409, 'BOOKED_TIMES', `A family is booked at ${timeLabel(hit.start_min)}. Booked times can't be closed; ask the office to move the family.`);
      }
    }
    const { rows: [row] } = await client.query(q.insertBreak, [dayId, teacherId, body.start, body.end, cleanLabel(body.label), kind, userId]);
    return row.break_id;
  });
}

/** Remove a break or a closed time. `teacherId` set: only that teacher's own. */
function deleteBreak({ school, eventId, breakId, teacherId = null }) {
  return withEvent(school, eventId, async ({ client }) => {
    const { rows: [b] } = await client.query(q.selectBreak, [breakId, eventId]);
    if (!b || (teacherId && b.teacher_id !== teacherId)) throw new MeetingError(404, 'BREAK_NOT_FOUND', 'That break was not found');
    await client.query(q.deleteBreak, [breakId]);
  }, { people: false });
}

// ── One teacher's own days, hours, breaks, length and room ──

/**
 * Replace a teacher's own settings. body: { takingPart?, slotMinutes|null?,
 * room|null?, days?: [{ dayId, works, start|null, end|null, breaks?: [{ start, end, label }] }] }.
 * A teacher editing themselves (`self`) can't change takingPart or room.
 */
function setTeacher({ school, eventId, teacherId, body, userId, self = false }) {
  return guarded(school, eventId, async ({ client, state, people }) => {
    if (!people.teachers.has(teacherId)) throw new MeetingError(404, 'TEACHER_NOT_FOUND', "This teacher has no students' families to meet");
    if (self && !state.event.teachers_edit_hours) {
      throw new MeetingError(403, 'HOURS_LOCKED', 'The office sets meeting hours for these meetings');
    }
    const current = state.settings.get(teacherId) || { taking_part: true, slot_minutes: null, room: null };
    const slotMinutes = body.slotMinutes !== undefined ? body.slotMinutes : current.slot_minutes;
    if (slotMinutes !== null) checkLength(slotMinutes);
    const takingPart = self ? current.taking_part : bool(body.takingPart, current.taking_part);
    const room = self ? current.room : (body.room !== undefined ? cleanLabel(body.room) : current.room);
    await client.query(q.upsertTeacherSettings, [eventId, teacherId, takingPart, slotMinutes, room]);

    for (const d of Array.isArray(body.days) ? body.days : []) {
      const day = state.days.find((x) => x.day_id === d.dayId);
      if (!day) throw new MeetingError(404, 'DAY_NOT_FOUND', 'That day was not found');
      const own = d.start !== null && d.start !== undefined;
      if (own) checkWindow(d.start, d.end);
      const works = Boolean(d.works);
      const isDefault = works === (day.everyone !== false) && !own;
      if (isDefault) await client.query(q.deleteTeacherDay, [day.day_id, teacherId]);
      else await client.query(q.upsertTeacherDay, [day.day_id, teacherId, works, own ? d.start : null, own ? d.end : null]);
      if (Array.isArray(d.breaks)) {
        await client.query(q.deleteOwnBreaks, [day.day_id, teacherId]);
        for (const b of d.breaks) {
          checkWindow(b.start, b.end, 'break');
          await client.query(q.insertBreak, [day.day_id, teacherId, b.start, b.end, cleanLabel(b.label), 'break', userId]);
        }
      }
    }
  });
}

// ── Delete ───────────────────────────────────────────────────

/** Delete the event: every booked family is told their meetings are cancelled. */
function deleteEvent({ school, eventId, userId }) {
  return withEvent(school, eventId, async ({ client, state, people }) => {
    const byFamily = new Map();
    for (const b of state.bookings) {
      const key = people.familyOf.get(b.student_ids[0]) || b.booking_id;
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(b);
    }
    for (const list of byFamily.values()) {
      await queueFamilyUpdate(client, {
        state, people, studentIds: list.flatMap((b) => b.student_ids),
        changes: list.map((b) => changeOf(state, people, 'cancelled', b)), byOffice: true, actorId: userId,
      });
    }
    await client.query(q.deleteEvent, [eventId]);
    return state.bookings.length;
  });
}

module.exports = {
  createEvent, updateSettings, addDay, updateDay, deleteDay, addBreak, deleteBreak, setTeacher, deleteEvent, guarded,
};
