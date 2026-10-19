// services/classroom/studentInvites.js
//
// Student invitations: one student_invites row per invite email. The link
// carries a 32-byte secret in its fragment (/student-invite#<secret>), so it
// never reaches a server log or a Referer; only the secret's SHA-256 is
// stored. An invite is open until it is accepted, replaced by a resend,
// cancelled, or ended by an address change or an archive; the row (and its
// hash) stays, so a dead link can still say why it is dead.

/** How long an invite link works. */
const INVITE_VALID_DAYS = 14;
/** The most invite emails one student gets in 24 hours (any sender). */
const MAX_INVITE_EMAILS_PER_DAY = 5;

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

module.exports = {
  INVITE_VALID_DAYS,
  MAX_INVITE_EMAILS_PER_DAY,
  inviteState,
};
