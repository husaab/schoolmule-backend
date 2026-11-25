// services/meetings/state.js
//
// Reading one parent–teacher meetings event whole, and who takes part.
//
// - loadEvent: the event, its days, breaks, teachers' own settings and
//   hours, and its bookings.
// - loadPeople: for the event's school year, every teacher ↔ student link
//   (live, on-report-card, current-term classes, plus homeroom), the
//   students, their guardians, and the families (students joined by a shared
//   guardian, account or address).
// - planFor / openTimes / roomFor / placeFor / orphans: the computed views
//   every page and email reads, so they always agree with what booking
//   accepts.
// - phoneFor: the number to suggest for a phone call meeting. The teacher
//   calls the family at it; a teacher's own number is never asked for or shown.


const q = require('../../queries/meetings.queries');
const { selectCurrentTerm } = require('../../queries/termScope');
const { teacherDayPlan, orphanedBookings, overlaps } = require('./slots');

const gradeRank = (g) => (g === 'JK' ? -2 : g === 'SK' ? -1 : Number(g) || 0);
const gradeLabel = (g) => (!g ? '' : g === 'JK' || g === 'SK' ? g : `Grade ${g}`);
const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const lastNameOf = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
};
const lower = (v) => (v ? String(v).trim().toLowerCase() : null);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadEvent(client, eventId, school) {
  const { rows: [event] } = await client.query(q.selectEvent, [eventId, school]);
  if (!event) return null;
  const [days, settings, teacherDays, breaks, bookings] = await Promise.all([
    client.query(q.selectDays, [eventId]),
    client.query(q.selectTeacherSettings, [eventId]),
    client.query(q.selectTeacherDays, [eventId]),
    client.query(q.selectBreaks, [eventId]),
    client.query(q.selectBookings, [eventId]),
  ]);
  return {
    event,
    days: days.rows,
    settings: new Map(settings.rows.map((r) => [r.teacher_id, r])),
    teacherDays: new Map(teacherDays.rows.map((r) => [`${r.day_id}:${r.teacher_id}`, r])),
    breaks: breaks.rows,
    bookings: bookings.rows,
  };
}

