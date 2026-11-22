// services/meetings/scheduler.js
//
// What happens by itself, from the notifier's 30-second tick
// (services/messageNotifier.js):
//
// - Opening: a scheduled event whose opens_at has passed opens. In the same
//   transaction, guardians on each student's file get guardian rows, those
//   with no account get an invite-pending one (the guardian invite flow), and
//   every guardian account is queued its invitation (ptm_invite). So every
//   family is invited at the same moment, first come, first served.
// - "Times are still open" (ptm_last_call) at last_call_at, to families
//   with no meetings; the office can also send it now (sendLastCall).
// - The reminder (ptm_reminder) at reminder_min the evening before each day,
//   to families with meetings that day.
// - Each teacher's list (ptm_teacher_list) at the cutoff the evening before.
//
// Each send is marked on the event/day row in the transaction that queues
// it, and each row's dedupe key queues it once, so a second server or a
// restart adds nothing.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/meetings.queries');
const mq = require('../../queries/messaging.queries');
const adminUserQueries = require('../../queries/adminUser.queries');
const outbox = require('../email/outbox');
const S = require('./state');
const T = require('./time');
const { withEvent } = require('./booking');
const { torontoParts, addDays } = require('../classroom/classroomDigest');

const KINDS = Object.freeze({
  invite: 'ptm_invite',
  lastCall: 'ptm_last_call',
  reminder: 'ptm_reminder',
  teacherList: 'ptm_teacher_list',
});
const MISSING = new Set(['42P01', '42703']);
let disabled = null;

/** Students who have at least one teacher taking part (the invitation's audience). */
const audience = (state, people) => [...people.students.values()]
  .filter((s) => [...s.teacherIds].some((t) => S.takingPart(state, people, t)));

/**
 * Guardians on file get rows and, with no account, an invite-pending one,
 * as a teacher's first message does (messaging.controller inviteUnlinkedGuardians).
 */
async function ensureGuardianAccounts(client, state, people) {
  const ids = audience(state, people).map((s) => s.id);
  for (const id of ids) {
    await client.query(mq.deleteStaleFileGuardians, [id]);
    await client.query(mq.insertGuardianRowsFromFile, [id]);
  }
  const fresh = await S.loadPeople(client, state.event);
  for (const id of ids) {
    for (const g of fresh.students.get(id)?.guardians || []) {
      if (g.hasAccount || !g.email) continue;
      // One guardian's problem (an address another school's account holds) never stops the opening.
      await client.query('SAVEPOINT ptm_guardian');
      try {
        const { rows: [existing] } = await client.query(mq.selectUserByEmailInSchool, [g.email, state.event.school]);
        if (existing) {
          if (!existing.is_archived && String(existing.role) !== 'STUDENT') {
            await client.query(mq.linkGuardianToUser, [g.linkId, existing.user_id, null, null, false, g.email]);
          }
        } else {
          const name = g.name || g.email.split('@')[0];
          const [firstName, ...rest] = name.split(/\s+/);
          const { rows: [created] } = await client.query(adminUserQueries.insertInvitedUser, [
            g.email, name, firstName, rest.join(' '), state.event.school, 'PARENT', null, null,
          ]);
          await client.query(mq.linkGuardianToUser, [g.linkId, created.user_id, null, null, true, g.email]);
        }
        await client.query('RELEASE SAVEPOINT ptm_guardian');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT ptm_guardian');
        logger.warn({ err: error.message, linkId: g.linkId }, 'Meetings invite: no account made for a guardian');
      }
    }
  }
  return S.loadPeople(client, state.event);
}

/** One row per guardian account of these students (each family's guardians). */
function guardianRows(state, people, studentIds, { kind, dedupeKey, payload = {}, priority = 5 }) {
  const seen = new Set();
  const rows = [];
  for (const id of studentIds) {
    for (const g of people.students.get(id)?.guardians || []) {
      if (!g.userId || !g.email || seen.has(g.userId)) continue;
      seen.add(g.userId);
      rows.push({
        kind,
        school: state.event.school,
        recipientEmail: g.email,
        recipientUserId: g.userId,
        subjectType: 'ptm_event',
        subjectId: state.event.event_id,
        studentId: id,
        dedupeKey,
        payload: { eventId: state.event.event_id, ...payload },
        priority,
      });
    }
  }
  return rows;
}

/** Open an event now (inside its transaction): status, accounts, invitations. */
async function openEvent(client, state, people, now = new Date()) {
  await client.query(
    "UPDATE ptm_events SET status = 'open', opened_at = $2, opens_at = COALESCE(opens_at, $2), updated_at = NOW() WHERE event_id = $1",
    [state.event.event_id, now],
  );
  state.event.status = 'open';
  if (!state.event.email_invite) return 0;
  const everyone = await ensureGuardianAccounts(client, state, people);
  const rows = guardianRows(state, everyone, audience(state, everyone).map((s) => s.id), {
    kind: KINDS.invite, dedupeKey: `invite:${state.event.event_id}`, priority: 4,
  });
  return outbox.enqueue(client, rows);
}

/** Families with no meetings in the event yet: their students. */
function unbookedStudents(state, people) {
  const booked = new Set(state.bookings.flatMap((b) => b.student_ids).map((id) => people.familyOf.get(id)));
  return audience(state, people).filter((s) => !booked.has(people.familyOf.get(s.id))).map((s) => s.id);
}

