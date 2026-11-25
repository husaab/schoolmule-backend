// controllers/meetings.controller.js
//
// Parent–teacher meetings over HTTP (services/meetings). Three audiences:
// - the office (routes/meetings.routes.js, `scheduling`): set up, open,
//   watch the board, book for a family, move and cancel;
// - a teacher (same router, any staff account): My Meetings, their own
//   hours and closed times, Print my day;
// - a parent (routes/parentPortal.routes.js): their children's teachers'
//   open times; book, move, cancel.
// School always comes from the token; the year from resolveSchoolYear.

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/meetings.queries');
const S = require('../services/meetings/state');
const V = require('../services/meetings/views');
const booking = require('../services/meetings/booking');
const setup = require('../services/meetings/setup');
const scheduler = require('../services/meetings/scheduler');
const { printDay } = require('../services/meetings/printDay');
const { torontoParts, addDays } = require('../services/classroom/classroomDigest');
const { can } = require('../services/access/access');
const outbox = require('../services/email/outbox');

const { MeetingError } = booking;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const yearOf = (req) => req.schoolYear?.schoolYearId ?? null;
const todayToronto = (now = new Date()) => torontoParts(now).date;
const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

/** Express handler with MeetingError → its status, a unique-key race → 409. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof MeetingError) {
      return res.status(error.status).json({ status: 'failed', code: error.code, message: error.message, ...error.extra, data: error.extra });
    }
    if (error?.code === '23505') {
      return res.status(409).json({ status: 'failed', code: 'CONFLICT', message: 'That changed just now. Please try again.' });
    }
    if (error?.code === '22P02' || error?.code === '22007' || error?.code === '22008') {
      return res.status(400).json({ status: 'failed', code: 'BAD_INPUT', message: 'Check what you entered' });
    }
    logger.error({ err: error, path: req.path }, 'Meetings request failed');
    return res.status(500).json({ status: 'failed', message: 'Something went wrong with the meetings' });
  }
};

const uuidParam = (name) => (req, res, next, id) => {
  if (!UUID.test(id)) return res.status(404).json({ status: 'failed', code: 'NOT_FOUND', message: `${name} not found` });
  return next();
};

async function readEvent(req, eventId = req.params.eventId) {
  const state = await S.loadEvent(db, eventId, req.user.school);
  if (!state) throw new MeetingError(404, 'NOT_FOUND', 'These meetings were not found');
  const people = await S.loadPeople(db, state.event);
  return { state: S.orderBookings(state, people), people };
}

const intOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ── Office ───────────────────────────────────────────────────

const listEvents = handle(async (req, res) => {
  const { rows } = await db.query(q.listEvents, [req.user.school, yearOf(req)]);
  const now = new Date();
  const events = [];
  for (const e of rows) {
    const { rows: days } = await db.query(q.selectDays, [e.event_id]);
    events.push({
      ...V.eventView({ event: e, days }, now),
      firstDay: e.first_day, lastDay: e.last_day, dayCount: e.day_count, bookings: e.booking_count,
    });
  }
  const { rows: suggestions } = yearOf(req)
    ? await db.query(q.selectCalendarSuggestions, [req.user.school, yearOf(req)])
    : { rows: [] };
  const taken = new Set((await Promise.all(rows.map((e) => db.query(q.selectDays, [e.event_id])))).flatMap((r) => r.rows.map((d) => d.day_date)));
  const today = todayToronto(now);
  const dates = [];
  for (const s of suggestions) {
    for (let d = s.start_date; d <= s.end_date && dates.length < 14; d = addDays(d, 1)) {
      if (d >= today && !taken.has(d) && !dates.some((x) => x.date === d)) dates.push({ date: d, title: s.title });
    }
  }
  return ok(res, { events, suggestions: dates });
});

const createEvent = handle(async (req, res) => {
  if (!yearOf(req)) throw new MeetingError(400, 'NO_YEAR', 'No school year is set up yet');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const eventId = await setup.createEvent(client, {
      school: req.user.school,
      schoolYearId: yearOf(req),
      userId: req.user.userId,
      title: req.body?.title,
      slotMinutes: intOrNull(req.body?.slotMinutes) ?? 10,
      days: Array.isArray(req.body?.days) ? req.body.days.map((d) => ({ date: d.date, start: intOrNull(d.start), end: intOrNull(d.end) })) : [],
    });
    await client.query('COMMIT');
    return ok(res, { eventId }, 201);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

const getEvent = handle(async (req, res) => {
  const { state, people } = await readEvent(req);
  return ok(res, V.setupView(state, people));
});

const updateEvent = handle(async (req, res) => {
  await setup.updateSettings({ school: req.user.school, eventId: req.params.eventId, userId: req.user.userId, body: req.body || {} });
  const { state, people } = await readEvent(req);
  return ok(res, V.setupView(state, people));
});

const deleteEvent = handle(async (req, res) => {
  const cancelled = await setup.deleteEvent({ school: req.user.school, eventId: req.params.eventId, userId: req.user.userId });
  if (cancelled) outbox.kick?.();
  return ok(res, { cancelled });
});

/** Open booking at a time (or now). Families are invited when it opens. */
const scheduleEvent = handle(async (req, res) => {
  const at = req.body?.opensAt ? new Date(req.body.opensAt) : new Date();
  if (Number.isNaN(at.getTime())) throw new MeetingError(400, 'BAD_TIME', 'Check the opening time');
  const now = new Date();
  const queued = await booking.withEvent(req.user.school, req.params.eventId, async ({ client, state, people }) => {
    if (state.event.status === 'open') throw new MeetingError(409, 'ALREADY_OPEN', 'Booking is already open');
    if (!state.days.length) throw new MeetingError(409, 'NO_DAYS', 'Add a day first');
    if (![...people.teachers.keys()].some((id) => S.takingPart(state, people, id))) {
      throw new MeetingError(409, 'NO_TEACHERS', 'No teachers are taking part');
    }
    if (at <= now) return scheduler.openEvent(client, state, people, now);
    await client.query(q.setStatus, [state.event.event_id, 'scheduled', at, req.user.userId]);
    return 0;
  });
  if (queued) outbox.kick?.();
  const { state, people } = await readEvent(req);
  return ok(res, V.setupView(state, people));
});

