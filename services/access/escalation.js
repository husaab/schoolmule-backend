// services/access/escalation.js
//
// What someone who manages users but is not a full admin may NOT do to an
// account, so the `users` permission can't be turned into more access:
//   - touch a full admin's account (edit, archive, delete, resend, preview)
//   - make anyone an administrator, or change their own role
//   - give, change or remove a staff role (only full admins manage roles)
//   - "View as" anyone but a student
// Pure: callers load the target row and pass req.access.

const isFullAdminRow = (u) => u.role === 'ADMIN' && !u.staff_role_id;

const OK = Object.freeze({ ok: true });
const deny = (message) => ({ ok: false, status: 403, message });

/** Any change to (or preview of) the target account. */
function checkTouch(access, target) {
  if (access.isFullAdmin) return OK;
  if (isFullAdminRow(target)) return deny('Only a full administrator can change an administrator account');
  return OK;
}

/** next = { role, staffRoleProvided, staffRoleId } */
function checkEdit(access, actorId, target, next) {
  const touch = checkTouch(access, target);
  if (!touch.ok) return touch;
  if (access.isFullAdmin) return OK;
  if (next.role === 'ADMIN' && target.role !== 'ADMIN') return deny('Only a full administrator can make someone an administrator');
  if (next.staffRoleProvided && (next.staffRoleId ?? null) !== (target.staff_role_id ?? null)) {
    return deny('Only a full administrator can change staff roles');
  }
  if (target.user_id === actorId && next.role && next.role !== target.role) return deny("You can't change your own role");
  return OK;
}

function checkInvite(access, { role, staffRoleId }) {
  if (access.isFullAdmin) return OK;
  if (role === 'ADMIN') return deny('Only a full administrator can invite an administrator');
  if (staffRoleId) return deny('Only a full administrator can give a staff role');
  return OK;
}

/** "View as": full admins preview anyone but a full admin; `users` holders only students. */
function checkImpersonate(access, target) {
  if (isFullAdminRow(target)) return deny('A full administrator cannot be previewed');
  if (access.isFullAdmin) return OK;
  if (target.role === 'STUDENT') return OK;
  return deny('Only a full administrator can preview staff and parents');
}

module.exports = { isFullAdminRow, checkTouch, checkEdit, checkInvite, checkImpersonate };
