// services/replyReminders.js
//
// Chasing unanswered conversations, once a school day from 7 am Toronto, in
// schools that turned it on (School Settings → Classroom & parent emails):
//
// - Reply reminders (school_classroom_settings.reply_reminders): a parent
//   wrote and nobody at school has replied at all. The teacher is reminded 2
//   school days after the parent's first message and again 2 school days
//   later; the school day after that, everyone with All messages access is
//   told (never the teachers in question). With no teacher to email, the
//   office is told at the first reminder's point. Any staff reply, or
//   Resolve, ends it.
// - Parent nudge (parent_nudge): a teacher wrote and nobody in the family has
//   replied at all. Each guardian is emailed once after 2 school days, for
//   teacher messages from the last 14 days.
//
// Turning reminders on chases every open, never-answered parent conversation
// of the current school year, however old: one already waiting gets its
// first reminder on the next school morning, then one step per school day
// as above. A reply is any real message from a TEACHER or ADMIN account
// (custom access roles keep those base roles).
//
// School days are the staff work days of the school calendar: Mon-Fri, no
// closures or stat holidays, PA days included (staffAttendance/assembly).
//
// The emails go through the outbox (services/email/outbox.js), and their rows
// are the record: subject_type 'conversation' (subject_id = the conversation),
// payload { step, day } with step 1 and 2 the teacher reminders and 3 the
// office (kind reply_escalation). Each step's dedupe key queues it once, so a
// second sweep or a second server adds nothing. Each email is built when it is sent and re-checks the
// conversation, so a reply or Resolve in between skips it. One person's
// conversations of the day go out as one email (the coalesce key).

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/replyReminder.queries');
const schoolQueries = require('../queries/school.queries');
const outbox = require('./email/outbox');
const { recipientEmails } = require('./access/recipients');
const { loadSchoolDays } = require('./staffAttendance/assembly');
const { torontoParts, addDays, dayLabel, gradeLabel } = require('./classroom/classroomDigest');
const { schoolSender } = require('./email/senderIdentity');
const { signEmailLoginToken, emailLoginUrl } = require('../utils/emailLoginLink');
const { getSchoolName } = require('../utils/schoolUtils');
const { teacherReminderEmail, officeEmail, parentNudgeEmail } = require('../templates/replyReminderEmails');

const KINDS = Object.freeze({ reminder: 'reply_reminder', escalation: 'reply_escalation', nudge: 'reply_nudge' });
const SUBJECT_TYPE = 'conversation';
const SEND_HOUR = 7;
const OFFICE_STEP = 3;
// School days to wait before each step: the first reminder 2 after the
// parent wrote, the second 2 after the first, the office 1 after that.
const GAPS = [2, 2, 1];
const NUDGE_AFTER = 2;
const NUDGE_MAX_AGE_DAYS = 14;
// How far back the school calendar is read; older threads are counted from its start.
const LOOKBACK_DAYS = 120;
// Staff emails go ahead of the parents' digests.
const PRIORITY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

const SKIP = Object.freeze({
  ANSWERED: 'Answered, resolved or no longer theirs before it was sent',
  OFF: 'Turned off in the school settings',
  NOT_OFFICE: 'No longer has All messages access',
  NO_TEACHER_OR_OFFICE: 'Nobody to email: no teacher or office address',
  NO_GUARDIAN: 'No guardian to email',
});

// Postgres: a table or column the migration adds is missing.
const MISSING = new Set(['42P01', '42703']);

let lastRun = {};
let disabled = null;

const base = () => process.env.FRONTEND_URL || '';
const staffPath = (id) => `/messages?thread=${id}`;
const staffLink = (id) => `${base()}${staffPath(id)}`;
const unique = (values) => [...new Set(values)];

/** School days after `from` up to and including `today` ('YYYY-MM-DD' strings). */
const schoolDaysSince = (from, today, days) => days.filter((d) => d > from && d <= today).length;

/**
 * The step a waiting conversation is due for today, or null: `step` is the
 * last one queued (0 = none) on `lastDay`. One step per school day, never on
 * a day the school is closed.
 */
