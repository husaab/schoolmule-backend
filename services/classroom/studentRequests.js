// services/classroom/studentRequests.js
//
// A student asks for an account from the public signup page; the school's
// admins approve it on the Approvals page by matching it to the student's
// existing record. Approving IS the normal student invite (inviteStudent),
// with the request marked approved and the address written onto the record
// in the same transaction — so a refused invite leaves nothing behind, and
// two admins approving at once make one login. A request never creates a
// student or a login on its own.
//
// What a student typed is untrusted: the address is only ever used once an
// admin confirms it, and the public answer is the same "request sent"
// whether or not anything was stored (an address that already has an
// account, an earlier declined request), so the form tells nobody who has
// an account.

const db = require('../../config/database');
const { recipientEmails } = require('../access/recipients');
const logger = require('../../logger');
const q = require('../../queries/studentRequest.queries');
const accountQueries = require('../../queries/studentAccount.queries');
const inviteQueries = require('../../queries/studentInvite.queries');
const schoolYearQueries = require('../../queries/schoolYear.queries');
const { getSettings, MAX_NOTICE_VERSION } = require('./classroomSettings');
const { checkStudentEmails, isOutsideDomain } = require('./emailProblems');
const { EMAIL_RE, normalizeEmail, isBelowLoginGrade, gradeLabel, inviteStudent } = require('./studentAccounts');
const { buildRosterIndex, suggestStudents } = require('./studentSuggestions');
const {
  MAX_PENDING_PER_SCHOOL, StudentRequestError, isHoneypot, cleanSubmission, toRequest, refusalFor,
} = require('./studentRequestRules');
const { getResend, sendSafely } = require('../../utils/emailUtils');
const { platformSender } = require('../email/senderIdentity');
const { getStudentRequestNotifyEmailHTML } = require('../../templates/emailTemplate');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUGGESTION_LIMIT = 5;

const refuse = (status, message, code = null, data = null) => new StudentRequestError(status, message, code, data);
const loginGradeMessage = (settings) => `Student accounts start at ${gradeLabel(settings.loginFromGrade)}.`;

// ---------------------------------------------------------------------------
// Public: a student's request

/**
 * Take a request from the signup page.
 * @returns {Promise<{ outcome: 'created'|'refreshed'|'silent', school?: string }>}
 *   'silent' stored nothing; the caller answers every outcome the same way.
 * @throws {StudentRequestError} for what the student can fix (400/404) or a full queue (429)
 */
async function submitRequest(body) {
  if (isHoneypot(body)) return { outcome: 'silent' };
  const { value, error } = cleanSubmission(body);
  if (error) throw refuse(400, error, 'INVALID_REQUEST');
  const { school, firstName, lastName, grade, email } = value;

  const { rows: [found] } = await db.query(q.selectSchool, [school]);
  if (!found) throw refuse(404, "We couldn't find that school.", 'UNKNOWN_SCHOOL');

  const settings = await getSettings(school);
  const domains = settings.studentEmailDomains;
  if (isOutsideDomain(email, domains)) {
    throw refuse(400, `Use your school email address (…@${domains[0]}).`, 'EMAIL_DOMAIN');
  }
  if (isBelowLoginGrade(grade, settings)) {
    throw refuse(400, `${loginGradeMessage(settings)} Your teacher can help you sign in.`, 'BELOW_LOGIN_GRADE');
  }

  // Nothing to store, said the same way as a stored request.
  const { rows: taken } = await db.query(q.selectUserByEmail, [email]);
  if (taken.length > 0) return { outcome: 'silent' };
  const { rows: declined } = await db.query(q.selectDeclinedForAddress, [school, email]);
  if (declined.length > 0) return { outcome: 'silent' };

  const { rows: [pending] } = await db.query(q.countPending, [school]);
  if (pending.n >= MAX_PENDING_PER_SCHOOL) {
    throw refuse(429, 'Your school has too many requests waiting. Try again in a few days.', 'TOO_MANY_REQUESTS');
  }

  const { rows: [saved] } = await db.query(q.upsertPending, [school, firstName, lastName, grade, email]);
  return { outcome: saved.inserted ? 'created' : 'refreshed', school };
}

/**
 * Email the school's admins that requests are waiting: at most once an hour
 * per school (claimed in one statement, so two requests at once send one
 * email). Names and addresses stay out of it. Never throws.
 */
