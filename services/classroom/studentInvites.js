// services/classroom/studentInvites.js
//
// Student invitations: one student_invites row per invite email. The link
// carries a 32-byte secret in its fragment (/student-invite#<secret>), so it
// never reaches a server log or a Referer; only the secret's SHA-256 is
// stored. An invite is open until it is accepted, replaced by a resend,
// cancelled, or ended by an address change or an archive; the row (and its
// hash) stays, so a dead link can still say why it is dead.

const crypto = require('crypto');
const db = require('../../config/database');
const { inTransaction } = require('../../utils/transaction');
const logger = require('../../logger');
const q = require('../../queries/studentInvite.queries');
const adminUserQueries = require('../../queries/adminUser.queries');
const schoolQueries = require('../../queries/school.queries');
const studentAccountQueries = require('../../queries/studentAccount.queries');
const { getResend, sendOrThrow, sendSafely } = require('../../utils/emailUtils');
const { getSchoolName } = require('../../utils/schoolUtils');
const { schoolSender } = require('../email/senderIdentity');
const { getStudentInviteEmailHTML, getStudentAccountReadyEmailHTML } = require('../../templates/emailTemplate');
const { normalizeName } = require('../import/matching');

/** How long an invite link works. */
const INVITE_VALID_DAYS = 14;
/** The most invite emails one student gets in 24 hours (any sender). */
const MAX_INVITE_EMAILS_PER_DAY = 5;

const hashInviteSecret = (secret) => crypto.createHash('sha256').update(secret).digest('hex');
const issueInviteSecret = () => {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, hash: hashInviteSecret(secret) };
};
/** The secret from a request body, or null unless it is exactly one (43 base64url characters). */
const parseInviteToken = (raw) => {
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
};
const inviteUrl = (secret) => `${process.env.FRONTEND_URL}/student-invite#${secret}`;

const TORONTO_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Toronto', weekday: 'long', month: 'long', day: 'numeric',
});
/** "Monday, November 2" in Toronto time. */
const formatInviteDate = (date) => TORONTO_DAY.format(new Date(date));

/**
 * The state of one invite row: how it ended, else expired, else failed (the
 * email didn't go), else pending. Expiry comes before a failed send: a send
 * can fail after Resend delivered the email, and that link must still die.
 * @param {{ ended_at, end_reason, send_status, expires_at }} row
 */
function inviteState(row, now = new Date()) {
  if (row.ended_at) return row.end_reason;
  if (new Date(row.expires_at) <= now) return 'expired';
  if (row.send_status === 'failed') return 'failed';
  return 'pending';
}

/** End the login's open invite (if any). Resolves to how many ended (0 or 1). */
async function endOpenInvites(client, { userId, reason, endedBy = null }) {
  const { rowCount } = await client.query(q.endOpenInvites, [userId, reason, endedBy]);
  return rowCount;
}

/**
 * A new invite for a login, replacing its open one. Runs on the caller's
 * transaction client. The secret is returned once, for the email, and never
 * stored.
 * @returns {Promise<{ inviteId: string, secret: string, expiresAt: Date }>}
 */
async function createInvite(client, { school, userId, studentId, schoolYearId, email, createdBy }) {
  await endOpenInvites(client, { userId, reason: 'replaced', endedBy: createdBy });
  const { secret, hash } = issueInviteSecret();
  const { rows } = await client.query(q.insertInvite, [
    school, userId, studentId, schoolYearId, email, hash, INVITE_VALID_DAYS, createdBy,
  ]);
  return { inviteId: rows[0].invite_id, secret, expiresAt: rows[0].expires_at };
}

/** Link a login to the student's already-rolled later rows (caller's transaction). */
const linkSuccessorRows = (client, { userId, studentId, linkedBy }) =>
  client.query(q.linkSuccessorRows, [userId, studentId, linkedBy]);

/** Invite emails made for this student in the last 24 hours. */
async function invitesSentToday(studentId) {
  const { rows } = await db.query(q.countRecentInvites, [studentId]);
  return rows[0].n;
}

