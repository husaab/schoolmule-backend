// services/meetings/emails.js
//
// Outbox handlers for parent–teacher meeting emails (services/email/outbox.js).
// Each is built from the event as it is at send time, so a booking made or
// cancelled after the row was queued is reflected, and a row whose reason is
// gone (the family booked, the event was deleted) is skipped.
//
//   ptm_invite         booking is open: one-tap (or create your account) link
//   ptm_family_update  booked / changed / cancelled, the family's full list + .ics
//   ptm_reminder       the evening before a day, that day's meetings
//   ptm_last_call      families with no meetings yet, the times still open
//   ptm_teacher_list   a teacher's meetings for the next day
//
// Parents' links: a live account gets the 30-day one-tap sign-in to
// /parent/meetings; an invite-pending account ('!' password) gets a fresh
// 7-day set-your-password link that lands there afterwards.

const db = require('../../config/database');
const logger = require('../../logger');
const S = require('./state');
const { timeLabel, rangeLabel, overlaps } = require('./slots');
const T = require('./time');
const { calendarFile } = require('./ics');
const tpl = require('../../templates/meetingEmails');
const schoolQueries = require('../../queries/school.queries');
const adminUserQueries = require('../../queries/adminUser.queries');
const { schoolSender } = require('../email/senderIdentity');
const { signEmailLoginToken, emailLoginUrl } = require('../../utils/emailLoginLink');
const { getSchoolName } = require('../../utils/schoolUtils');

const PARENT_PATH = '/parent/meetings';
const TEACHER_PATH = '/my-meetings';
const base = () => process.env.FRONTEND_URL || '';
const unique = (values) => [...new Set(values)];
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`);

const SKIP = Object.freeze({
  GONE: 'These meetings were deleted',
  NOT_OPEN: 'Booking is not open',
  NOT_GUARDIAN: 'No longer a guardian of a child with meetings',
  NOTHING: 'Nothing to send any more',
  BOOKED: 'The family has booked since',
});

async function schoolContext(school) {
  let schoolInfo = null;
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    schoolInfo = rows[0] || null;
  } catch (error) {
    logger.warn({ err: error.message, school }, 'School lookup failed for a meetings email');
  }
  return { schoolInfo, schoolName: getSchoolName(school) };
}

async function load(job) {
  const state = await S.loadEvent(db, job.payload?.eventId || job.subject_id, job.school);
  const people = state ? await S.loadPeople(db, state.event) : null;
  if (state) S.orderBookings(state, people);
  return { state, people, ...(await schoolContext(job.school)) };
}

const message = (job, schoolInfo, email, extra = {}) => ({
  ...schoolSender({ school: job.school, schoolInfo, role: 'messages' }),
  to: [job.recipient_email],
  subject: email.subject,
  html: email.html,
  ...extra,
});

/** The recipient as a guardian: their account and their children with meetings this year. */
function guardianOf(people, job) {
  let guardian = null;
  const childIds = new Set();
  for (const s of people.students.values()) {
    const g = s.guardians.find((x) => x.userId && x.userId === job.recipient_user_id);
    if (!g) continue;
    guardian = guardian || g;
    childIds.add(s.id);
  }
  return guardian ? { guardian, childIds } : null;
}

async function parentLink(guardian, studentId, next) {
  if (guardian.pending) {
    const { rows: [t] } = await db.query(adminUserQueries.createInviteToken, [guardian.userId]);
    return { url: `${base()}/reset-password?token=${t.token}&invite=1&next=${encodeURIComponent(next)}`, createAccount: true };
  }
  const token = signEmailLoginToken({ userId: guardian.userId, studentId, email: guardian.email });
  return { url: emailLoginUrl({ token, next }), createAccount: false };
}

/** Teachers taking part, for these children: [{ teacher, studentIds }] (never the guardian themself). */
function teachersFor(state, people, childIds, selfId) {
  const out = [];
  for (const [teacherId, teacher] of people.teachers) {
    if (teacherId === selfId || !S.takingPart(state, people, teacherId)) continue;
    const kids = S.byAge(people, [...childIds].filter((id) => teacher.studentIds.has(id)));
    if (kids.length) out.push({ teacher, studentIds: kids });
  }
  return out.sort((a, b) => a.teacher.name.localeCompare(b.teacher.name));
}

/** "Homeroom", "Arabic", "Homeroom, Gr 6 Math". */
function subjectFor(teacher, studentIds) {
  const homeroom = studentIds.some((id) => teacher.homeroomIds.has(id));
  const subjects = unique(studentIds.flatMap((id) => teacher.subjectsByStudent.get(id) || []));
  return [homeroom ? 'Homeroom' : null, ...subjects].filter(Boolean).slice(0, 3).join(', ');
}

const kidNames = (people, ids) => joinNames(ids.map((id) => people.students.get(id)?.firstName).filter(Boolean));

/** The family's meetings now, by day: [{ day, label, bookings, items }]. */
function familyDays(state, people, childIds) {
  const mine = state.bookings.filter((b) => b.student_ids.some((id) => childIds.has(id)));
  return state.days
    .map((day) => {
      const bookings = mine.filter((b) => b.day_id === day.day_id).sort((a, b) => a.start_min - b.start_min);
      return {
        day,
        label: T.longDay(day.day_date),
        bookings,
        items: bookings.map((b) => {
          const teacher = people.teachers.get(b.teacher_id);
          const subject = teacher ? subjectFor(teacher, b.student_ids) : '';
          return {
            time: timeLabel(b.start_min),
            title: [teacher?.name || 'Teacher', subject].filter(Boolean).join(' · '),
            sub: [kidNames(people, b.student_ids), S.familyPlaceFor(state, people, b)].filter(Boolean).join(' · '),
            byPhone: S.isPhone(b),
          };
        }),
      };
    })
    .filter((d) => d.bookings.length);
}

const cutoffLabel = (event) => (event.cutoff_min == null
  ? 'before the meeting starts'
  : `by ${timeLabel(event.cutoff_min)} the evening before`);

/** Days families can still book: [{ day, ... }] whose cutoff is ahead. */
const bookableDays = (state, now) => state.days.filter((d) => now < T.cutoffAt(state.event, d));

/** The window a parent sees for a day: earliest to latest teacher time. */
function dayWindow(state, people, day) {
  let start = Infinity;
  let end = -Infinity;
  for (const teacherId of people.teachers.keys()) {
    if (!S.takingPart(state, people, teacherId)) continue;
    const plan = S.planFor(state, teacherId, day);
    if (!plan.works || !plan.slots.length) continue;
    start = Math.min(start, plan.slots[0].start);
    end = Math.max(end, plan.slots[plan.slots.length - 1].end);
  }
  return Number.isFinite(start) ? { start, end } : null;
}

const dayLine = (day, w) => {
  const d = new Date(`${day.day_date}T12:00:00Z`);
  const label = `${d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' })}, ${d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })}`;
  return w ? `${label}, ${rangeLabel(w.start, w.end)}` : label;
};