async function notifyAdminsOfRequest(school) {
  try {
    const { rows: [claimed] } = await db.query(q.claimNotice, [school]);
    if (!claimed) return;
    // Everyone who manages student accounts (RBAC `users`, D12/D13).
    const to = await recipientEmails(school, 'users');
    if (to.length === 0) return;
    const { rows: [pending] } = await db.query(q.countPending, [school]);
    await sendSafely(getResend(), {
      ...platformSender('notification'),
      to,
      subject: `Student account requests at ${claimed.name}`,
      html: getStudentRequestNotifyEmailHTML({ schoolName: claimed.name, pendingCount: pending.n }),
    }, 'Student request notification failed to send', { school });
  } catch (err) {
    logger.error({ err, school }, 'Student request notification failed');
  }
}

// ---------------------------------------------------------------------------
// Admin: the queue

async function activeYearId(school) {
  const { rows: [year] } = await db.query(schoolYearQueries.selectActiveYearBySchool, [school]);
  return year?.school_year_id ?? null;
}

async function loadRoster(school) {
  const { rows } = await db.query(q.selectActiveRosterWithLogins, [school]);
  return rows;
}

const suggestionOf = ({ student, kind }) => ({
  studentId: student.student_id, name: student.name, grade: student.grade, kind, hasLogin: student.has_login,
});

/** Pending and declined requests, newest first; pending ones carry the likeliest student. */
async function listRequests({ school }) {
  const [{ rows }, roster] = await Promise.all([db.query(q.listForSchool, [school]), loadRoster(school)]);
  const index = buildRosterIndex(roster);
  return rows.map((row) => {
    const request = toRequest(row);
    const [top] = row.status === 'pending' ? suggestStudents(index, { name: request.name, grade: row.grade }, 1) : [];
    return { ...request, suggestion: top ? suggestionOf(top) : null };
  });
}

async function pendingRequest(school, requestId) {
  if (!UUID_RE.test(String(requestId))) throw refuse(404, 'Request not found');
  const { rows: [row] } = await db.query(q.selectOne, [school, requestId]);
  if (!row) throw refuse(404, 'Request not found');
  if (row.status !== 'pending') {
    throw refuse(409, `This request was already ${row.status}.`, 'REQUEST_NOT_PENDING', { state: row.status });
  }
  return row;
}

/** An address's problems for each student, as Edit email and the import word them, plus the request's own two. */
async function problemsFor({ school, settings, students, email }) {
  const checked = await checkStudentEmails({
    school, domains: settings.studentEmailDomains, items: students.map((s) => ({ studentId: s.student_id, email })), forImport: true,
  });
  return students.map((s, i) => {
    const problems = [...(checked.get(i)?.problems || [])];
    if (isBelowLoginGrade(s.grade, settings)) {
      problems.unshift({ code: 'below_login_grade', blocking: true, message: loginGradeMessage(settings) });
    }
    return problems;
  });
}

/**
 * The review: the students the request may be for (best first), the one the
 * admin picked from the full list, each with the address's problems, and the
 * roster to search. `email` is the address as the admin has it now (the
 * request's by default).
 */
async function requestCandidates({ school, requestId, email: edited, studentId }) {
  const row = await pendingRequest(school, requestId);
  const request = toRequest(row);
  const [settings, roster] = await Promise.all([getSettings(school), loadRoster(school)]);
  const email = normalizeEmail(edited ?? request.email) || '';

  const suggested = suggestStudents(buildRosterIndex(roster), { name: request.name, grade: row.grade }, SUGGESTION_LIMIT);
  const picked = studentId && !suggested.some((s) => s.student.student_id === studentId)
    ? roster.find((s) => s.student_id === studentId)
    : null;
  const list = [...suggested, ...(picked ? [{ student: picked, kind: 'picked' }] : [])];
  const problems = await problemsFor({ school, settings, students: list.map((c) => c.student), email });

  return {
    request,
    email,
    noticeVersion: settings.consentNoticeVersion,
    candidates: list.map((c, i) => ({
      ...suggestionOf(c), currentEmail: c.student.student_email ?? null, problems: problems[i],
    })),
    students: roster.map((s) => ({ studentId: s.student_id, name: s.name, grade: s.grade, hasLogin: s.has_login })),
  };
}

/**
 * Approve: write the address on the chosen record, invite the student and
 * mark the request approved — all in the invite's one transaction.
 * @returns {Promise<{ request: object, invite: { userId: string, inviteSent: boolean, message: string } }>}
 */