/** The invite email's subject and HTML (also the admin's preview). */
function renderInviteEmail({ firstName, fullName, school, schoolInfo, email, url, expiresAt, studentSignIn }) {
  const schoolName = (schoolInfo && schoolInfo.name) || getSchoolName(String(school || ''));
  return {
    subject: `Set up your ${schoolName} SchoolMule account`,
    html: getStudentInviteEmailHTML({
      firstName,
      fullName,
      schoolName,
      schoolInfo,
      url,
      email,
      expiresOn: formatInviteDate(expiresAt),
      googleOnly: studentSignIn === 'google_only',
    }),
  };
}

/**
 * Email an invite and record the outcome on its row. Never throws for a
 * failed email: the row reads failed and Resend invite recovers it.
 * @returns {Promise<{ sent: true } | { sent: false, error: string }>}
 */
async function sendInvite({ inviteId, secret, expiresAt, email, firstName, fullName, school, schoolInfo, studentSignIn }) {
  const { subject, html } = renderInviteEmail({
    firstName, fullName, school, schoolInfo, email, url: inviteUrl(secret), expiresAt, studentSignIn,
  });
  try {
    const result = await sendOrThrow(getResend(), {
      ...schoolSender({ school, schoolInfo, role: 'messages' }), to: email, subject, html,
    });
    await db.query(q.markSent, [inviteId, result?.data?.id ?? null]);
    return { sent: true };
  } catch (err) {
    logger.error({ err, inviteId }, 'Failed to send a student invite email');
    const error = String(err?.message || 'The email could not be sent').slice(0, 500);
    await db.query(q.markFailed, [inviteId, error]).catch((e) => logger.error({ err: e, inviteId }, 'Failed to record an invite send failure'));
    return { sent: false, error };
  }
}

/**
 * What a dead or live invite link says on the public page: valid, expired,
 * used (accepted), replaced (a newer invite) or cancelled (cancelled, the
 * address changed, the account archived, or the login deleted).
 */
function publicInviteState(row, now = new Date()) {
  if (!row.ended_at && !row.user_id) return 'cancelled';
  const state = inviteState(row, now);
  if (state === 'pending' || state === 'failed') return 'valid';
  if (state === 'accepted') return 'used';
  if (state === 'replaced' || state === 'expired') return state;
  return 'cancelled';
}

/** First sign-in by any method (the caller's transaction, or db). */
const recordActivation = (client, { userId, via }) => client.query(q.recordActivation, [userId, via]);

