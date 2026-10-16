// Staff only: ADMIN and TEACHER (the active view). Allowlist, not a parent
// denylist, so a STUDENT or any future role is refused by default. Apply to
// routes that expose whole-school data any staff member may read but which
// has no business in the parent or student portal.
const STAFF_ROLES = new Set(['ADMIN', 'TEACHER']);
const requireStaff = (req, res, next) => {
  if (!req.user || !STAFF_ROLES.has(req.user.role)) {
    return res.status(403).json({ status: 'failed', message: 'Staff access required' });
  }
  next();
};

module.exports = requireStaff;