async function approveRequest({ school, requestId, admin, studentId, email: typed, consentConfirmed, noticeVersion }) {
  if (consentConfirmed !== true) throw refuse(400, 'Confirm you have parental consent before approving.', 'CONSENT_REQUIRED');
  if (!UUID_RE.test(String(studentId))) throw refuse(400, "Choose the student's record.", 'STUDENT_REQUIRED');
  const email = normalizeEmail(typed);
  if (!email || !EMAIL_RE.test(email)) throw refuse(400, "This email address isn't valid.", 'INVALID_EMAIL');
  let version = null;
  if (noticeVersion != null) {
    version = typeof noticeVersion === 'string' ? noticeVersion.trim() : '';
    if (version.length < 1 || version.length > MAX_NOTICE_VERSION) {
      throw refuse(400, `noticeVersion must be 1 to ${MAX_NOTICE_VERSION} characters`);
    }
  }

  await pendingRequest(school, requestId);
  const yearId = await activeYearId(school);
  if (!yearId) throw refuse(409, 'Set the current school year before approving requests.', 'NO_ACTIVE_YEAR');
  const { rows: [student] } = await db.query(accountQueries.selectStudentAccountRowsByIds, [school, [studentId], yearId]);
  if (!student) throw refuse(404, "That student isn't on this school year's roster.", 'STUDENT_NOT_FOUND');
  if (student.user_id) throw refuse(409, 'This student already has an account.', 'ALREADY_HAS_LOGIN');

  const settings = await getSettings(school);
  const [problems] = await problemsFor({ school, settings, students: [student], email });
  const blocking = problems.filter((p) => p.blocking);
  if (blocking.length > 0) throw refuse(409, blocking[0].message, 'BLOCKING_PROBLEMS', { problems });

  let approved = null;
  const result = await inviteStudent({
    // The address is the one the admin confirmed; its conflicts were checked above.
    student: { ...student, student_email: email, conflict_kind: null },
    settings,
    admin: { userId: admin.userId, username: admin.username, school, schoolYearId: yearId },
    noticeVersion: version ?? settings.consentNoticeVersion,
    withinTx: async (client, { userId }) => {
      await client.query(inviteQueries.setEmailOnRowAndSuccessors, [studentId, school, email]);
      const { rows: [row] } = await client.query(q.markApproved, [requestId, school, admin.userId, studentId, userId]);
      if (!row) throw refuse(409, 'This request was already handled.', 'REQUEST_NOT_PENDING');
      approved = row;
    },
  });
  if (result.outcome !== 'invited') throw refusalFor(result);
  return {
    request: toRequest(approved),
    invite: { userId: result.userId, inviteSent: result.inviteSent, message: result.message },
  };
}

/** Why a decline/restore/delete matched no row: missing, or in the wrong state. */
async function explainMiss(school, requestId, verb) {
  const { rows: [row] } = UUID_RE.test(String(requestId)) ? await db.query(q.selectOne, [school, requestId]) : { rows: [] };
  if (!row) return refuse(404, 'Request not found');
  return refuse(409, `This request is ${row.status}, so it can't be ${verb}.`, 'WRONG_STATE', { state: row.status });
}

async function declineRequest({ school, requestId, adminId }) {
  const { rows: [row] } = UUID_RE.test(String(requestId)) ? await db.query(q.markDeclined, [requestId, school, adminId]) : { rows: [] };
  if (!row) throw await explainMiss(school, requestId, 'declined');
  return toRequest(row);
}

async function restoreRequest({ school, requestId }) {
  let row;
  try {
    ({ rows: [row] } = UUID_RE.test(String(requestId)) ? await db.query(q.markRestored, [requestId, school]) : { rows: [] });
  } catch (err) {
    if (err.code === '23505') {
      throw refuse(409, 'A newer request for this address is already waiting.', 'ADDRESS_PENDING');
    }
    throw err;
  }
  if (!row) throw await explainMiss(school, requestId, 'restored');
  return toRequest(row);
}

async function deleteRequest({ school, requestId }) {
  const { rows: [row] } = UUID_RE.test(String(requestId)) ? await db.query(q.deleteDeclined, [requestId, school]) : { rows: [] };
  if (!row) throw await explainMiss(school, requestId, 'deleted');
  return { deleted: true };
}

module.exports = {
  submitRequest,
  notifyAdminsOfRequest,
  listRequests,
  requestCandidates,
  approveRequest,
  declineRequest,
  restoreRequest,
  deleteRequest,
};