const datesShort = (days) => joinNames(days.map((d) => T.shortDay(d.day_date).replace(',', '')));

// ── ptm_invite ─────────────────────────────────────────────

const inviteHandler = {
  async build(job, siblings, { now = new Date() } = {}) {
    const { state, people, schoolInfo, schoolName } = await load(job);
    if (!state) return { skip: SKIP.GONE };
    if (state.event.status !== 'open' || !bookableDays(state, now).length) return { skip: SKIP.NOT_OPEN };
    const who = guardianOf(people, job);
    if (!who) return { skip: SKIP.NOT_GUARDIAN };
    const { guardian, childIds } = who;
    const teachers = teachersFor(state, people, childIds, guardian.userId);
    if (!teachers.length) return { skip: SKIP.NOTHING };
    const children = [...childIds]
      .map((id) => people.students.get(id))
      .filter((s) => teachers.some((t) => t.studentIds.includes(s.id)))
      .sort((a, b) => S.gradeRank(b.grade) - S.gradeRank(a.grade))
      .map((s) => {
        const n = teachers.filter((t) => t.studentIds.includes(s.id)).length;
        const room = state.event.use_grade_room ? `${S.gradeLabel(s.grade)} room` : null;
        return { name: s.firstName, detail: [room, `${n} teacher${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ') };
      });
    const days = bookableDays(state, now);
    const first = [...childIds][0];
    const link = await parentLink(guardian, first, PARENT_PATH);
    const plan = link.createAccount ? link : await parentLink(guardian, first, `${PARENT_PATH}?plan=1`);
    const email = tpl.inviteEmail({
      firstName: guardian.firstName,
      children,
      dayLines: days.map((d) => dayLine(d, dayWindow(state, people, d))),
      datesShort: datesShort(days),
      slotMinutes: state.event.slot_minutes,
      allowPhone: state.event.allow_phone,
      changesLabel: state.event.cutoff_min == null ? 'Until the meeting starts' : `Until ${timeLabel(state.event.cutoff_min)} the evening before`,
      link: link.url,
      planLink: plan.url,
      createAccount: link.createAccount,
      schoolName,
      schoolInfo,
    });
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject, createAccount: link.createAccount },
      push: link.createAccount ? null : {
        category: 'reminders',
        title: 'Parent–teacher meetings: booking is open',
        body: `Book your times with ${teachers.length} teacher${teachers.length === 1 ? '' : 's'}.`,
        path: PARENT_PATH,
      },
    };
  },
};

// ── ptm_family_update ──────────────────────────────────────

const howLabel = (mode, phone) => (mode === 'phone' ? `a phone call${phone ? ` to ${phone}` : ''}` : 'in person');

/** Did a change switch in person ↔ phone, or the number? (Older payloads have no mode: unchanged.) */
const howChanged = (c) => c.fromMode != null && c.mode != null
  && (c.fromMode !== c.mode || (c.mode === 'phone' && (c.fromPhone || null) !== (c.phone || null)));
const timeChanged = (c) => c.fromDay !== c.day || c.fromStart !== c.start;

function changeLine(c) {
  const when = (day, start) => (day ? `${T.shortDay(day)} at ${timeLabel(start)}` : timeLabel(start));
  const kids = c.studentNames ? ` (${c.studentNames})` : '';
  if (c.type === 'moved') {
    if (!timeChanged(c)) return `${c.teacherName}${kids}, ${when(c.day, c.start)}: now ${howLabel(c.mode, c.phone)}`;
    const now = howChanged(c) ? `, now ${howLabel(c.mode, c.phone)}` : '';
    return `${c.teacherName}${kids}: moved from ${when(c.fromDay, c.fromStart)} to ${when(c.day, c.start)}${now}`;
  }
  if (c.type === 'cancelled') return `${c.teacherName}${kids}, ${when(c.day, c.start)}: cancelled`;
  return `${c.teacherName}${kids}: booked for ${when(c.day, c.start)}${c.mode === 'phone' ? ', a phone call' : ''}`;
}

/** "Ms. Saleh will call you at 416-… from 905-…." */
function callLine(state, people, b) {
  const from = S.callFromFor(state, people, b.teacher_id);
  return `${people.teachers.get(b.teacher_id)?.name || 'The teacher'} will call you at ${b.phone}${from ? ` from ${from}` : ''}.`;
}

/** The current meetings as calendar events, and a cancel file for any cancelled since. */
function calendarAttachments(state, people, days, changes, schoolName, now) {
  const attachments = [];
  const current = days.flatMap((d) => d.bookings.map((b) => ({
    uid: b.booking_id,
    sequence: b.sequence,
    date: d.day.day_date,
    start: b.start_min,
    end: b.end_min,
    summary: `${S.isPhone(b) ? 'Phone call' : 'Meeting'} with ${people.teachers.get(b.teacher_id)?.name || 'a teacher'} (${kidNames(people, b.student_ids)})`,
    location: S.isPhone(b) ? S.familyPlaceFor(state, people, b) : [S.roomFor(state, people, b.teacher_id, b.student_ids), schoolName].filter(Boolean).join(', '),
    description: S.isPhone(b) ? callLine(state, people, b) : undefined,
  })));
  if (current.length) {
    attachments.push({ filename: 'meetings.ics', content: Buffer.from(calendarFile({ events: current, now })), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' });
  }
  const live = new Set(current.map((e) => e.uid));
  const gone = changes.filter((c) => c.type === 'cancelled' && !live.has(c.bookingId) && c.day);
  if (gone.length) {
    const events = gone.map((c) => ({
      uid: c.bookingId, sequence: (c.sequence || 0) + 1, date: c.day, start: c.start, end: c.end,
      summary: `Meeting with ${c.teacherName}${c.studentNames ? ` (${c.studentNames})` : ''}`,
    }));
    attachments.push({ filename: 'cancelled.ics', content: Buffer.from(calendarFile({ method: 'CANCEL', events, now })), contentType: 'text/calendar; charset=utf-8; method=CANCEL' });
  }
  return attachments;
}

/** "Ms. Qureshi (Sara). All her times are taken right now." for teachers not booked yet. */
function toBookLines(state, people, childIds, selfId, now) {
  const days = bookableDays(state, now);
  if (!days.length) return [];
  return teachersFor(state, people, childIds, selfId)
    .map(({ teacher, studentIds }) => ({
      teacher,
      kids: studentIds.filter((id) => !state.bookings.some((b) => b.teacher_id === teacher.id && b.student_ids.includes(id))),
    }))
    .filter((t) => t.kids.length)
    .map(({ teacher, kids }) => {
      const open = days.some((d) => S.openTimes(state, teacher.id, d).length);
      return `${teacher.name} (${kidNames(people, kids)})${open ? '' : '. All their times are taken right now; if one opens up, you\'ll see it in the Parent Portal'}`;
    });
}

/**
 * One line per meeting, net of everything in this email: booked then moved
 * reads as booked at the new time; booked then cancelled says nothing; moved
 * then cancelled is cancelled at the time the family knew.
 */
function collapseChanges(changes) {
  const byBooking = new Map();
  for (const c of changes) {
    const prev = byBooking.get(c.bookingId);
    if (!prev) {
      byBooking.set(c.bookingId, { ...c });
      continue;
    }
    if (c.type === 'cancelled') {
      if (prev.type === 'booked') byBooking.delete(c.bookingId);
      else byBooking.set(c.bookingId, { ...c, day: prev.fromDay ?? c.day, start: prev.fromStart ?? c.start, end: prev.fromEnd ?? c.end });
      continue;
    }
    if (c.type === 'moved') {
      byBooking.set(c.bookingId, prev.type === 'booked'
        ? { ...c, type: 'booked', fromDay: null, fromStart: null, fromEnd: null, fromMode: null, fromPhone: null }
        : { ...c, fromDay: prev.fromDay, fromStart: prev.fromStart, fromEnd: prev.fromEnd, fromMode: prev.fromMode, fromPhone: prev.fromPhone });
      continue;
    }
    byBooking.set(c.bookingId, { ...c });
  }
  // Moved and moved back (or switched and switched back): nothing to say.
  return [...byBooking.values()].filter((c) => c.type !== 'moved' || timeChanged(c) || howChanged(c));
}

const familyUpdateHandler = {
  async build(job, siblings = [], { now = new Date() } = {}) {
    const jobs = [job, ...siblings].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const changes = collapseChanges(jobs.flatMap((j) => j.payload?.changes || []));
    if (!changes.length) return { skip: 'Nothing changed in the end' };
    const byOffice = jobs.some((j) => j.payload?.byOffice);
    const { state, people, schoolInfo, schoolName } = await load(job);

    if (!state) {
      // Deleted by the office: the payload is all that's left.
      if (!changes.length || changes.some((c) => c.type !== 'cancelled')) return { skip: SKIP.GONE };
      const email = tpl.familyUpdateEmail({
        firstName: null, mode: 'cancelled', count: 0, changeLines: changes.map(changeLine), days: [], toBook: [],
        slotMinutes: 10, link: `${base()}${PARENT_PATH}`, cutoffLabel: '', hasIcs: false, createAccount: false, schoolName, schoolInfo,
      });
      const events = changes.filter((c) => c.day).map((c) => ({
        uid: c.bookingId, sequence: (c.sequence || 0) + 1, date: c.day, start: c.start, end: c.end, summary: `Meeting with ${c.teacherName}`,
      }));
      const attachments = events.length
        ? [{ filename: 'cancelled.ics', content: Buffer.from(calendarFile({ method: 'CANCEL', events, now })), contentType: 'text/calendar; charset=utf-8; method=CANCEL' }]
        : undefined;
      return { message: message(job, schoolInfo, email, attachments ? { attachments } : {}), sentContent: { subject: email.subject, changes: changes.length } };
    }

    const who = guardianOf(people, job);
    if (!who) return { skip: SKIP.NOT_GUARDIAN };
    const { guardian, childIds } = who;
    const days = familyDays(state, people, childIds);
    const count = days.reduce((n, d) => n + d.bookings.length, 0);
    const mode = byOffice ? (count === 0 && changes.every((c) => c.type === 'cancelled') ? 'cancelled' : 'office')
      : (count === 0 ? 'cancelled' : 'booked');
    const lines = mode === 'booked' ? changes.filter((c) => c.type === 'cancelled').map(changeLine) : changes.map(changeLine);
    const link = await parentLink(guardian, [...childIds][0], PARENT_PATH);
    const attachments = calendarAttachments(state, people, days, changes, schoolInfo?.name || schoolName, now);
    const email = tpl.familyUpdateEmail({
      firstName: guardian.firstName,
      mode,
      count,
      changeLines: lines,
      days: days.map((d) => ({ label: d.label, items: d.items })),
      toBook: toBookLines(state, people, childIds, guardian.userId, now),
      slotMinutes: state.event.slot_minutes,
      link: link.url,
      cutoffLabel: cutoffLabel(state.event),
      hasIcs: attachments.some((a) => a.filename === 'meetings.ics'),
      createAccount: link.createAccount,
      schoolName,
      schoolInfo,
    });
    const firstItem = days[0]?.items[0];
    return {
      message: message(job, schoolInfo, email, attachments.length ? { attachments } : {}),
      sentContent: { subject: email.subject, meetings: count, changes: changes.length },
      push: link.createAccount ? null : {
        category: 'reminders',
        title: mode === 'booked' ? `Booked: ${count} meeting${count === 1 ? '' : 's'}` : mode === 'office' ? 'The school changed your meetings' : 'Meetings cancelled',
        body: firstItem ? `${T.shortDay(days[0].day.day_date)} ${firstItem.time} · ${firstItem.title}` : 'Open to see your meetings.',
        path: PARENT_PATH,
      },
    };
  },
};

// ── ptm_reminder ───────────────────────────────────────────

const reminderHandler = {
  async build(job, siblings, { now = new Date() } = {}) {
    const { state, people, schoolInfo, schoolName } = await load(job);
    if (!state) return { skip: SKIP.GONE };
    const who = guardianOf(people, job);
    if (!who) return { skip: SKIP.NOT_GUARDIAN };
    const { guardian, childIds } = who;
    const all = familyDays(state, people, childIds);
    const today = all.find((d) => d.day.day_id === job.payload?.dayId);
    if (!today) return { skip: SKIP.NOTHING };
    const later = all.filter((d) => d.day.day_date > today.day.day_date)
      .map((d) => `${T.weekday(d.day.day_date)}: ${d.items.map((it) => `${it.title.split(' · ')[0]} at ${it.time}`).join(', ')}`);
    const link = await parentLink(guardian, [...childIds][0], PARENT_PATH);
    const cutoff = T.cutoffAt(state.event, today.day);
    const email = tpl.reminderEmail({
      firstName: guardian.firstName,
      dayLabel: T.longDay(today.day.day_date),
      firstTime: today.items[0].time,
      items: today.items,
      // The school's address, unless every meeting that day is a phone call.
      where: schoolInfo?.address && today.items.some((it) => !it.byPhone) ? [schoolInfo.name || schoolName, schoolInfo.address].join(', ') : null,
      laterLines: later,
      link: link.url,
      cutoffLabel: state.event.cutoff_min != null && now < cutoff ? `by ${timeLabel(state.event.cutoff_min)} tonight` : null,
      schoolName,
      schoolInfo,
    });
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject, meetings: today.items.length },
      push: link.createAccount ? null : {
        category: 'reminders',
        title: `Tomorrow: meetings from ${today.items[0].time}`,
        body: today.items.map((it) => `${it.time} ${it.title.split(' · ')[0]}`).slice(0, 3).join(' · '),
        path: PARENT_PATH,
      },
    };
  },
};

// ── ptm_last_call ──────────────────────────────────────────

const lastCallHandler = {
  async build(job, siblings, { now = new Date() } = {}) {
    const { state, people, schoolInfo, schoolName } = await load(job);
    if (!state) return { skip: SKIP.GONE };
    const days = bookableDays(state, now);
    if (state.event.status !== 'open' || !days.length) return { skip: SKIP.NOT_OPEN };
    const who = guardianOf(people, job);
    if (!who) return { skip: SKIP.NOT_GUARDIAN };
    const { guardian, childIds } = who;
    const family = new Set(S.familyStudents(people, [...childIds]));
    if (state.bookings.some((b) => b.student_ids.some((id) => family.has(id)))) return { skip: SKIP.BOOKED };
    const teachers = teachersFor(state, people, childIds, guardian.userId);
    if (!teachers.length) return { skip: SKIP.NOTHING };
    const rows = teachers.map(({ teacher, studentIds }) => {
      const counts = days.map((d) => [T.shortDay(d.day_date).split(',')[0], S.openTimes(state, teacher.id, d).length]).filter(([, n]) => n);
      return {
        name: teacher.name,
        teacher: `${teacher.name} · ${subjectFor(teacher, studentIds) || 'Teacher'}`,
        open: counts.length ? counts.map(([d, n]) => `${d} ${n}`).join(' · ') : null,
      };
    });
    const kids = [...childIds].filter((id) => teachers.some((t) => t.studentIds.includes(id)));
    const link = await parentLink(guardian, kids[0], PARENT_PATH);
    const plan = link.createAccount ? link : await parentLink(guardian, kids[0], `${PARENT_PATH}?plan=1`);
    const email = tpl.lastCallEmail({
      firstName: guardian.firstName,
      whose: kids.length === 1 ? `${people.students.get(kids[0]).firstName}'s teachers` : "your children's teachers",
      rows,
      link: link.url,
      planLink: plan.url,
      closingLine: days.map((d) => `Booking for ${T.weekday(d.day_date)} closes ${T.instantLabel(T.cutoffAt(state.event, d))}.`).join(' '),
      fullTeachers: rows.filter((r) => !r.open).map((r) => r.name),
      createAccount: link.createAccount,
      schoolName,
      schoolInfo,
    });
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject },
      push: link.createAccount ? null : {
        category: 'reminders',
        title: 'Parent–teacher meeting times are still open',
        body: "You haven't booked yet. Tap to see the times.",
        path: PARENT_PATH,
      },
    };
  },
};

