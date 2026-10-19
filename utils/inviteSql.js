// utils/inviteSql.js
//
// A student login's latest invite, as the same columns everywhere a row
// shows one (Student accounts and the class People tab), so both read it the
// way services/classroom/studentAccounts.js#latestInvite expects.

/** The select-list columns, read from the `inv` alias of latestInviteLateral. */
const INVITE_COLUMNS = `
       inv.send_status AS invite_send_status, inv.sent_at AS invite_sent_at, inv.expires_at AS invite_expires_at,
       inv.ended_at AS invite_ended_at, inv.end_reason AS invite_end_reason, inv.send_error AS invite_send_error`;

/** `LEFT JOIN LATERAL (...) inv ON TRUE`: the newest invite of the login `userExpr`. */
const latestInviteLateral = (userExpr) => `
LEFT JOIN LATERAL (
  SELECT si.send_status, si.sent_at, si.expires_at, si.ended_at, si.end_reason, si.send_error
    FROM student_invites si WHERE si.user_id = ${userExpr} ORDER BY si.created_at DESC LIMIT 1) inv ON TRUE`;

module.exports = { INVITE_COLUMNS, latestInviteLateral };
