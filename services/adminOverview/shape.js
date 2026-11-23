// services/adminOverview/shape.js
//
// Pure shapers for the admin overview (blocks.js): database rows in, the
// response's facts out (numbers, ids, names, ISO instants, YYYY-MM-DD dates;
// never sentences, the web's lib/adminOverview.ts writes those). No database,
// no clock of their own: `today` and `now` come in, so tests fix them.

const { phaseOf } = require('../meetings/time');

const TZ = 'America/Toronto';

/** 'YYYY-MM-DD' of `now` in Toronto, the schools' calendar day. */
const torontoDate = (now = new Date()) => now.toLocaleDateString('en-CA', { timeZone: TZ });

const iso = (value) => (value ? new Date(value).toISOString() : null);
const int = (value) => Number(value) || 0;

const shapeApprovals = (counts, requests) => ({
  pendingSignups: int(counts?.pending_signups),
  unverifiedSignups: int(counts?.unverified_signups),
  pendingStudentRequests: int(requests?.n),
});

const shapeUsers = (row) => ({
  admins: int(row?.admins),
  teachers: int(row?.teachers),
  parents: int(row?.parents),
  invitedNotSignedIn: int(row?.invited_not_signed_in),
});

/**
 * Student accounts as the page's chips count them (the web's countByStatus):
 * `accounts` are services/classroom/studentAccounts toStudentAccountRow rows,
 * one per non-archived student of the year. Archived and not-eligible logins
 * are in `students` but none of the three status counts.
 */
const countStudentAccounts = (accounts) => {
  const counts = { students: accounts.length, notInvited: 0, invited: 0, active: 0, needsAttention: 0 };
  for (const a of accounts) {
    if (a.status === 'not_invited') counts.notInvited += 1;
    else if (a.status === 'invited') counts.invited += 1;
    else if (a.status === 'active') counts.active += 1;
    if (a.needsAttention) counts.needsAttention += 1;
  }
  return counts;
};

const shapeRelations = (row) => ({ students: int(row?.students), withoutGuardian: int(row?.without_guardian) });

const shapeMessages = (row) => ({
  awaitingReply: int(row?.awaiting_reply),
  waitingOverTwoDays: int(row?.waiting_over_two_days),
  failedEmailConversations: int(row?.failed_email_conversations),
});

/**
 * The term covering `today` (the latest-starting one, should two overlap),
 * and, only between terms, the next one to start. rows: yearTerms rows with
 * text dates, so YYYY-MM-DD strings compare as dates.
 */
const pickTerms = (rows, today) => {
  const covering = rows.filter((t) => t.start_date <= today && today <= t.end_date);
  const current = covering.reduce((best, t) => (!best || t.start_date > best.start_date ? t : best), null);
  if (current) {
    return {
      currentTerm: { termId: current.term_id, name: current.name, startDate: current.start_date, endDate: current.end_date },
      nextTerm: null,
    };
  }
  const next = rows
    .filter((t) => t.start_date > today)
    .reduce((best, t) => (!best || t.start_date < best.start_date ? t : best), null);
  return { currentTerm: null, nextTerm: next ? { termId: next.term_id, name: next.name, startDate: next.start_date } : null };
};

const shapeClosure = (row) => ({
  nextClosure: row ? { eventId: row.event_id, title: row.title, startDate: row.start_date, endDate: row.end_date } : null,
});

const shapeAssets = (row) => ({ logo: Boolean(row?.logo), signature: Boolean(row?.signature), stamp: Boolean(row?.stamp) });

const shapeTemplates = (row) => ({ total: int(row?.total), withUnpublishedChanges: int(row?.with_unpublished_changes) });

const shapeReportRuns = (row) => ({ running: int(row?.running), failedItems: int(row?.failed_items) });

/**
 * newSubmissions: the Forms badge's own count (countNewSubmissionsBySchool).
 * forms: formSummaries rows. The top form has the most new submissions (ties:
 * the newest form, the rows' order); null when none has any.
 */
const shapeForms = (newSubmissions, forms) => {
  const withNew = forms.filter((f) => int(f.new_submissions) > 0);
  const top = withNew.reduce((best, f) => (!best || int(f.new_submissions) > int(best.new_submissions) ? f : best), null);
  return {
    newSubmissions: int(newSubmissions),
    formsWithNew: withNew.length,
    topForm: top ? { slug: top.slug, name: top.title, newSubmissions: int(top.new_submissions) } : null,
    openForms: forms.filter((f) => f.status === 'published').length,
    total: forms.length,
  };
};

const time = (value) => (value ? new Date(value).getTime() : 0);