// ── ptm_teacher_list ───────────────────────────────────────

const teacherListHandler = {
  async build(job) {
    const { state, people, schoolInfo, schoolName } = await load(job);
    if (!state) return { skip: SKIP.GONE };
    const teacherId = job.recipient_user_id;
    const teacher = people.teachers.get(teacherId);
    const day = state.days.find((d) => d.day_id === job.payload?.dayId);
    if (!teacher || !day || !S.takingPart(state, people, teacherId)) return { skip: SKIP.NOTHING };
    const bookings = state.bookings.filter((b) => b.teacher_id === teacherId && b.day_id === day.day_id).sort((a, b) => a.start_min - b.start_min);
    if (!bookings.length) return { skip: SKIP.NOTHING };
    const plan = S.planFor(state, teacherId, day);
    const items = [
      ...bookings.map((b) => {
        const guardians = unique(b.student_ids.flatMap((id) => people.students.get(id).guardians.map((g) => g.name).filter(Boolean)));
        return {
          at: b.start_min,
          time: timeLabel(b.start_min),
          title: `${b.student_ids.map((id) => people.students.get(id)?.name).filter(Boolean).join(' & ')} · ${subjectFor(teacher, b.student_ids) || 'Meeting'}`,
          sub: [guardians.slice(0, 2).join(' & '), S.placeFor(state, people, b)].filter(Boolean).join(' · '),
        };
      }),
      ...plan.breaks.filter((br) => br.start >= plan.start && br.start < plan.end).map((br) => ({
        at: br.start, time: timeLabel(br.start), title: `Break until ${timeLabel(br.end)}`, muted: true,
      })),
    ].sort((a, b) => a.at - b.at);
    const open = S.openTimes(state, teacherId, day);
    const openLine = open.length
      ? `${open.length} time${open.length === 1 ? '' : 's'} stayed open (${open.slice(0, 4).map((s) => timeLabel(s.start).replace(/ [AP]M$/, '')).join(', ')}${open.length > 4 ? ', …' : ''}).`
      : '';
    const query = `?event=${state.event.event_id}&day=${day.day_id}`;
    const email = tpl.teacherListEmail({
      firstName: teacher.firstName,
      dayName: T.weekday(day.day_date),
      count: bookings.length,
      rangeText: rangeLabel(plan.start, plan.end),
      items,
      openLine,
      printLink: `${base()}${TEACHER_PATH}${query}&print=1`,
      pageLink: `${base()}${TEACHER_PATH}${query}`,
      schoolName,
      schoolInfo,
    });
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject, meetings: bookings.length },
      push: {
        category: 'reminders',
        title: `Your ${bookings.length} meeting${bookings.length === 1 ? '' : 's'} tomorrow`,
        body: `First at ${timeLabel(bookings[0].start_min)}.`,
        path: TEACHER_PATH,
      },
    };
  },
};

module.exports = {
  SKIP,
  PARENT_PATH,
  inviteHandler,
  familyUpdateHandler,
  collapseChanges,
  reminderHandler,
  lastCallHandler,
  teacherListHandler,
  teachersFor,
  subjectFor,
  familyDays,
  bookableDays,
  dayWindow,
  overlaps,
};
