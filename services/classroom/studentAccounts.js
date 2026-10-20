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

const QRCode = require('qrcode');
const db = require('../../config/database');
const { inTransaction } = require('../../utils/transaction');
const logger = require('../../logger');
const q = require('../../queries/studentAccount.queries');
const adminUserQueries = require('../../queries/adminUser.queries');
const schoolQueries = require('../../queries/school.queries');
const { gradeRank } = require('../../utils/gradeRank');
const { getSchoolName } = require('../../utils/schoolUtils');
const { getResend, sendOrThrow } = require('../../utils/emailUtils');
const { createPDFBuffer } = require('../../utils/pdfGenerator');
const { schoolSender } = require('../email/senderIdentity');
const { getStudentPasswordResetEmailHTML } = require('../../templates/emailTemplate');
const { renderStudentCardsHTML } = require('../../templates/studentCardsTemplate');
const { getSettings } = require('./classroomSettings');
const { issueQrSecret, qrPayload } = require('./studentLogin');
const { conflictMessage, addressWarnings } = require('./emailProblems');
const {
  inviteState, createInvite, sendInvite, endOpenInvites, linkSuccessorRows, invitesSentToday, MAX_INVITE_EMAILS_PER_DAY,
} = require('./studentInvites');
const inviteQueries = require('../../queries/studentInvite.queries');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The most students one request may act on (invite, cards, void).
const MAX_STUDENT_BATCH = 200;
const ACCOUNT_STATUSES = ['not_invited', 'invited', 'active', 'archived', 'not_eligible'];
// The list's ?status= filter also takes the Needs attention chip.
const STATUS_FILTERS = [...ACCOUNT_STATUSES, 'needs_attention'];
const LINK_CONSTRAINTS = new Set(['uq_student_account_links_student', 'student_account_links_pkey']);

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Trimmed, lowercased address, or null when blank. */
const normalizeEmail = (raw) => {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === '' ? null : v;
};

/** "Amal Noor Haddad" → { firstName: 'Amal', lastName: 'Noor Haddad', fullName: 'Amal Noor Haddad' }; lastName may be ''. */
const splitName = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: words[0] || '', lastName: words.slice(1).join(' '), fullName: words.join(' ') };
};

const gradeLabel = (g) => (g === 'JK' || g === 'SK' ? g : `Grade ${g}`);

/** True when the grade gets no student login under these settings (unknown grades included). */
const isBelowLoginGrade = (grade, settings) => {
  const rank = gradeRank(grade);
  return rank === null || rank < gradeRank(settings.loginFromGrade);
};

/** A ROW_SELECT row's conflict as conflictMessage's details. */
const rowConflict = (row) => ({
  role: row.conflict_role,
  sameSchool: row.conflict_same_school,
  otherName: row.conflict_other_name,
  otherGrade: row.conflict_other_grade,
});

/**
 * not_eligible / not_invited when no login is linked (by grade); otherwise
 * archived / invited (never signed in: the invite sentinel password and no
 * activation, e.g. a first QR scan) / active.
 */
const deriveStatus = (row, settings) => {
  if (!row.user_id) return isBelowLoginGrade(row.grade, settings) ? 'not_eligible' : 'not_invited';
  if (row.is_archived) return 'archived';
  if (row.invite_pending && !row.activated_at) return 'invited';
  return 'active';
};

/** How the login signs in: Google, a password, only the QR card, or not yet. */
const signInMethodOf = (row) => {
  if (!row.user_id) return null;
  if (row.has_google) return 'google';
  if (!row.invite_pending) return 'password';
  if (row.activated_via === 'card') return 'card';
  return null;
};

/** The login's latest invite, or null. */
const latestInvite = (row) => (row.invite_expires_at
  ? {
    state: inviteState({
      ended_at: row.invite_ended_at,
      end_reason: row.invite_end_reason,
      send_status: row.invite_send_status,
      expires_at: row.invite_expires_at,
    }),
    sentAt: iso(row.invite_sent_at),
    expiresAt: iso(row.invite_expires_at),
    endedAt: iso(row.invite_ended_at),
    error: row.invite_send_status === 'failed' ? (row.invite_send_error || 'The email could not be sent') : null,
  }
  : null);

/**
 * Something for the office to do: an invite that didn't go out, expired or
 * was cancelled (or a login with no invite at all), or a card-only student
 * whose grade no longer uses the card.
 */
