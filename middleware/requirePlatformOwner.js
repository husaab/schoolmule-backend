// The platform owner is not a role: ADMIN is school-scoped and roles drive
// patch-note targeting. Ownership is an env allowlist checked on every
// request, so revoking it needs no token change. A "view as" preview token
// is refused even for the owner, because it carries someone else's role.

function ownerEmails() {
  return String(process.env.PLATFORM_OWNER_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isPlatformOwner(email) {
  if (!email || typeof email !== 'string') return false;
  return ownerEmails().includes(email.trim().toLowerCase());
}

const requirePlatformOwner = (req, res, next) => {
  const user = req.user;
  if (!user || user.impersonator || !isPlatformOwner(user.email)) {
    return res.status(403).json({ status: 'failed', message: 'Forbidden' });
  }
  next();
};

requirePlatformOwner.isPlatformOwner = isPlatformOwner;
requirePlatformOwner.ownerEmails = ownerEmails;

module.exports = requirePlatformOwner;
