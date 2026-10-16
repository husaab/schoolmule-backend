// services/classroom/studentAccounts.js
//
// Student logins: the StudentAccountRow shape the admin page reads, the
// account status rule, and the invite / password-link emails.
//
// A student signs in with their own address (users.email, copied from
// students.student_email at invite). The login is a users row with role
// STUDENT and the invite sentinel password '!' until the student sets one
// through the 7-day link; student_account_links ties it to one student row
// per school year.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/studentAccount.queries');
const adminUserQueries = require('../../queries/adminUser.queries');
const schoolQueries = require('../../queries/school.queries');
const { gradeRank } = require('../../utils/gradeRank');
const { getSchoolName } = require('../../utils/schoolUtils');
const { getResend, sendOrThrow } = require('../../utils/emailUtils');
const { schoolSender } = require('../email/senderIdentity');
const { getStudentInviteEmailHTML, getStudentPasswordResetEmailHTML } = require('../../templates/emailTemplate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_STATUSES = ['not_invited', 'invited', 'active', 'archived', 'not_eligible'];
const LINK_CONSTRAINTS = new Set(['uq_student_account_links_student', 'student_account_links_pkey']);

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Trimmed, lowercased address, or null when blank. */
const normalizeEmail = (raw) => {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === '' ? null : v;
};

/** "Amal Noor Haddad" → { firstName: 'Amal', lastName: 'Noor Haddad' }; lastName may be ''. */
const splitName = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: words[0] || '', lastName: words.slice(1).join(' ') };
};

const gradeLabel = (g) => (g === 'JK' || g === 'SK' ? g : `Grade ${g}`);

/** True when the grade gets no student login under these settings (unknown grades included). */
const isBelowLoginGrade = (grade, settings) => {
  const rank = gradeRank(grade);
  return rank === null || rank < gradeRank(settings.loginFromGrade);
};

const ROLE_WORD = { ADMIN: 'an admin', TEACHER: 'a teacher', PARENT: 'a parent', STUDENT: 'a student' };

const conflictMessage = (kind, role) =>
  kind === 'family_address'
    ? "This is a parent's address on file. Use the student's own school address."
    : `Already used by ${ROLE_WORD[role] || 'another'} account. Each student needs their own address.`;

/**
 * not_eligible / not_invited when no login is linked (by grade); otherwise
 * archived / invited (password still the invite sentinel) / active.
 */
const deriveStatus = (row, settings) => {
  if (!row.user_id) return isBelowLoginGrade(row.grade, settings) ? 'not_eligible' : 'not_invited';
  if (row.is_archived) return 'archived';
  if (row.invite_pending) return 'invited';
  return 'active';
};

/** selectStudentAccountRow(s) row → StudentAccountRow. */
const toStudentAccountRow = (row, settings) => {
  const status = deriveStatus(row, settings);
  const rank = gradeRank(row.grade);
  return {
    studentId: row.student_id,
    name: row.name,
    grade: row.grade,
    homeroomTeacherName: row.homeroom_teacher_name ?? null,
    studentEmail: row.student_email ?? null,
    status,
    account: row.user_id
      ? {
          userId: row.user_id,
          email: row.account_email,
          createdAt: iso(row.account_created_at),
          lastLoginAt: iso(row.last_login_at),
          lastSeenAt: iso(row.last_seen_at),
          consent: row.consent_at
            ? { at: iso(row.consent_at), byName: row.consent_by_name ?? null, noticeVersion: row.consent_notice_version ?? null }
            : null,
          qr: { active: Boolean(row.qr_active), issuedAt: iso(row.qr_issued_at), voidedAt: iso(row.qr_voided_at) },
        }
      : null,
    qrEligible: (status === 'invited' || status === 'active') && rank !== null && rank <= gradeRank(settings.qrUntilGrade),
    conflict: row.conflict_kind ? { kind: row.conflict_kind, message: conflictMessage(row.conflict_kind, row.conflict_role) } : null,
  };
};

