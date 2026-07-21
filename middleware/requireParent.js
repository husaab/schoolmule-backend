// Blocks any non-PARENT user. Apply with router.use(requireParent) on routes
// that expose parent-portal data scoped to the logged-in parent's children.

const requireParent = (req, res, next) => {
  if (req.user?.role !== 'PARENT') {
    return res.status(403).json({ status: 'failed', message: 'Parent access required' });
  }
  next();
};

module.exports = requireParent;