const unscheduleEvent = handle(async (req, res) => {
  await booking.withEvent(req.user.school, req.params.eventId, async ({ client, state }) => {
    if (state.event.status === 'open') throw new MeetingError(409, 'ALREADY_OPEN', 'Booking is already open; it can\'t go back to a draft');
    await client.query(q.setStatus, [state.event.event_id, 'draft', state.event.opens_at, req.user.userId]);
  }, { people: false });
  const { state, people } = await readEvent(req);
  return ok(res, V.setupView(state, people));
});

const dayBody = (b = {}) => ({
  date: b.date,
  start: b.start === undefined ? undefined : intOrNull(b.start),
  end: b.end === undefined ? undefined : intOrNull(b.end),
  everyone: b.everyone,
  teacherIds: b.teacherIds,
});

const addDay = handle(async (req, res) => {
  const dayId = await setup.addDay({ school: req.user.school, eventId: req.params.eventId, body: dayBody(req.body) });
  return ok(res, { dayId }, 201);
});

const updateDay = handle(async (req, res) => {
  await setup.updateDay({ school: req.user.school, eventId: req.params.eventId, dayId: req.params.dayId, body: dayBody(req.body) });
  return ok(res, { dayId: req.params.dayId });
});

const deleteDay = handle(async (req, res) => {
  await setup.deleteDay({ school: req.user.school, eventId: req.params.eventId, dayId: req.params.dayId });
  return ok(res, { dayId: req.params.dayId });
});

const breakBody = (b = {}) => ({ start: intOrNull(b.start), end: intOrNull(b.end), label: b.label });