function dueStep({ step, lastDay, startDay, today, days }) {
  if (step >= OFFICE_STEP || !days.includes(today)) return null;
  if (lastDay && lastDay >= today) return null;
  const from = step === 0 ? startDay : (lastDay ?? startDay);
  return schoolDaysSince(from, today, days) >= GAPS[step] ? step + 1 : null;
}

/** Whether the parents' nudge is due today. */
const nudgeDue = ({ startDay, today, days }) => days.includes(today) && schoolDaysSince(startDay, today, days) >= NUDGE_AFTER;

function standDown(error) {
  if (!MISSING.has(error?.code)) return false;
  disabled = 'reply_reminders_01.sql has not been applied';
  logger.error('Reply reminders disabled: apply reply_reminders_01.sql and restart.');
  return true;
}

/** The teacher reminders and office emails a school owes today. */
async function staffRows(school, today, days) {
  const { rows: waiting } = await db.query(q.selectWaitingOnStaff, [school]);
  const due = waiting
    .map((t) => ({ ...t, next: dueStep({ step: t.step, lastDay: t.last_day, startDay: t.start_day, today, days }) }))
    .filter((t) => t.next);
  if (!due.length) return [];
  const { rows: staff } = await db.query(q.selectResponsibleStaff, [due.map((t) => t.conversation_id)]);
  let office = null;
  const rows = [];
  for (const t of due) {
    const theirs = staff.filter((p) => p.conversation_id === t.conversation_id);
    const reachable = theirs.filter((p) => p.reachable);
    // Nobody to remind: the office hears at once.
    const step = reachable.length ? t.next : OFFICE_STEP;
    const row = {
      school, subjectType: SUBJECT_TYPE, subjectId: t.conversation_id, classId: t.class_id, studentId: t.student_id,
      priority: PRIORITY, payload: { step, day: today },
    };
    if (step < OFFICE_STEP) {
      const seen = new Set();
      for (const p of reachable) {
        if (seen.has(p.email)) continue;
        seen.add(p.email);
        rows.push({
          ...row, kind: KINDS.reminder, recipientEmail: p.email, recipientUserId: p.user_id,
          dedupeKey: `${t.conversation_id}:r${step}`, coalesceKey: `${KINDS.reminder}:${today}`,
        });
      }
      continue;
    }
    office ??= await recipientEmails(school, 'messages.all');
    const mine = new Set(theirs.map((p) => p.email).filter(Boolean));
    const to = office.filter((email) => !mine.has(email));
    const payload = { ...row.payload, unreachable: reachable.length === 0 };
    if (to.length === 0) {
      // Recorded all the same, so the conversation isn't picked up again tomorrow.
      rows.push({
        ...row, payload, kind: KINDS.escalation, recipientEmail: null, status: 'skipped',
        skipReason: SKIP.NO_TEACHER_OR_OFFICE, dedupeKey: `${t.conversation_id}:office`,
      });
    }
    for (const email of to) {
      rows.push({
        ...row, payload, kind: KINDS.escalation, recipientEmail: email,
        dedupeKey: `${t.conversation_id}:office`, coalesceKey: `${KINDS.escalation}:${today}`,
      });
    }
  }
  return rows;
}

/** The parents' nudges a school owes today. */
async function nudgeRows(school, today, days, now) {
  const notBefore = new Date(new Date(now).getTime() - NUDGE_MAX_AGE_DAYS * DAY_MS).toISOString();
  const { rows: waiting } = await db.query(q.selectWaitingOnFamily, [school, notBefore]);
  const due = waiting.filter((t) => nudgeDue({ startDay: t.start_day, today, days }));
  if (!due.length) return [];
  const { rows: guardians } = await db.query(q.selectGuardians, [due.map((t) => t.conversation_id)]);
  const rows = [];
  for (const t of due) {
    const row = {
      school, kind: KINDS.nudge, subjectType: SUBJECT_TYPE, subjectId: t.conversation_id, classId: t.class_id,
      studentId: t.student_id, payload: { day: today }, dedupeKey: `${t.conversation_id}:nudge`,
    };
    const theirs = guardians.filter((g) => g.conversation_id === t.conversation_id);
    if (theirs.length === 0) {
      rows.push({ ...row, recipientEmail: null, status: 'skipped', skipReason: SKIP.NO_GUARDIAN });
      continue;
    }
    for (const g of theirs) {
      rows.push({ ...row, recipientEmail: g.email, recipientUserId: g.user_id, coalesceKey: `${KINDS.nudge}:${today}` });
    }
  }
  return rows;
}