/** Union–find over student ids. */
function familiesOf(studentIds, guardianRows) {
  const parent = new Map(studentIds.map((id) => [id, id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const byGuardian = new Map();
  for (const g of guardianRows) {
    if (!parent.has(g.student_id)) continue;
    const key = g.parent_id ? `u:${g.parent_id}` : lower(g.parent_email) ? `e:${lower(g.parent_email)}` : null;
    if (!key) continue;
    if (byGuardian.has(key)) union(byGuardian.get(key), g.student_id);
    else byGuardian.set(key, g.student_id);
  }
  const familyOf = new Map(studentIds.map((id) => [id, find(id)]));
  return familyOf;
}

/** A guardian's number: on the link or their account, else the file's for their address, else for their relation. */
function guardianPhone(student, own, email, relation) {
  if (own) return own;
  const { mother, father } = student.file;
  if (email && mother.email === email && mother.phone) return mother.phone;
  if (email && father.email === email && father.phone) return father.phone;
  const rel = lower(relation);
  if (rel === 'mother' && !mother.email && mother.phone) return mother.phone;
  if (rel === 'father' && !father.email && father.phone) return father.phone;
  return null;
}

async function loadPeople(client, event) {
  const { school, school_year_id: yearId } = event;
  const { rows: [term] } = await client.query(selectCurrentTerm, [school, yearId]);
  const [links, students, guardianRows] = await Promise.all([
    client.query(q.selectLinks, [school, yearId, term?.term_id ?? null, term?.name ?? null]),
    client.query(q.selectStudents, [school, yearId]),
    client.query(q.selectGuardianRows, [school, yearId]),
  ]);
  const teacherIds = [...new Set(links.rows.map((l) => l.teacher_id))];
  const parentIds = [...new Set(guardianRows.rows.map((g) => g.parent_id).filter(Boolean))];
  const { rows: users } = await client.query(q.selectUsers, [[...teacherIds, ...parentIds]]);
  const userById = new Map(users.map((u) => [u.user_id, u]));

  const studentMap = new Map(students.rows.map((s) => [s.student_id, {
    id: s.student_id, name: s.name, firstName: firstNameOf(s.name), lastName: lastNameOf(s.name), grade: s.grade,
    homeroomTeacherId: s.homeroom_teacher_id, teacherIds: new Set(), guardians: [],
    file: { mother: { email: lower(s.mother_email), phone: s.mother_number }, father: { email: lower(s.father_email), phone: s.father_number } },
  }]));

  const teachers = new Map();
  for (const l of links.rows) {
    const student = studentMap.get(l.student_id);
    const u = userById.get(l.teacher_id);
    if (!student || !u) continue;
    if (!teachers.has(l.teacher_id)) {
      teachers.set(l.teacher_id, {
        id: l.teacher_id, name: u.name || u.email, firstName: u.first_name, email: u.email, phone: u.phone || null,
        studentIds: new Set(), homeroomIds: new Set(), subjectsByStudent: new Map(), classesByStudent: new Map(), subjects: new Set(),
      });
    }
    const t = teachers.get(l.teacher_id);
    t.studentIds.add(l.student_id);
    student.teacherIds.add(l.teacher_id);
    if (l.homeroom) t.homeroomIds.add(l.student_id);
    if (l.subject) {
      t.subjects.add(l.subject);
      const list = t.subjectsByStudent.get(l.student_id) || [];
      if (!list.includes(l.subject)) list.push(l.subject);
      t.subjectsByStudent.set(l.student_id, list);
    }
    if (l.class_id) {
      const classes = t.classesByStudent.get(l.student_id) || [];
      if (!classes.some((c) => c.classId === l.class_id)) classes.push({ classId: l.class_id, subject: l.subject });
      t.classesByStudent.set(l.student_id, classes);
    }
  }

  // Guardians: a live linked account, a pending one (invite '!'), or an address on file.
  for (const g of guardianRows.rows) {
    const student = studentMap.get(g.student_id);
    if (!student) continue;
    const u = g.parent_id ? userById.get(g.parent_id) : null;
    if (u && (u.is_archived || u.role === 'STUDENT')) continue;
    const email = lower(u?.email || g.parent_email);
    if (!u && !(email && EMAIL_RE.test(email))) continue;
    student.guardians.push({
      linkId: g.parent_student_link_id,
      userId: u?.user_id || null,
      email,
      name: u?.name || g.parent_name || null,
      firstName: u?.first_name || firstNameOf(g.parent_name) || null,
      relation: g.relation,
      phone: guardianPhone(student, g.parent_number || u?.phone, email, g.relation),
      pending: u ? Boolean(u.invite_pending) : true,
      hasAccount: Boolean(u),
    });
  }

  const familyOf = familiesOf([...studentMap.keys()], guardianRows.rows);
  return { term: term || null, students: studentMap, teachers, familyOf, userById };
}

/** Children oldest first (then by name): how every list and shared meeting names them. */
function byAge(people, ids) {
  const rank = (id) => gradeRank(people.students.get(id)?.grade);
  return [...ids].sort((a, b) => rank(b) - rank(a) || String(people.students.get(a)?.name).localeCompare(String(people.students.get(b)?.name)));
}

/** Put each booking's children oldest first (after both are loaded). */
function orderBookings(state, people) {
  for (const b of state.bookings) b.student_ids = byAge(people, b.student_ids);
  return state;
}

/** The students in `studentId`'s family (siblings by a shared guardian), itself included. */
function familyStudents(people, studentIds) {
  const keys = new Set(studentIds.map((id) => people.familyOf.get(id)).filter(Boolean));
  return [...people.students.keys()].filter((id) => keys.has(people.familyOf.get(id)));
}

const lengthFor = (state, teacherId) => state.settings.get(teacherId)?.slot_minutes || state.event.slot_minutes;

const takingPart = (state, people, teacherId) =>
  people.teachers.has(teacherId) && state.settings.get(teacherId)?.taking_part !== false;

function planFor(state, teacherId, day) {
  return teacherDayPlan({
    day,
    own: state.teacherDays.get(`${day.day_id}:${teacherId}`),
    length: lengthFor(state, teacherId),
    breaks: state.breaks.filter((b) => b.day_id === day.day_id),
    teacherId,
  });
}

/** A teacher's open times on a day: their times minus closed and booked ones. */
function openTimes(state, teacherId, day, { exceptBookingId = null } = {}) {
  const booked = state.bookings.filter((b) => b.teacher_id === teacherId && b.day_id === day.day_id && b.booking_id !== exceptBookingId);
  return planFor(state, teacherId, day).slots
    .filter((s) => !s.closed && !booked.some((b) => overlaps({ start: b.start_min, end: b.end_min }, s)));
}

/** Where a meeting is: the teacher's fixed room, else the oldest child's grade room. */
function roomFor(state, people, teacherId, studentIds) {
  const own = state.settings.get(teacherId)?.room;
  if (own) return own;
  if (!state.event.use_grade_room) return null;
  const grades = studentIds.map((id) => people.students.get(id)?.grade).filter(Boolean);
  if (!grades.length) return null;
  const oldest = grades.sort((a, b) => gradeRank(b) - gradeRank(a))[0];
  return `${gradeLabel(oldest)} room`;
}

const isPhone = (b) => b.mode === 'phone';

/** Where a booking happens, in one line: "Grade 5 room", or "Phone call · 416-555-0100". */
function placeFor(state, people, b) {
  return isPhone(b) ? `Phone call · ${b.phone}` : roomFor(state, people, b.teacher_id, b.student_ids);
}

/** Where a booking happens, as its family reads it: the room, or "Phone call to 416-555-0100". */
function familyPlaceFor(state, people, b) {
  return isPhone(b) ? `Phone call to ${b.phone}` : roomFor(state, people, b.teacher_id, b.student_ids);
}

/**
 * The number to suggest for a phone call. A parent: the number they gave
 * last, else their own on file, else the one the family gave last. The
 * office (userId null): the family's last, else any guardian's on file.
 */
function phoneFor(state, people, studentIds, userId = null) {
  const family = new Set(familyStudents(people, studentIds));
  const given = state.bookings
    .filter((b) => isPhone(b) && b.phone && b.student_ids.some((id) => family.has(id)))
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  const guardians = [...family].flatMap((id) => people.students.get(id)?.guardians || []);
  if (userId) {
    return given.find((b) => b.booked_by === userId)?.phone
      || guardians.find((g) => g.userId === userId && g.phone)?.phone
      || given[0]?.phone
      || null;
  }
  return given[0]?.phone || guardians.find((g) => g.phone)?.phone || null;
}

/** Bookings the current setup no longer has a time for (hours, breaks, length or days changed). */
function orphans(state) {
  const out = [];
  for (const day of state.days) {
    const byTeacher = new Map();
    for (const b of state.bookings.filter((x) => x.day_id === day.day_id)) {
      if (!byTeacher.has(b.teacher_id)) byTeacher.set(b.teacher_id, []);
      byTeacher.get(b.teacher_id).push(b);
    }
    for (const [teacherId, list] of byTeacher) {
      if (state.settings.get(teacherId)?.taking_part === false) {
        out.push(...list);
        continue;
      }
      out.push(...orphanedBookings(planFor(state, teacherId, day).slots, list));
    }
  }
  return out;
}

/** "Arabic · Gr 1–8" for the office's teacher list. */
function teachesLabel(people, teacher) {
  const grades = [...teacher.studentIds].map((id) => people.students.get(id)?.grade).filter(Boolean);
  const ranks = [...new Set(grades)].sort((a, b) => gradeRank(a) - gradeRank(b));
  const range = ranks.length === 0 ? '' : ranks.length === 1 ? gradeLabel(ranks[0])
    : `${gradeLabel(ranks[0]).replace('Grade ', 'Gr ')}–${gradeLabel(ranks[ranks.length - 1]).replace('Grade ', '')}`;
  const subjects = [...teacher.subjects];
  const what = teacher.homeroomIds.size && !subjects.length ? 'Homeroom'
    : subjects.slice(0, 2).join(', ') + (subjects.length > 2 ? ` +${subjects.length - 2}` : '');
  return [teacher.homeroomIds.size && subjects.length ? 'Homeroom' : null, what, range].filter(Boolean).join(' · ');
}

module.exports = {
  EMAIL_RE,
  gradeRank,
  gradeLabel,
  firstNameOf,
  lastNameOf,
  loadEvent,
  loadPeople,
  familyStudents,
  byAge,
  orderBookings,
  lengthFor,
  takingPart,
  planFor,
  openTimes,
  roomFor,
  isPhone,
  placeFor,
  familyPlaceFor,
  phoneFor,
  orphans,
  teachesLabel,
};