const addBreak = handle(async (req, res) => {
  const breakId = await setup.addBreak({
    school: req.user.school, eventId: req.params.eventId, dayId: req.params.dayId, body: breakBody(req.body), userId: req.user.userId,
  });
  return ok(res, { breakId }, 201);
});

const deleteBreak = handle(async (req, res) => {
  await setup.deleteBreak({ school: req.user.school, eventId: req.params.eventId, breakId: req.params.breakId });
  return ok(res, { breakId: req.params.breakId });
});

const teacherBody = (b = {}) => ({
  takingPart: b.takingPart,
  slotMinutes: b.slotMinutes === undefined ? undefined : intOrNull(b.slotMinutes),
  room: b.room,
  days: Array.isArray(b.days) ? b.days.map((d) => ({
    dayId: d.dayId,
    works: Boolean(d.works),
    start: intOrNull(d.start),
    end: intOrNull(d.end),
    breaks: Array.isArray(d.breaks) ? d.breaks.map(breakBody) : undefined,
  })) : undefined,
});

const setTeacher = handle(async (req, res) => {
  await setup.setTeacher({
    school: req.user.school, eventId: req.params.eventId, teacherId: req.params.teacherId, body: teacherBody(req.body), userId: req.user.userId,
  });
  const { state, people } = await readEvent(req);
  return ok(res, V.setupView(state, people));
});

const closeTeacherTimes = handle(async (req, res) => {
  const breakId = await setup.addBreak({
    school: req.user.school, eventId: req.params.eventId, dayId: req.body?.dayId, teacherId: req.params.teacherId,
    body: breakBody(req.body), userId: req.user.userId, kind: 'closed',
  });
  return ok(res, { breakId }, 201);
});

const getBoard = handle(async (req, res) => {
  const { state, people } = await readEvent(req);
  return ok(res, V.boardView(state, people, req.query.dayId));
});

const getFamilies = handle(async (req, res) => {
  const { state, people } = await readEvent(req);
  return ok(res, V.familiesView(state, people, req.query.q));
});

const bookingItems = (body = {}) => (Array.isArray(body.items) ? body.items : [body]).map((i) => ({
  teacherId: i.teacherId, dayId: i.dayId, startMin: intOrNull(i.startMin), studentIds: Array.isArray(i.studentIds) ? i.studentIds : [],
  mode: i.mode, phone: i.phone,
}));

/** A change to a meeting: a new time (dayId + startMin) and/or how it happens (mode, phone). */
const changeBody = (body = {}) => ({
  dayId: body.dayId ?? undefined, startMin: intOrNull(body.startMin) ?? undefined, mode: body.mode, phone: body.phone,
});

const officeBook = handle(async (req, res) => {
  const ids = await booking.book({ school: req.user.school, eventId: req.params.eventId, user: req.user, kind: 'office', items: bookingItems(req.body) });
  return ok(res, { bookingIds: ids }, 201);
});

const officeMove = handle(async (req, res) => {
  await booking.move({
    school: req.user.school, eventId: req.params.eventId, user: req.user, kind: 'office',
    bookingId: req.params.bookingId, ...changeBody(req.body),
  });
  return ok(res, { bookingId: req.params.bookingId });
});

const officeCancel = handle(async (req, res) => {
  await booking.cancel({ school: req.user.school, eventId: req.params.eventId, user: req.user, kind: 'office', bookingId: req.params.bookingId });
  return ok(res, { bookingId: req.params.bookingId });
});

const sendLastCall = handle(async (req, res) => {
  const queued = await scheduler.sendLastCall({ school: req.user.school, eventId: req.params.eventId });
  if (queued) outbox.kick?.();
  return ok(res, { queued });
});

// ── Teacher ──────────────────────────────────────────────────

const myMeetings = handle(async (req, res) => {
  const now = new Date();
  const { rows } = await db.query(q.selectLiveEvents, [req.user.school, yearOf(req), todayToronto(now)]);
  const events = [];
  for (const e of rows) {
    if (e.status === 'draft' && !e.teachers_edit_hours) continue;
    const { state, people } = await readEvent(req, e.event_id);
    if (!people.teachers.has(req.user.userId)) continue;
    events.push(V.teacherView(state, people, req.user.userId, now));
  }
  return ok(res, { events });
});

