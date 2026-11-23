// services/meetings/views.js
//
// What each page reads, built from one loaded event (state.js): the parent's
// Meetings page, a teacher's My Meetings, the office's Setup and Board, and
// the office's family search. Times are minutes from midnight; dates are
// 'YYYY-MM-DD'; instants are ISO strings.

const S = require('./state');
const { slotsFor, overlaps, timeLabel } = require('./slots');
const T = require('./time');
const { childrenOf } = require('./booking');
const { teachersFor, subjectFor, dayWindow } = require('./emails');

const iso = (d) => (d ? new Date(d).toISOString() : null);
const unique = (values) => [...new Set(values)];
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`);

function eventView(state, now) {
  const e = state.event;
  return {
    eventId: e.event_id,
    title: e.title,
    status: e.status,
    phase: T.phaseOf(e, state.days, now),
    slotMinutes: e.slot_minutes,
    opensAt: iso(e.opens_at),
    openedAt: iso(e.opened_at),
    cutoffMin: e.cutoff_min,
    useGradeRoom: e.use_grade_room,
    siblingsShare: e.siblings_share,
    teachersEditHours: e.teachers_edit_hours,
    emailInvite: e.email_invite,
    emailLastCall: e.email_last_call,
    lastCallAt: iso(e.last_call_at),
    lastCallSentAt: iso(e.last_call_sent_at),
    emailReminder: e.email_reminder,
    reminderMin: e.reminder_min,
    emailTeacherList: e.email_teacher_list,
    allowPhone: e.allow_phone,
  };
}

/** How a booking happens, for every page: in person in `room`, or a phone call to `phone`. */
const howView = (state, people, b) => ({
  mode: S.isPhone(b) ? 'phone' : 'in_person',
  phone: S.isPhone(b) ? b.phone : null,
  room: S.isPhone(b) ? null : S.roomFor(state, people, b.teacher_id, b.student_ids),
});

const dayBase = (state, day, now) => ({
  dayId: day.day_id,
  date: day.day_date,
  start: day.start_min,
  end: day.end_min,
  everyone: day.everyone,
  cutoffAt: iso(T.cutoffAt(state.event, day)),
  bookable: now < T.cutoffAt(state.event, day),
});

const isFuture = (day, slot, now) => T.torontoAt(day.day_date, slot.start) > now;

// ── Parent ─────────────────────────────────────────────────

function parentView(state, people, userId, now = new Date()) {
  const childIds = childrenOf(people, userId);
  const teachers = teachersFor(state, people, childIds, userId);
  const kids = [...childIds].map((id) => people.students.get(id))
    .filter((s) => teachers.some((t) => t.studentIds.includes(s.id)))
    .sort((a, b) => S.gradeRank(b.grade) - S.gradeRank(a.grade) || a.name.localeCompare(b.name));
  const family = new Set([...S.familyStudents(people, [...childIds]), ...childIds]);
  return {
    ...eventView(state, now),
    // The number a phone call meeting suggests (theirs from the last one, else the file's).
    phone: S.phoneFor(state, people, [...childIds], userId),
    days: state.days.map((day) => ({ ...dayBase(state, day, now), window: dayWindow(state, people, day) })),
    children: kids.map((s) => ({
      studentId: s.id, name: s.name, firstName: s.firstName, grade: s.grade, gradeLabel: S.gradeLabel(s.grade),
      room: state.event.use_grade_room ? `${S.gradeLabel(s.grade)} room` : null,
    })),
    teachers: teachers.map(({ teacher, studentIds }) => ({
      teacherId: teacher.id,
      name: teacher.name,
      studentIds,
      subjects: Object.fromEntries(studentIds.map((id) => [id, subjectFor(teacher, [id]) || 'Teacher'])),
      // A class of theirs with each child, so "Message" can open a new message about it.
      classIds: Object.fromEntries(studentIds.map((id) => [id, teacher.classesByStudent.get(id)?.[0]?.classId || null])),
      room: state.settings.get(teacher.id)?.room || null,
      slotMinutes: S.lengthFor(state, teacher.id),
      days: state.days.map((day) => {
        const plan = S.planFor(state, teacher.id, day);
        const bookable = now < T.cutoffAt(state.event, day);
        return {
          dayId: day.day_id,
          works: plan.works && plan.slots.length > 0,
          total: plan.slots.length,
          open: bookable ? S.openTimes(state, teacher.id, day).filter((s) => isFuture(day, s, now)).map(({ start, end }) => ({ start, end })) : [],
        };
      }),
    })),
    bookings: state.bookings
      .filter((b) => b.student_ids.some((id) => family.has(id)))
      .map((b) => {
        const day = state.days.find((d) => d.day_id === b.day_id);
        return {
          bookingId: b.booking_id,
          teacherId: b.teacher_id,
          teacherName: people.teachers.get(b.teacher_id)?.name || 'Teacher',
          dayId: b.day_id,
          start: b.start_min,
          end: b.end_min,
          studentIds: b.student_ids,
          ...howView(state, people, b),
          // A phone call: the number the teacher calls from (only on the family's own phone calls).
          callFrom: S.isPhone(b) ? S.callFromFor(state, people, b.teacher_id) : null,
          canChange: now < T.cutoffAt(state.event, day),
          byOffice: b.by_office,
        };
      })
      .sort((a, b) => a.start - b.start),
  };
}

// ── Teacher ────────────────────────────────────────────────

function bookingView(state, people, teacher, b) {
  return {
    bookingId: b.booking_id,
    ...howView(state, people, b),
    byOffice: b.by_office,
    students: b.student_ids.map((id) => {
      const s = people.students.get(id);
      return {
        studentId: id,
        name: s?.name || 'Student',
        firstName: s?.firstName || '',
        grade: s?.grade || null,
        gradeLabel: S.gradeLabel(s?.grade),
        homeroom: teacher.homeroomIds.has(id),
        subjects: teacher.subjectsByStudent.get(id) || [],
        classes: teacher.classesByStudent.get(id) || [],
      };
    }),
    guardians: unique(b.student_ids.flatMap((id) => (people.students.get(id)?.guardians || []).map((g) => g.name).filter(Boolean))).slice(0, 3),
  };
}

function teacherDaysView(state, people, teacherId, now) {
  const teacher = people.teachers.get(teacherId);
  return state.days.map((day) => {
    const plan = S.planFor(state, teacherId, day);
    const dayBreaks = state.breaks.filter((b) => b.day_id === day.day_id);
    const closed = dayBreaks.filter((b) => b.teacher_id === teacherId && b.kind === 'closed');
    const bookings = state.bookings.filter((b) => b.teacher_id === teacherId && b.day_id === day.day_id);
    const slots = plan.slots.map((s) => {
      const b = bookings.find((x) => x.start_min === s.start);
      const block = closed.find((c) => overlaps({ start: c.start_min, end: c.end_min }, s));
      return {
        start: s.start,
        end: s.end,
        closed: !b && s.closed,
        closedBreakId: !b && block ? block.break_id : null,
        closedLabel: !b && block ? block.label : null,
        past: !isFuture(day, s, now),
        booking: b && teacher ? bookingView(state, people, teacher, b) : null,
      };
    });
    return {
      ...dayBase(state, day, now),
      works: plan.works,
      ownHours: plan.ownHours,
      hoursStart: plan.start,
      hoursEnd: plan.end,
      breaks: dayBreaks.filter((b) => !b.teacher_id).map((b) => ({ breakId: b.break_id, start: b.start_min, end: b.end_min, label: b.label })),
      ownBreaks: dayBreaks.filter((b) => b.teacher_id === teacherId && b.kind === 'break')
        .map((b) => ({ breakId: b.break_id, start: b.start_min, end: b.end_min, label: b.label })),
      slots,
      booked: bookings.length,
      open: slots.filter((s) => !s.booking && !s.closed).length,
    };
  });
}

function teacherView(state, people, teacherId, now = new Date()) {
  const teacher = people.teachers.get(teacherId);
  const own = state.settings.get(teacherId);
  return {
    ...eventView(state, now),
    termId: people.term?.term_id || null,
    takingPart: S.takingPart(state, people, teacherId),
    canEditHours: state.event.teachers_edit_hours,
    teacher: teacher ? { teacherId, name: teacher.name } : null,
    ownSlotMinutes: own?.slot_minutes ?? null,
    teacherSlotMinutes: S.lengthFor(state, teacherId),
    room: own?.room || null,
    // "Number I'll call from" for these meetings, and the number on their account.
    callFrom: own?.call_from || null,
    myPhone: teacher?.phone || null,
    days: teacherDaysView(state, people, teacherId, now),
  };
}

// ── Office: setup ──────────────────────────────────────────

function setupView(state, people, now = new Date()) {
  const audience = [...people.students.values()].filter((s) => [...s.teacherIds].some((t) => S.takingPart(state, people, t)));
  const families = new Set(audience.map((s) => people.familyOf.get(s.id)));
  const accounts = new Map();
  for (const s of audience) {
    for (const g of s.guardians) {
      if (!g.email) continue;
      const prev = accounts.get(g.email);
      accounts.set(g.email, prev === 'live' ? 'live' : (g.userId && !g.pending ? 'live' : 'new'));
    }
  }
  const teachers = [...people.teachers.values()].sort((a, b) => a.name.localeCompare(b.name)).map((t) => {
    const settings = state.settings.get(t.id);
    const takingPart = settings?.taking_part !== false;
    const days = state.days.map((day) => {
      const plan = S.planFor(state, t.id, day);
      return {
        dayId: day.day_id,
        works: plan.works,
        ownHours: plan.ownHours,
        start: plan.start,
        end: plan.end,
        times: plan.slots.filter((s) => !s.closed).length,
        breaks: state.breaks.filter((b) => b.day_id === day.day_id && b.teacher_id === t.id && b.kind === 'break')
          .map((b) => ({ breakId: b.break_id, start: b.start_min, end: b.end_min, label: b.label })),
      };
    });
    const times = days.reduce((n, d) => n + (d.works ? d.times : 0), 0);
    const familyCount = new Set([...t.studentIds].map((id) => people.familyOf.get(id))).size;
    const demand = state.event.siblings_share ? familyCount : t.studentIds.size;
    return {
      teacherId: t.id,
      name: t.name,
      teaches: S.teachesLabel(people, t),
      families: familyCount,
      students: t.studentIds.size,
      takingPart,
      slotMinutes: settings?.slot_minutes ?? null,
      room: settings?.room ?? null,
      callFrom: settings?.call_from ?? null,
      phone: t.phone || null,
      times,
      perTime: times ? Math.round((demand / times) * 10) / 10 : null,
      bookings: state.bookings.filter((b) => b.teacher_id === t.id).length,
      days,
    };
  });
  const bookedFamilies = new Set(state.bookings.flatMap((b) => b.student_ids).map((id) => people.familyOf.get(id)));
  return {
    ...eventView(state, now),
    days: state.days.map((day) => {
      const breaks = state.breaks.filter((b) => b.day_id === day.day_id && !b.teacher_id);
      return {
        ...dayBase(state, day, now),
        label: T.longDay(day.day_date),
        breaks: breaks.map((b) => ({ breakId: b.break_id, start: b.start_min, end: b.end_min, label: b.label })),
        timesPerTeacher: slotsFor(day.start_min, day.end_min, state.event.slot_minutes, breaks.map((b) => ({ start: b.start_min, end: b.end_min }))).length,
        teacherIds: state.days.length && !day.everyone
          ? [...people.teachers.keys()].filter((id) => state.teacherDays.get(`${day.day_id}:${id}`)?.works) : [],
        bookings: state.bookings.filter((b) => b.day_id === day.day_id).length,
      };
    }),
    teachers,
    stats: {
      families: families.size,
      oneTap: [...accounts.values()].filter((v) => v === 'live').length,
      createAccount: [...accounts.values()].filter((v) => v === 'new').length,
      times: teachers.filter((t) => t.takingPart).reduce((n, t) => n + t.times, 0),
      bookings: state.bookings.length,
      familiesBooked: [...families].filter((f) => bookedFamilies.has(f)).length,
    },
  };
}

// ── Office: board ──────────────────────────────────────────

function boardView(state, people, dayId, now = new Date()) {
  const day = state.days.find((d) => d.day_id === dayId) || state.days[0];
  if (!day) return { ...eventView(state, now), day: null, columns: [], times: [], breaks: [] };
  const columns = [...people.teachers.values()]
    .filter((t) => S.takingPart(state, people, t.id))
    .map((t) => ({ t, plan: S.planFor(state, t.id, day) }))
    .filter(({ plan }) => plan.works && plan.slots.length)
    .sort((a, b) => a.t.name.localeCompare(b.t.name))
    .map(({ t, plan }) => {
      const bookings = state.bookings.filter((b) => b.teacher_id === t.id && b.day_id === day.day_id);
      const cells = plan.slots.map((s) => {
        const b = bookings.find((x) => x.start_min === s.start);
        if (b) {
          const kids = b.student_ids.map((id) => people.students.get(id)).filter(Boolean);
          return {
            start: s.start, end: s.end, kind: 'booked',
            booking: {
              bookingId: b.booking_id, byOffice: b.by_office, studentIds: b.student_ids,
              family: kids[0]?.lastName || 'Family', kids: joinNames(kids.map((k) => k.firstName)),
              ...howView(state, people, b),
            },
          };
        }
        return { start: s.start, end: s.end, kind: s.closed ? 'closed' : 'open' };
      });
      const sameAsSchool = plan.start === day.start_min && plan.end === day.end_min;
      return {
        teacherId: t.id,
        name: t.name,
        teaches: S.teachesLabel(people, t),
        hoursLabel: sameAsSchool ? null : `${timeLabel(plan.start)}–${timeLabel(plan.end)}`,
        slotMinutes: plan.length,
        booked: bookings.length,
        open: cells.filter((c) => c.kind === 'open').length,
        cells,
      };
    });
  const times = unique(columns.flatMap((c) => c.cells.map((x) => x.start))).sort((a, b) => a - b);
  const dayBookings = state.bookings.filter((b) => b.day_id === day.day_id);
  return {
    ...eventView(state, now),
    days: state.days.map((d) => ({ ...dayBase(state, d, now), bookings: state.bookings.filter((b) => b.day_id === d.day_id).length })),
    day: { ...dayBase(state, day, now), label: T.longDay(day.day_date) },
    breaks: state.breaks.filter((b) => b.day_id === day.day_id && !b.teacher_id)
      .map((b) => ({ breakId: b.break_id, start: b.start_min, end: b.end_min, label: b.label })),
    columns,
    times,
    stats: { bookings: dayBookings.length },
  };
}

// ── Office: families (Book for a family) ───────────────────

function familiesView(state, people, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  const groups = new Map();
  for (const s of people.students.values()) {
    if (![...s.teacherIds].some((t) => S.takingPart(state, people, t))) continue;
    const key = people.familyOf.get(s.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const out = [];
  for (const [key, kids] of groups) {
    const guardians = unique(kids.flatMap((k) => k.guardians.map((g) => g.name).filter(Boolean)));
    const hay = [...kids.map((k) => k.name), ...guardians].join(' ').toLowerCase();
    if (needle && !hay.includes(needle)) continue;
    kids.sort((a, b) => S.gradeRank(b.grade) - S.gradeRank(a.grade));
    const ids = new Set(kids.map((k) => k.id));
    out.push({
      familyKey: key,
      label: `${kids[0].lastName} family`,
      guardians,
      children: kids.map((k) => ({ studentId: k.id, name: k.name, firstName: k.firstName, grade: k.grade, gradeLabel: S.gradeLabel(k.grade) })),
      teachers: teachersFor(state, people, ids, null).map(({ teacher, studentIds }) => ({
        teacherId: teacher.id,
        name: teacher.name,
        studentIds,
        bookedStudentIds: studentIds.filter((id) => state.bookings.some((b) => b.teacher_id === teacher.id && b.student_ids.includes(id))),
      })),
      bookings: state.bookings.filter((b) => b.student_ids.some((id) => ids.has(id))).length,
      phone: S.phoneFor(state, people, [...ids]),
    });
    if (out.length >= 25) break;
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = { eventView, parentView, teacherView, setupView, boardView, familiesView };
