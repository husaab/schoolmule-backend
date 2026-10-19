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
const logger = require('../../logger');
const q = require('../../queries/studentInvite.queries');
const { getResend, sendOrThrow } = require('../../utils/emailUtils');
const { getSchoolName } = require('../../utils/schoolUtils');
const { schoolSender } = require('../email/senderIdentity');
const { getStudentInviteEmailHTML } = require('../../templates/emailTemplate');

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
 * The state of one invite row: how it ended, else failed (the email didn't
 * go), expired, or pending.
 * @param {{ ended_at, end_reason, send_status, expires_at }} row
 */
function inviteState(row, now = new Date()) {
  if (row.ended_at) return row.end_reason;
  if (row.send_status === 'failed') return 'failed';
  if (new Date(row.expires_at) <= now) return 'expired';
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
};