/**
 * The daily sweep: from 7 am Toronto on a school day, queue what each school
 * owes. Each school once per day per process; a school whose sweep failed is
 * tried again on the next tick (its queued steps are never queued twice).
 * @returns {Promise<{ reminders: number, office: number, nudges: number }>} rows queued
 */
async function runSchedule(now = new Date()) {
  const out = { reminders: 0, office: 0, nudges: 0 };
  if (disabled) return out;
  const { date: today, hour } = torontoParts(now);
  if (hour < SEND_HOUR) return out;
  let schools;
  try {
    ({ rows: schools } = await db.query(q.selectEnabledSchools));
  } catch (error) {
    if (standDown(error)) return out;
    throw error;
  }
  for (const s of schools) {
    if (lastRun[s.school] === today) continue;
    try {
      const { openDays } = await loadSchoolDays(addDays(today, -LOOKBACK_DAYS), today, s.school);
      const days = openDays.map((d) => d.day);
      const rows = [];
      if (days.includes(today)) {
        if (s.reply_reminders) rows.push(...await staffRows(s.school, today, days));
        if (s.parent_nudge) rows.push(...await nudgeRows(s.school, today, days, now));
        await outbox.enqueue(db, rows);
      }
      lastRun[s.school] = today;
      for (const r of rows) {
        if (r.status === 'skipped') continue;
        if (r.kind === KINDS.reminder) out.reminders += 1;
        else if (r.kind === KINDS.escalation) out.office += 1;
        else out.nudges += 1;
      }
    } catch (error) {
      if (standDown(error)) return out;
      logger.error({ err: error, school: s.school }, 'Reply reminder sweep failed');
    }
  }
  return out;
}

/** Clears the per-day memory and the stand-down (worker start, tests). */
function resetScheduleState() {
  lastRun = {};
  disabled = null;
}

// ─── Building the emails (at send time) ────────────────────────────────────

