// middleware/access.js
//
// RBAC guards. attachAccess runs once after verifyUser and puts req.access on
// every signed-in request (services/access/access.js); the guards below read
// it. Each guard also resolves access itself, so a route that runs verifyUser
// inline ahead of the global mount is covered too.
//
//   requirePermission(...keys)       any one of the keys
//   requireStaffAccess               an ADMIN or TEACHER view (any permissions)
//   requireStaffRead(...keys)        GET for any staff, writes need a key
//   requireFullAdmin                 roles, View as staff, making admins
//   classAccessGranted(req, cls, keys)  the class rule (see below)

const { ensureAccess, accessErrorResponse, assertKey, can, isFullAdmin } = require('../services/access/access');

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const denied = (keys) => ({
  success: false,
  status: 'failed',
  code: 'PERMISSION_DENIED',
  message: "You don't have permission to do that.",
  required: keys,
});

const withAccess = (check) => async (req, res, next) => {
  try {
    await ensureAccess(req);
  } catch (err) {
    return accessErrorResponse(res, err);
  }
  return check(req, res, next);
};

/** Global, right after verifyUser: a dead session (archived account) stops here. */
const attachAccess = withAccess((req, res, next) => next());

const requirePermission = (...keys) => {
  keys.forEach(assertKey); // a typo fails at startup, not in production
  return withAccess((req, res, next) => (
    keys.some((k) => can(req, k)) ? next() : res.status(403).json(denied(keys))
  ));
};

const requireStaffAccess = withAccess((req, res, next) => (
  req.access.isStaffView
    ? next()
    : res.status(403).json({ success: false, status: 'failed', message: 'Staff access required' })
));

/** Pickers and dropdowns read for every staff member; changes need a key. */
const requireStaffRead = (...keys) => {
  const gate = requirePermission(...keys);
  return (req, res, next) => (READ_METHODS.has(req.method) ? requireStaffAccess(req, res, next) : gate(req, res, next));
};

const requireFullAdmin = withAccess((req, res, next) => (
  isFullAdmin(req)
    ? next()
    : res.status(403).json({
      success: false,
      status: 'failed',
      code: 'FULL_ADMIN_REQUIRED',
      message: 'Only a full administrator can do that.',
    })
));

/**
 * The class rule, shared by requireClassOwnership and requireClassroomResource.
 * cls = { school, teacher_id, is_co_teacher }. A staff view in the class's
 * school passes when they teach it (lead or co-teacher), hold classes.all, or
 * hold one of `extraKeys` (e.g. attendance.classes for class attendance).
 */
const classAccessGranted = (req, cls, extraKeys = []) => {
  if (!req.access || !req.access.isStaffView) return false;
  if (cls.school !== req.user.school) return false;
  if (cls.teacher_id === req.user.userId || cls.is_co_teacher) return true;
  return can(req, 'classes.all') || extraKeys.some((k) => can(req, k));
};

module.exports = {
  attachAccess,
  requirePermission,
  requireStaffAccess,
  requireStaffRead,
  requireFullAdmin,
  classAccessGranted,
  withAccess,
};