/** The schools row for letterhead and sender, or null when it can't be read. */
async function loadSchoolInfo(school) {
  try {
    const { rows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
    return rows[0] || null;
  } catch (err) {
    logger.error({ err, school }, 'Failed to load school info for a student account email');
    return null;
  }
}

const schoolNameOf = (schoolInfo, school) => (schoolInfo && schoolInfo.name) || getSchoolName(String(school || ''));

const sendSchoolEmail = ({ school, schoolInfo, to, subject, html }) =>
  sendOrThrow(getResend(), { ...schoolSender({ school, schoolInfo, role: 'messages' }), to, subject, html });

/**
 * Issue a fresh 7-day invite link and email it. Throws when the email fails.
 * The caller deletes older tokens first when only the newest should work.
 */
async function sendStudentInvite({ userId, email, firstName, school, schoolInfo, invitedBy }) {
  const { rows } = await db.query(adminUserQueries.createInviteToken, [userId]);
  const schoolName = schoolNameOf(schoolInfo, school);
  const url = `${process.env.FRONTEND_URL}/reset-password?token=${rows[0].token}&invite=1&next=%2Fstudent`;
  await sendSchoolEmail({
    school,
    schoolInfo,
    to: email,
    subject: `Your ${schoolName} SchoolMule account`,
    html: getStudentInviteEmailHTML({ firstName, schoolName, schoolInfo, invitedBy, url }),
  });
}

/**
 * Replace the user's links with one 7-day password link (not the 15-minute
 * self-service reset token) and email it. Throws when the email fails.
 */
async function sendStudentPasswordReset({ userId, email, firstName, school, schoolInfo, requestedBy }) {
  await db.query(adminUserQueries.deleteTokensForUser, [userId]);
  const { rows } = await db.query(adminUserQueries.createInviteToken, [userId]);
  const schoolName = schoolNameOf(schoolInfo, school);
  const url = `${process.env.FRONTEND_URL}/reset-password?token=${rows[0].token}&next=%2Fstudent`;
  await sendSchoolEmail({
    school,
    schoolInfo,
    to: email,
    subject: 'Reset your SchoolMule password',
    html: getStudentPasswordResetEmailHTML({ firstName, schoolName, schoolInfo, requestedBy, url }),
  });
}

const skipped = (studentId, reason, message) => ({ studentId, outcome: 'skipped', reason, message });

/**
 * Invite one student (one transaction): validate, create the STUDENT login
 * with the invite sentinel, record consent on the account row, link it to the
 * student's school year, then email the set-password link. A failed email
 * keeps the account (inviteSent: false; "Resend invite" recovers it).
 *
 * @param {object} p
 * @param {object} p.student  a selectStudentAccountRow(s) row
 * @param {object} p.settings ClassroomSettings
 * @param {{ userId: string, username?: string, school: string, schoolYearId?: string|null }} p.admin
 * @param {string} p.noticeVersion consent notice version the admin confirmed
 * @param {object|null} [p.schoolInfo] schools row (loaded when omitted)
 */
async function inviteStudent({ student, settings, admin, noticeVersion, schoolInfo }) {
  const studentId = student.student_id;
  const email = normalizeEmail(student.student_email);

  if (!email) return skipped(studentId, 'no_email', "Add the student's own email address first.");
  if (!EMAIL_RE.test(email)) return skipped(studentId, 'invalid_email', "This email address isn't valid. Fix it before inviting.");
  if (student.user_id) return skipped(studentId, 'already_has_account', 'This student already has an account.');
  if (isBelowLoginGrade(student.grade, settings)) {
    return skipped(studentId, 'below_login_grade', `Student logins start at ${gradeLabel(settings.loginFromGrade)}.`);
  }
  if (student.conflict_kind) {
    return skipped(studentId, student.conflict_kind, conflictMessage(student.conflict_kind, student.conflict_role));
  }

  const { firstName, lastName } = splitName(student.name);
  const schoolYearId = student.school_year_id || admin.schoolYearId || null;
  let userId;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(adminUserQueries.insertInvitedUser, [
      email, [firstName, lastName].filter(Boolean).join(' '), firstName, lastName, admin.school, 'STUDENT',
    ]);
    userId = rows[0].user_id;
    await client.query(q.insertStudentAccount, [userId, admin.school, admin.userId, noticeVersion]);
    await client.query(q.insertStudentAccountLink, [userId, studentId, schoolYearId, admin.userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      // Another request got there first: the student was linked, or the address was taken.
      return LINK_CONSTRAINTS.has(err.constraint)
        ? skipped(studentId, 'already_has_account', 'This student already has an account.')
        : skipped(studentId, 'email_in_use', 'An account already uses this email. Each student needs their own address.');
    }
    throw err;
  } finally {
    client.release();
  }

  let inviteSent = true;
  try {
    await sendStudentInvite({
      userId,
      email,
      firstName,
      school: admin.school,
      schoolInfo: schoolInfo === undefined ? await loadSchoolInfo(admin.school) : schoolInfo,
      invitedBy: admin.username,
    });
  } catch (err) {
    inviteSent = false;
    logger.error({ err, userId, studentId }, 'Failed to send a student invite email');
  }

  return {
    studentId,
    outcome: 'invited',
    reason: null,
    message: inviteSent
      ? `Invite sent to ${email}`
      : 'Account created, but the invite email could not be sent. Try resending it.',
    userId,
    inviteSent,
  };
}

module.exports = {
  EMAIL_RE,
  ACCOUNT_STATUSES,
  normalizeEmail,
  splitName,
  isBelowLoginGrade,
  conflictMessage,
  deriveStatus,
  toStudentAccountRow,
  loadSchoolInfo,
  sendStudentInvite,
  sendStudentPasswordReset,
  inviteStudent,
};