const sentAtLabel = (at) => new Date(at).toLocaleString('en-CA', {
  timeZone: 'America/Toronto', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const isFamily = (role) => role === 'PARENT' || role === 'STUDENT';

/** "Rania Khalil (Mother)", "Amina Khalil (student)", or a staff name with its title. */
function senderLabel(m) {
  const name = m.sender_name || 'Someone';
  if (m.sender_role === 'PARENT') return m.relation ? `${name} (${m.relation})` : name;
  if (m.sender_role === 'STUDENT') return `${name} (student)`;
  return name;
}

const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Conversations (with their messages) as they are now, by id. */
async function loadThreads(ids) {
  const [{ rows: threads }, { rows: messages }] = await Promise.all([
    db.query(q.selectThreads, [ids]),
    db.query(q.selectMessages, [ids]),
  ]);
  return new Map(threads.map((t) => [t.conversation_id, { ...t, messages: messages.filter((m) => m.conversation_id === t.conversation_id) }]));
}

async function schoolContext(school) {
  let schoolInfo = null;
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    schoolInfo = rows[0] || null;
  } catch (error) {
    logger.warn({ err: error.message, school }, 'School lookup failed for a reply reminder');
  }
  return { schoolInfo, schoolName: getSchoolName(school) };
}

/** Why nothing was left to send: the school turned the switch off, or the conversations moved on. */
const skipReason = (threads, switchKey) =>
  (threads.size > 0 && [...threads.values()].every((t) => !t[switchKey]) ? SKIP.OFF : SKIP.ANSWERED);

const waitingOnStaff = (t) => t.status === 'open' && t.has_parent_message && !t.has_staff_reply;
const waitingOnFamily = (t) => t.status === 'open' && t.has_staff_reply && !t.has_family_reply;

/** A conversation for the templates. `from` picks whose messages it is about. */
function threadView(t, from) {
  const theirs = t.messages.filter((m) => (from === 'family' ? m.sender_role === 'PARENT' : !isFamily(m.sender_role)));
  return {
    kind: t.kind,
    title: t.title,
    studentName: t.student_name,
    studentGrade: t.student_grade ? gradeLabel(t.student_grade) : null,
    classSubject: t.class_subject,
    fromLabel: joinNames(unique(theirs.map(senderLabel))),
    parentName: theirs[0]?.sender_name || null,
    wroteLabel: theirs[0] ? dayLabel(theirs[0].created_at) : '',
    messages: t.messages.map((m) => ({
      senderLabel: senderLabel(m), sentAtLabel: sentAtLabel(m.created_at), body: m.body, fileNames: m.file_names || [],
    })),
  };
}

const message = (job, schoolInfo, email) => ({
  ...schoolSender({ school: job.school, schoolInfo, role: 'messages' }),
  to: [job.recipient_email],
  subject: email.subject,
  html: email.html,
});

/** To a teacher: their conversations still waiting, reminder 1 or 2 each. */
const replyReminderHandler = {
  async build(job, siblings = []) {
    const jobs = [job, ...siblings];
    const ids = unique(jobs.map((j) => j.subject_id));
    const [threads, { rows: staff }] = await Promise.all([loadThreads(ids), db.query(q.selectResponsibleStaff, [ids])]);
    const live = jobs.filter((j) => {
      const t = threads.get(j.subject_id);
      return t && t.reminders_on && waitingOnStaff(t)
        && staff.some((p) => p.conversation_id === j.subject_id && p.user_id === j.recipient_user_id && p.reachable);
    });
    if (!live.length) return { skip: skipReason(threads, 'reminders_on') };
    const { schoolInfo, schoolName } = await schoolContext(job.school);
    const email = teacherReminderEmail({
      firstName: staff.find((p) => p.user_id === job.recipient_user_id)?.first_name,
      threads: live.map((j) => ({
        ...threadView(threads.get(j.subject_id), 'family'), step: Number(j.payload?.step) || 1, link: staffLink(j.subject_id),
      })),
      link: `${base()}/messages?view=needsReply`,
      schoolName,
      schoolInfo,
    });
    const one = live.length === 1 ? threadView(threads.get(live[0].subject_id), 'family') : null;
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject, conversations: live.map((j) => ({ id: j.subject_id, step: j.payload?.step ?? null })) },
      push: {
        category: 'reminders',
        title: one ? `${one.fromLabel || 'A parent'} is waiting for your reply` : `${live.length} parents are waiting for your reply`,
        body: one ? [one.studentName, one.title].filter(Boolean).join(' · ') : 'Tap to see the conversations that need a reply.',
        path: one ? staffPath(live[0].subject_id) : '/messages?view=needsReply',
      },
    };
  },
};

/** To one office address: the parent messages nobody answered. */
const replyEscalationHandler = {
  async build(job, siblings = []) {
    const office = await recipientEmails(job.school, 'messages.all');
    if (!office.includes(job.recipient_email)) return { skip: SKIP.NOT_OFFICE };
    const jobs = [job, ...siblings];
    const ids = unique(jobs.map((j) => j.subject_id));
    const [threads, { rows: staff }, { rows: sent }] = await Promise.all([
      loadThreads(ids),
      db.query(q.selectResponsibleStaff, [ids]),
      db.query(q.selectRemindersSent, [ids]),
    ]);
    const live = jobs.filter((j) => {
      const t = threads.get(j.subject_id);
      return t && t.reminders_on && waitingOnStaff(t)
        && !staff.some((p) => p.conversation_id === j.subject_id && p.email === job.recipient_email);
    });
    if (!live.length) return { skip: skipReason(threads, 'reminders_on') };
    const { schoolInfo, schoolName } = await schoolContext(job.school);
    const email = officeEmail({
      threads: live.map((j) => {
        const names = unique(staff.filter((p) => p.conversation_id === j.subject_id).map((p) => p.name).filter(Boolean));
        const reminded = sent.filter((r) => r.conversation_id === j.subject_id);
        return {
          ...threadView(threads.get(j.subject_id), 'family'),
          teacherNames: joinNames(names),
          teacherCount: names.length,
          reminders: reminded.length,
          remindedLabel: reminded.length ? joinNames(reminded.map((r) => dayLabel(r.sent_at))) : null,
          unreachable: Boolean(j.payload?.unreachable),
          link: staffLink(j.subject_id),
        };
      }),
      link: `${base()}/admin-panel/messages?status=waiting`,
      schoolName,
      schoolInfo,
    });
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject, conversations: live.map((j) => j.subject_id) },
      // An office address: pushEvents finds its account by address.
      push: {
        category: 'reminders',
        title: live.length === 1 ? 'A parent message has no reply' : `${live.length} parent messages have no reply`,
        body: 'Tap to see who is waiting in All Messages.',
        path: '/admin-panel/messages?status=waiting',
      },
    };
  },
};