const needsAttentionOf = ({ status, invite, signInMethod, grade }, settings) => {
  if (status === 'invited') return !invite || invite.state !== 'pending';
  if (status === 'active' && signInMethod === 'card') {
    const rank = gradeRank(grade);
    return rank === null || rank > gradeRank(settings.qrUntilGrade);
  }
  return false;
};

/** A QR card goes to a student with a login (invited or active) at or below the school's QR grade ceiling. */
const isQrEligible = (status, grade, settings) => {
  const rank = gradeRank(grade);
  return (status === 'invited' || status === 'active') && rank !== null && rank <= gradeRank(settings.qrUntilGrade);
};

/** selectStudentAccountRow(s) row → StudentAccountRow. */
const toStudentAccountRow = (row, settings) => {
  const status = deriveStatus(row, settings);
  const signInMethod = signInMethodOf(row);
  const invite = row.user_id ? latestInvite(row) : null;
  return {
    studentId: row.student_id,
    name: row.name,
    // The displayed avatar: the login's own pick over the teacher-set one.
    studentAvatar: row.student_avatar ?? null,
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
    qrEligible: isQrEligible(status, row.grade, settings),
    conflict: row.conflict_kind ? { kind: row.conflict_kind, message: conflictMessage(row.conflict_kind, rowConflict(row)) } : null,
    warnings: row.student_email
      ? addressWarnings(row.student_email, row.name, settings.studentEmailDomains).map(({ code, message }) => ({ code, message }))
      : [],
    invite,
    signInMethod,
    needsAttention: needsAttentionOf({ status, invite, signInMethod, grade: row.grade }, settings),
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

/**
 * A request body's `studentIds`: 1 to MAX_STUDENT_BATCH UUIDs, lowercased and
 * de-duplicated in order.
 * @returns {{ ids: string[] } | { error: string }}
 */
function parseStudentIds(studentIds) {
  if (!Array.isArray(studentIds) || studentIds.length < 1 || studentIds.length > MAX_STUDENT_BATCH) {
    return { error: `Choose between 1 and ${MAX_STUDENT_BATCH} students` };
  }
  if (!studentIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) return { error: 'Invalid student id' };
  return { ids: [...new Set(studentIds.map((id) => id.toLowerCase()))] };
}

const refused = (status, message) => ({ sent: false, status, message });

/**
 * "Resend invite" for a student row with a login that has never set up
 * email sign-in (invited, or a card student): a new invite replaces the open
 * one, so only the newest link works. Admin and the student's teachers; at
 * most MAX_INVITE_EMAILS_PER_DAY a day per student. Never throws for a
 * refusal: returns { sent: true } or { sent: false, status, message }.
 */
async function resendInviteFor(row, { school, actorId }) {
  if (row.is_archived) return refused(409, 'This account is archived. Restore it first.');
  if (!row.invite_pending) return refused(400, 'This student has already set up sign-in. Send a password link instead.');
  const { firstName, fullName } = splitName(row.name);
  if (await invitesSentToday(row.student_id) >= MAX_INVITE_EMAILS_PER_DAY) {
    return refused(429, `Too many invites for ${firstName} today. Try again tomorrow.`);
  }

  const [settings, schoolInfo] = await Promise.all([getSettings(school), loadSchoolInfo(school)]);
  const invite = await inTransaction(async (client) => {
    await client.query(adminUserQueries.deleteTokensForUser, [row.user_id]);
    return createInvite(client, {
      school,
      userId: row.user_id,
      studentId: row.student_id,
      schoolYearId: row.school_year_id,
      email: row.account_email,
      createdBy: actorId,
    });
  });
  const sent = await sendInvite({
    ...invite,
    email: row.account_email,
    firstName,
    fullName,
    school,
    schoolInfo,
    studentSignIn: settings.studentSignIn,
  });
  if (!sent.sent) return refused(502, "The invite email couldn't be sent. Try again.");
  return { sent: true };
}

/**
 * "Cancel invite" (admin): the open invite's link stops working. A login that
 * was never used (no password, no Google, never signed in, no live card) is
 * deleted with it, so the student reads Not invited and the address is free;
 * one that was used keeps signing in. Returns { cancelled: true, deletedLogin }
 * or a refusal.
 */
async function cancelInviteFor(row, { school, actorId }) {
  const { rows: open } = await db.query(inviteQueries.selectOpenInvite, [row.user_id]);
  if (open.length === 0) return refused(409, "There's no open invite to cancel.");
  const unused = row.invite_pending && !row.has_google && !row.last_login_at && !row.activated_at && !row.qr_active;

  const ended = await inTransaction(async (client) => {
    // 0 when the student accepted (or someone else cancelled) since the row was read:
    // then nothing is deleted, and the login the student just set up stays.
    const n = await endOpenInvites(client, { userId: row.user_id, reason: 'cancelled', endedBy: actorId });
    if (n === 0) return false;
    await client.query(adminUserQueries.deleteTokensForUser, [row.user_id]);
    if (unused) await client.query(q.deleteStudentUser, [row.user_id, school]);
    return true;
  });
  if (!ended) return refused(409, "There's no open invite to cancel.");
  return { cancelled: true, deletedLogin: unused };
}

/**
 * "Reset password" for a student row with a login: a fresh 7-day password
 * link, older links die. Same result shape as resendInviteFor.
 */
async function resetPasswordFor(row, { school, requestedBy }) {
  if (row.is_archived) return refused(409, 'This account is archived. Restore it first.');
  if ((await getSettings(school)).studentSignIn === 'google_only') {
    return refused(409, 'Your school uses Google sign-in, so students have no password to reset.');
  }
  if (row.invite_pending) return refused(400, "This student hasn't set a password yet. Resend the invite instead.");

  try {
    await sendStudentPasswordReset({
      userId: row.user_id,
      email: row.account_email,
      firstName: splitName(row.name).firstName,
      school,
      schoolInfo: await loadSchoolInfo(school),
      requestedBy: requestedBy || 'Your school',
    });
  } catch (err) {
    logger.error({ err, userId: row.user_id }, 'Failed to send a student password link');
    return refused(502, "The password email couldn't be sent. Try again.");
  }
  return { sent: true };
}

const CARD_PDF_OPTIONS = {
  format: 'Letter',
  margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
};
// A fresh object per call: qrcode writes its defaults into the options it gets.
const qrImageOptions = () => ({ errorCorrectionLevel: 'M', margin: 1, width: 300 });


// Cards come out in the order they are handed out: grade, homeroom, name.
const byClassroom = (a, b) =>
  (gradeRank(a.grade) ?? 99) - (gradeRank(b.grade) ?? 99)
  || String(a.homeroomTeacherName || '').localeCompare(String(b.homeroomTeacherName || ''))
  || a.name.localeCompare(b.name);

/**
 * Print QR sign-in cards. Every eligible student (a login that is invited or
 * active, a QR grade, a current row of the active year) gets a NEW secret: only its hash is
 * stored, so printing always voids the student's previous card. The hashes
 * are written only after the PDF rendered, so a failed print leaves the
 * cards already in students' hands working.
 *
 * @param {{ school: string, studentIds: string[], requestedBy?: string }} p
 * @returns {Promise<{ pdf: Buffer|null, issued: number, skippedIds: string[] }>}
 *   pdf is null when no card could be issued.
 */
async function issueQrCards({ school, studentIds, requestedBy }) {
  const [settings, { rows }] = await Promise.all([
    getSettings(school),
    db.query(q.selectStudentAccountRowsForCards, [school, studentIds]),
  ]);
  const byId = new Map(rows.map((r) => [r.student_id, r]));

  const issued = [];
  const skippedIds = [];
  const cardHolders = new Set();
  for (const studentId of studentIds) {
    const row = byId.get(studentId);
    // One card per login: a second row of the same student (another year)
    // would only void the card printed for the first.
    if (!row || !toStudentAccountRow(row, settings).qrEligible || cardHolders.has(row.user_id)) {
      skippedIds.push(studentId);
      continue;
    }
    cardHolders.add(row.user_id);
    const { secret, hash } = issueQrSecret();
    issued.push({
      userId: row.user_id,
      hash,
      card: {
        name: row.name,
        grade: row.grade,
        homeroomTeacherName: row.homeroom_teacher_name ?? null,
        email: row.account_email,
        // Plain text, not a URL: read by the app's "Scan my card" (studentLogin.js).
        qrDataUrl: await QRCode.toDataURL(qrPayload(row.user_id, secret), qrImageOptions()),
      },
    });
  }
  if (issued.length === 0) return { pdf: null, issued: 0, skippedIds };

  const schoolInfo = await loadSchoolInfo(school);
  const cards = issued.map((i) => i.card).sort(byClassroom);
  const pdf = await createPDFBuffer(renderStudentCardsHTML({ schoolName: schoolNameOf(schoolInfo, school), cards }), CARD_PDF_OPTIONS);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const { userId, hash } of issued) await client.query(q.setQrSecret, [userId, hash]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  logger.info({ school, requestedBy, issued: issued.length, skipped: skippedIds.length }, 'Student QR cards issued');
  return { pdf, issued: issued.length, skippedIds };
}

/** Void the live QR cards of these students (of the school). Resolves to how many were voided. */
async function voidQr({ school, studentIds }) {
  const { rowCount } = await db.query(q.voidQrForStudents, [school, studentIds]);
  return rowCount;
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
 * @param {(client: object, created: { userId: string }) => Promise<void>} [p.withinTx]
 *   more writes that must commit with the login or not at all (an approved
 *   account request); a throw rolls the whole invite back and is rethrown.
 */
async function inviteStudent({ student, settings, admin, noticeVersion, schoolInfo, withinTx }) {
  const studentId = student.student_id;
  const email = normalizeEmail(student.student_email);

  if (!email) return skipped(studentId, 'no_email', "Add the student's own email address first.");
  if (!EMAIL_RE.test(email)) return skipped(studentId, 'invalid_email', "This email address isn't valid. Fix it before inviting.");
  if (student.user_id) return skipped(studentId, 'already_has_account', 'This student already has an account.');
  if (isBelowLoginGrade(student.grade, settings)) {
    return skipped(studentId, 'below_login_grade', `Student logins start at ${gradeLabel(settings.loginFromGrade)}.`);
  }
  if (student.conflict_kind) {
    return skipped(studentId, student.conflict_kind, conflictMessage(student.conflict_kind, rowConflict(student)));
  }

  const { firstName, lastName, fullName } = splitName(student.name);
  const schoolYearId = student.school_year_id || admin.schoolYearId || null;
  let userId;
  let invite;
  try {
    ({ userId, invite } = await inTransaction(async (client) => {
      const { rows } = await client.query(adminUserQueries.insertInvitedUser, [
        email, fullName, firstName, lastName, admin.school, 'STUDENT', null, // no access role
      ]);
      const newUserId = rows[0].user_id;
      await client.query(q.insertStudentAccount, [newUserId, admin.school, admin.userId, noticeVersion]);
      await client.query(q.insertStudentAccountLink, [newUserId, studentId, schoolYearId, admin.userId]);
      // Next year's row, when rollover already made it (R5).
      await linkSuccessorRows(client, { userId: newUserId, studentId, linkedBy: admin.userId });
      const created = await createInvite(client, {
        school: admin.school, userId: newUserId, studentId, schoolYearId, email, createdBy: admin.userId,
      });
      if (withinTx) await withinTx(client, { userId: newUserId });
      return { userId: newUserId, invite: created };
    }));
  } catch (err) {
    if (err.code === '23505') {
      // Another request got there first. A double-clicked invite loses on the
      // users email (the winner created this student's login with it), so
      // check the link before calling the address taken.
      if (LINK_CONSTRAINTS.has(err.constraint)) {
        return skipped(studentId, 'already_has_account', 'This student already has an account.');
      }
      const { rows: linked } = await db.query(q.selectLinkByStudent, [studentId]);
      return linked.length > 0
        ? skipped(studentId, 'already_has_account', 'This student already has an account.')
        : skipped(studentId, 'email_in_use', 'An account already uses this email. Each student needs their own address.');
    }
    throw err;
  }

  const { sent: inviteSent } = await sendInvite({
    ...invite,
    email,
    firstName,
    fullName,
    school: admin.school,
    schoolInfo: schoolInfo === undefined ? await loadSchoolInfo(admin.school) : schoolInfo,
    studentSignIn: settings.studentSignIn,
  });

  return {
    studentId,
    outcome: 'invited',
    reason: null,
    message: inviteSent
      ? `Invite sent to ${email}`
      : 'Account created, but the invite email could not be sent. Try resending it.',
    userId,
    inviteId: invite.inviteId,
    inviteSent,
    sendStatus: inviteSent ? 'sent' : 'failed',
  };
}

module.exports = {
  EMAIL_RE,
  MAX_STUDENT_BATCH,
  ACCOUNT_STATUSES,
  STATUS_FILTERS,
  normalizeEmail,
  splitName,
  isBelowLoginGrade,
  gradeLabel,
  conflictMessage,
  deriveStatus,
  signInMethodOf,
  latestInvite,
  isQrEligible,
  toStudentAccountRow,
  loadSchoolInfo,
  sendStudentPasswordReset,
  inviteStudent,
  parseStudentIds,
  resendInviteFor,
  cancelInviteFor,
  resetPasswordFor,
  issueQrCards,
  voidQr,
};