/** "Times are still open", now (the office's button) or on schedule. */
async function queueLastCall(client, state, people, stamp) {
  return outbox.enqueue(client, guardianRows(state, people, unbookedStudents(state, people), {
    kind: KINDS.lastCall, dedupeKey: `lastcall:${state.event.event_id}:${stamp}`,
  }));
}

async function sendLastCall({ school, eventId, now = new Date() }) {
  return withEvent(school, eventId, ({ client, state, people }) => queueLastCall(client, state, people, now.toISOString()));
}

/** What is due for an open event at `now`. */
function dueWork(event, days, now) {
  const firstStart = days.length ? T.torontoAt(days[0].day_date, days[0].start_min) : null;
  const anyBookable = days.some((d) => now < T.cutoffAt(event, d));
  return {
    lastCall: event.email_last_call && event.last_call_at && !event.last_call_sent_at
      && now >= new Date(event.last_call_at) && anyBookable && firstStart && now < firstStart,
    reminders: event.email_reminder ? days.filter((d) => !d.reminder_sent_at && now >= T.reminderAt(event, d)
      && now < T.torontoAt(d.day_date, d.start_min)) : [],
    teacherLists: event.email_teacher_list ? days.filter((d) => !d.teacher_list_sent_at && now >= T.teacherListAt(event, d)
      && now < T.torontoAt(d.day_date, d.end_min)) : [],
  };
}

async function runDue(event, days, now) {
  const due = dueWork(event, days, now);
  if (!due.lastCall && !due.reminders.length && !due.teacherLists.length) return 0;
  return withEvent(event.school, event.event_id, async ({ client, state, people }) => {
    let queued = 0;
    if (due.lastCall && (await client.query(q.markLastCallSent, [event.event_id, now])).rows.length) {
      queued += await queueLastCall(client, state, people, 'scheduled');
    }
    for (const day of due.reminders) {
      if (!(await client.query(q.markReminderSent, [day.day_id, now])).rows.length) continue;
      const ids = [...new Set(state.bookings.filter((b) => b.day_id === day.day_id).flatMap((b) => b.student_ids))];
      const family = S.familyStudents(people, ids);
      queued += await outbox.enqueue(client, guardianRows(state, people, family, {
        kind: KINDS.reminder, dedupeKey: `reminder:${day.day_id}`, payload: { dayId: day.day_id }, priority: 4,
      }));
    }
    for (const day of due.teacherLists) {
      if (!(await client.query(q.markTeacherListSent, [day.day_id, now])).rows.length) continue;
      const teacherIds = [...new Set(state.bookings.filter((b) => b.day_id === day.day_id).map((b) => b.teacher_id))];
      const rows = teacherIds.map((id) => people.teachers.get(id)).filter((t) => t && t.email).map((t) => ({
        kind: KINDS.teacherList,
        school: state.event.school,
        recipientEmail: t.email,
        recipientUserId: t.id,
        subjectType: 'ptm_event',
        subjectId: state.event.event_id,
        dedupeKey: `teacherlist:${day.day_id}`,
        payload: { eventId: state.event.event_id, dayId: day.day_id },
        priority: 4,
      }));
      queued += await outbox.enqueue(client, rows);
    }
    return queued;
  });
}

const standDown = (error) => {
  if (!MISSING.has(error?.code)) return false;
  if (!disabled) logger.warn({ err: error.message }, 'Parent–teacher meetings tables missing; the meetings sweep is off');
  disabled = error.code;
  return true;
};

/** One pass: open what's due, then queue what's due. @returns {Promise<{ opened, queued }>} */
async function runSchedule(now = new Date()) {
  const out = { opened: 0, queued: 0 };
  if (disabled) return out;
  try {
    const { rows: due } = await db.query(
      "SELECT event_id, school FROM ptm_events WHERE status = 'scheduled' AND opens_at <= $1 ORDER BY opens_at LIMIT 5",
      [now],
    );
    for (const e of due) {
      try {
        await withEvent(e.school, e.event_id, async ({ client, state, people }) => {
          if (state.event.status !== 'scheduled') return;
          out.queued += await openEvent(client, state, people, now);
          out.opened += 1;
        });
      } catch (error) {
        logger.error({ err: error, eventId: e.event_id }, 'Opening parent–teacher meetings failed');
      }
    }
    const today = addDays(torontoParts(now).date, -1);
    const { rows: events } = await db.query(q.selectSweepEvents, [today]);
    for (const event of events) {
      try {
        const { rows: days } = await db.query(q.selectDays, [event.event_id]);
        out.queued += await runDue(event, days, now);
      } catch (error) {
        logger.error({ err: error, eventId: event.event_id }, 'Parent–teacher meetings sweep failed');
      }
    }
  } catch (error) {
    if (standDown(error)) return out;
    logger.error({ err: error }, 'Parent–teacher meetings sweep failed');
  }
  return out;
}

function resetScheduleState() {
  disabled = null;
}

module.exports = { KINDS, runSchedule, resetScheduleState, openEvent, sendLastCall, dueWork, unbookedStudents, audience };