const setMyHours = handle(async (req, res) => {
  await setup.setTeacher({
    school: req.user.school, eventId: req.params.eventId, teacherId: req.user.userId, body: teacherBody(req.body),
    userId: req.user.userId, self: true,
  });
  const { state, people } = await readEvent(req);
  return ok(res, V.teacherView(state, people, req.user.userId));
});

const closeMyTimes = handle(async (req, res) => {
  const breakId = await setup.addBreak({
    school: req.user.school, eventId: req.params.eventId, dayId: req.body?.dayId, teacherId: req.user.userId,
    body: breakBody(req.body), userId: req.user.userId, kind: 'closed',
  });
  return ok(res, { breakId }, 201);
});

const reopenMyTimes = handle(async (req, res) => {
  await setup.deleteBreak({ school: req.user.school, eventId: req.params.eventId, breakId: req.params.breakId, teacherId: req.user.userId });
  return ok(res, { breakId: req.params.breakId });
});

/** Print my day: the teacher's own, or (scheduling) any teacher's. */
const printMyDay = handle(async (req, res) => {
  const teacherId = req.query.teacherId || req.user.userId;
  if (teacherId !== req.user.userId && !can(req, 'scheduling')) {
    return res.status(403).json({ status: 'failed', code: 'PERMISSION_DENIED', message: "You don't have permission to do that." });
  }
  if (!UUID.test(String(req.query.dayId || '')) || !UUID.test(String(teacherId))) {
    throw new MeetingError(404, 'NOT_FOUND', 'No meetings that day');
  }
  const { pdf, filename } = await printDay({ school: req.user.school, eventId: req.params.eventId, teacherId, dayId: req.query.dayId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  return res.send(pdf);
});

// ── Parent ───────────────────────────────────────────────────

const parentMeetings = handle(async (req, res) => {
  const now = new Date();
  const { rows } = await db.query(q.selectOpenEvents, [req.user.school, yearOf(req), todayToronto(now)]);
  const events = [];
  for (const e of rows) {
    const { state, people } = await readEvent(req, e.event_id);
    const view = V.parentView(state, people, req.user.userId, now);
    if (view.children.length) events.push(view);
  }
  return ok(res, { events });
});

const parentBook = handle(async (req, res) => {
  const ids = await booking.book({ school: req.user.school, eventId: req.params.eventId, user: req.user, kind: 'parent', items: bookingItems(req.body) });
  const { state, people } = await readEvent(req);
  return ok(res, { bookingIds: ids, event: V.parentView(state, people, req.user.userId) }, 201);
});

const parentMove = handle(async (req, res) => {
  await booking.move({
    school: req.user.school, eventId: req.params.eventId, user: req.user, kind: 'parent',
    bookingId: req.params.bookingId, ...changeBody(req.body),
  });
  const { state, people } = await readEvent(req);
  return ok(res, { event: V.parentView(state, people, req.user.userId) });
});

const parentCancel = handle(async (req, res) => {
  await booking.cancel({ school: req.user.school, eventId: req.params.eventId, user: req.user, kind: 'parent', bookingId: req.params.bookingId });
  const { state, people } = await readEvent(req);
  return ok(res, { event: V.parentView(state, people, req.user.userId) });
});

module.exports = {
  uuidParam,
  listEvents, createEvent, getEvent, updateEvent, deleteEvent, scheduleEvent, unscheduleEvent,
  addDay, updateDay, deleteDay, addBreak, deleteBreak, setTeacher, closeTeacherTimes,
  getBoard, getFamilies, officeBook, officeMove, officeCancel, sendLastCall,
  myMeetings, setMyHours, closeMyTimes, reopenMyTimes, printMyDay,
  parentMeetings, parentBook, parentMove, parentCancel,
};
