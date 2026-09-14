// Blocks PARENT users. Staff (ADMIN and TEACHER) pass through. Apply to
// routes that expose whole-school data any staff member may read but which
// has no business in the parent portal.

const requireStaff = (req, res, next) => {
  if (!req.user || req.user.role === 'PARENT') {
    return res.status(403).json({ status: 'failed', message: 'Staff access required' });
  }
  next();
};

module.exports = requireStaff;