/** To a guardian, once: a teacher's message nobody in the family answered. */
const replyNudgeHandler = {
  async build(job, siblings = []) {
    const jobs = [job, ...siblings];
    const ids = unique(jobs.map((j) => j.subject_id));
    const [threads, { rows: guardians }] = await Promise.all([loadThreads(ids), db.query(q.selectGuardians, [ids])]);
    const live = jobs.filter((j) => {
      const t = threads.get(j.subject_id);
      return t && t.nudge_on && waitingOnFamily(t)
        && guardians.some((g) => g.conversation_id === j.subject_id && g.user_id === j.recipient_user_id && g.email === job.recipient_email);
    });
    if (!live.length) return { skip: skipReason(threads, 'nudge_on') };
    const [first] = live;
    const token = signEmailLoginToken({
      userId: job.recipient_user_id, studentId: threads.get(first.subject_id).student_id, email: job.recipient_email,
    });
    const next = live.length === 1 ? `/parent/messages?thread=${first.subject_id}` : '/parent/messages';
    const { schoolInfo, schoolName } = await schoolContext(job.school);
    const email = parentNudgeEmail({
      firstName: guardians.find((g) => g.user_id === job.recipient_user_id)?.first_name,
      threads: live.map((j) => threadView(threads.get(j.subject_id), 'staff')),
      link: emailLoginUrl({ token, next }),
      schoolName,
      schoolInfo,
    });
    const teacher = threadView(threads.get(first.subject_id), 'staff');
    return {
      message: message(job, schoolInfo, email),
      sentContent: { subject: email.subject, conversations: live.map((j) => j.subject_id) },
      // The app is signed in already: the screen itself, never the email's one-tap link.
      push: {
        category: 'reminders',
        title: live.length === 1 ? `${teacher.fromLabel || 'A teacher'} is waiting to hear from you` : 'Your school is waiting to hear from you',
        body: live.length === 1 ? [teacher.studentName, teacher.title].filter(Boolean).join(' · ') : `${live.length} messages are waiting for your reply.`,
        path: next,
      },
    };
  },
};

/** The All Messages badges for these conversations: Map id → { reminders, officeToldAt, nudgedAt }. */
async function badgesFor(conversationIds) {
  if (!conversationIds.length) return new Map();
  const { rows } = await db.query(q.selectBadges, [conversationIds]);
  return new Map(rows
    .filter((r) => r.reminders > 0 || r.office_told_at || r.nudged_at)
    .map((r) => [r.conversation_id, {
      reminders: r.reminders,
      officeToldAt: r.office_told_at ? new Date(r.office_told_at).toISOString() : null,
      nudgedAt: r.nudged_at ? new Date(r.nudged_at).toISOString() : null,
    }]));
}

module.exports = {
  KINDS,
  SKIP,
  schoolDaysSince,
  dueStep,
  nudgeDue,
  runSchedule,
  resetScheduleState,
  badgesFor,
  replyReminderHandler,
  replyEscalationHandler,
  replyNudgeHandler,
};