/**
 * The live timetable (the latest published, should a null year show several),
 * the draft that goes live soonest, and the go-lives that failed. rows:
 * plannerSchedules rows.
 */
const shapePlanner = (rows) => {
  const live = rows
    .filter((s) => s.status === 'published')
    .reduce((best, s) => (!best || time(s.published_at) > time(best.published_at) ? s : best), null);
  const next = rows
    .filter((s) => s.status === 'draft' && (s.go_live_status === 'pending' || s.go_live_status === 'running') && s.go_live_on)
    .reduce((best, s) => (!best || s.go_live_on < best.go_live_on ? s : best), null);
  return {
    live: live ? { scheduleId: live.schedule_id, name: live.name, effectiveFrom: live.effective_from ?? null } : null,
    nextDraft: next ? { scheduleId: next.schedule_id, name: next.name, goLiveOn: next.go_live_on } : null,
    goLiveFailures: rows
      .filter((s) => s.go_live_status === 'failed')
      .map((s) => ({ scheduleId: s.schedule_id, name: s.name })),
  };
};

const shapeAgenda = (row) => ({
  latest: row ? { agendaId: row.agenda_id, title: row.title, academicYear: row.academic_year, status: row.status } : null,
});

/**
 * The meetings event the office cares about now: the first one not finished
 * (by its first day; one with no days yet after those with days), else the
 * one that finished last, else null. events: meetingEvents rows, each with
 * its `days` sorted by date. `now` fixes the phase (phaseOf).
 */
const pickMeeting = (events, now) => {
  const all = events.map((e) => {
    const days = Array.isArray(e.days) ? e.days : [];
    return {
      e,
      days,
      phase: phaseOf(e, days, now),
      firstDay: days.length ? days[0].day_date : null,
      lastDay: days.length ? days[days.length - 1].day_date : null,
    };
  });
  // Earliest first day first; no days yet last; then the older event.
  const soonest = (a, b) => {
    if (a.firstDay !== b.firstDay) {
      if (a.firstDay === null) return 1;
      if (b.firstDay === null) return -1;
      return a.firstDay < b.firstDay ? -1 : 1;
    }
    return time(a.e.created_at) - time(b.e.created_at);
  };
  // A finished event always has days: the latest last day first.
  const latestEnded = (a, b) => (a.lastDay === b.lastDay
    ? time(b.e.created_at) - time(a.e.created_at)
    : (a.lastDay < b.lastDay ? 1 : -1));
  const pick = all.filter((x) => x.phase !== 'finished').sort(soonest)[0]
    ?? all.filter((x) => x.phase === 'finished').sort(latestEnded)[0]
    ?? null;
  if (!pick) return { event: null };
  return {
    event: {
      eventId: pick.e.event_id,
      title: pick.e.title,
      phase: pick.phase,
      opensAt: iso(pick.e.opens_at),
      lastCallAt: iso(pick.e.last_call_at),
      firstDay: pick.firstDay,
      lastDay: pick.lastDay,
      bookings: int(pick.e.bookings),
      studentsBooked: int(pick.e.students_booked),
    },
  };
};

/**
 * QuickBooks as the tuition page reads it (controllers/finance.controller.js
 * toConnection and getSyncStatus's pendingSync): connected unless
 * disconnected; syncing while the latest job is pending or running (the
 * controller's currentJob only hides an old failed job, which never counts as
 * syncing anyway). No connection row: not connected, nothing else.
 */
const shapeFinance = (conn, job) => {
  if (!conn) {
    return { connected: false, needsReconnect: false, syncing: false, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 };
  }
  return {
    connected: conn.status !== 'disconnected',
    needsReconnect: conn.status === 'needs_reconnect',
    syncing: Boolean(job && job.state !== 'failed'),
    lastSuccessAt: iso(conn.last_success_at),
    lastError: conn.last_error ?? null,
    consecutiveFailures: int(conn.consecutive_failures),
  };
};

const shapeRoles = (row) => ({ customRoles: int(row?.n) });

const shapePatchNotes = (row) => ({ lastPublishedAt: iso(row?.last_published_at), scheduled: int(row?.scheduled) });

module.exports = {
  torontoDate,
  shapeApprovals,
  shapeUsers,
  countStudentAccounts,
  shapeRelations,
  shapeMessages,
  pickTerms,
  shapeClosure,
  shapeAssets,
  shapeTemplates,
  shapeReportRuns,
  shapeForms,
  shapePlanner,
  shapeAgenda,
  pickMeeting,
  shapeFinance,
  shapeRoles,
  shapePatchNotes,
};