const PASSWORD_MIN = 8;
const COMMON_PASSWORDS = new Set(['password', 'password1', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', '11111111', 'abcdefgh', 'iloveyou']);

/**
 * Why a student's chosen password won't do, or null. Students are children
 * whose addresses are easy to guess, so their password must not be the
 * address, their name, the school's name or a very common one.
 */
function passwordProblem(password, { email = '', firstName = '', lastName = '', schoolName = '' } = {}) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  const lower = password.toLowerCase();
  const local = String(email).toLowerCase().split('@')[0];
  if (lower === String(email).toLowerCase() || (local.length >= 4 && lower.includes(local))) {
    return "Don't use your email address.";
  }
  const squashed = normalizeName(password).replace(/\s+/g, '');
  const names = [firstName, lastName].flatMap((n) => normalizeName(n).split(' ')).filter((t) => t.length >= 3);
  if (names.some((n) => squashed.includes(n))) return "Don't use your name in your password.";
  const school = normalizeName(schoolName).replace(/\s+/g, '');
  if (COMMON_PASSWORDS.has(lower) || (school.length >= 4 && squashed.includes(school))) {
    return 'Choose something harder to guess.';
  }
  return null;
}

const domainOf = (email) => String(email).slice(String(email).lastIndexOf('@') + 1).toLowerCase();

/**
 * Whether a verified Google identity may become this student login's sign-in,
 * as a { status, code, message } verdict or null. The Google address must be
 * the login's, and an address on one of the school's declared student
 * domains must come from that Google Workspace domain (hd).
 */
function acceptGoogleChecks(google, user, domains = []) {
  if (!google.emailVerified) {
    return { status: 403, code: 'GOOGLE_UNVERIFIED', message: "Google hasn't verified this account's email address, so it can't be used here." };
  }
  if (String(google.email).toLowerCase() !== String(user.email).toLowerCase()) {
    return {
      status: 409,
      code: 'GOOGLE_WRONG_ACCOUNT',
      message: `That Google account is ${google.email}. This invite is for ${user.email}.`,
    };
  }
  const domain = domainOf(user.email);
  if (domains.includes(domain) && String(google.hd || '').toLowerCase() !== domain) {
    return { status: 409, code: 'GOOGLE_WRONG_DOMAIN', message: `Use your school Google account (${domain}).` };
  }
  return null;
}

// Resend allows ~2 requests/second.
const GUARDIAN_EMAIL_GAP_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The first time a student sets up their own sign-in (a password or Google),
 * tell their guardians once, ever. Never throws: a failure is logged and the
 * student's sign-in goes on.
 */
async function notifyGuardiansOnce({ userId, via }) {
  try {
    const { rows: claimed } = await db.query(q.claimGuardianNotice, [userId]);
    if (claimed.length === 0) return;
    const { rows: [row] } = await db.query(q.selectLatestLinkedStudent, [userId]);
    if (!row) return;
    const { rows: [login] } = await db.query(studentAccountQueries.selectStudentUserEmail, [userId]);
    const { rows: addresses } = await db.query(q.selectGuardianAddresses, [row.student_id, login?.email || '']);
    // The school's letterhead and contact footer ("contact the school office").
    const { rows: [schoolInfo = null] } = await db.query(schoolQueries.selectSchoolByCode, [row.school]);
    const firstName = String(row.name).trim().split(/\s+/)[0];
    const schoolName = (schoolInfo && schoolInfo.name) || getSchoolName(row.school);
    const html = getStudentAccountReadyEmailHTML({
      firstName, schoolName, schoolInfo, activatedOn: formatInviteDate(new Date()), via,
    });
    for (let i = 0; i < addresses.length; i += 1) {
      await sendSafely(getResend(), {
        ...schoolSender({ school: row.school, schoolInfo, role: 'messages' }),
        to: addresses[i].email,
        subject: `${firstName}'s SchoolMule account is ready`,
        html,
      }, 'Student account-ready email failed to send', { userId });
      if (i < addresses.length - 1) await sleep(GUARDIAN_EMAIL_GAP_MS);
    }
  } catch (err) {
    logger.error({ err, userId }, 'Failed to tell guardians a student account is ready');
  }
}

/**
 * A pending student's first Google sign-in through /login: Google proved the
 * address, which is what the invite is for, so it counts as accepting it
 * (whatever its state). The open invite ends as accepted, reset links die,
 * the activation is stamped and the guardians are told (R2).
 */
async function recordGoogleAcceptance(userId) {
  await inTransaction(async (client) => {
    await client.query(q.acceptOpenInvite, [userId, 'google']);
    await client.query(adminUserQueries.deleteTokensForUser, [userId]);
    await recordActivation(client, { userId, via: 'google' });
  });
  await notifyGuardiansOnce({ userId, via: 'google' });
}

module.exports = {
  INVITE_VALID_DAYS,
  MAX_INVITE_EMAILS_PER_DAY,
  hashInviteSecret,
  issueInviteSecret,
  parseInviteToken,
  inviteUrl,
  formatInviteDate,
  inviteState,
  endOpenInvites,
  createInvite,
  linkSuccessorRows,
  invitesSentToday,
  renderInviteEmail,
  sendInvite,
  publicInviteState,
  recordActivation,
  passwordProblem,
  acceptGoogleChecks,
  notifyGuardiansOnce,
  recordGoogleAcceptance,
};
