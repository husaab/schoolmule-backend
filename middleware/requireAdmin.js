// Blocks any non-ADMIN user. Apply with router.use(requireAdmin) after any
// routes that should stay accessible to all verified users.

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ status: 'failed', message: 'Admin access required' });
  }
  next();
};

module.exports = requireAdmin;
