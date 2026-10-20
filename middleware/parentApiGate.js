// middleware/parentApiGate.js
//
// Defense in depth for the parent portal: a PARENT view may only reach the
// API areas the parent portal uses. Staff routers carry their own permission
// guards; this catches any staff route that still lacks one. (STUDENT tokens
// are fenced earlier, inside verifyUser.)
//
// RBAC_PARENT_GATE=log (default) only logs what it would block, so a missed
// parent call shows up in /observe instead of breaking the portal;
// RBAC_PARENT_GATE=enforce refuses it with 403.

const logger = require('../logger');

// Areas the parent portal calls (services used under app/(user)/parent, the
// navbar, messaging, announcements, settings and the session itself).
const PARENT_ALLOWED = [
  '/api/auth',
  '/api/parent-portal',
  '/api/parent-students',
  '/api/messaging',
  '/api/announcements',
  '/api/report-cards',
  '/api/progress-reports',
  '/api/terms',
  '/api/calendar-events',
  '/api/patch-notes',
  '/api/school-years',
  '/api/schools',
  '/api/school-assets',
  '/api/staff',
  '/api/schedule-planner',
  '/api/users',
  '/api/profile',
];

const allowedForParent = (path) => PARENT_ALLOWED.some((p) => path === p || path.startsWith(`${p}/`));

const pathOf = (req) => (req.originalUrl || req.url || '').split('?')[0];

const parentApiGate = (req, res, next) => {
  if (!req.access || req.access.view !== 'PARENT') return next();
  const path = pathOf(req);
  if (allowedForParent(path)) return next();

  if (process.env.RBAC_PARENT_GATE === 'enforce') {
    return res.status(403).json({ success: false, status: 'failed', code: 'PERMISSION_DENIED', message: "You don't have permission to do that." });
  }
  logger.warn({ rbacParentGate: true, method: req.method, path, userId: req.user && req.user.userId }, 'Parent token reached a staff API (log mode)');
  return next();
};

module.exports = parentApiGate;
module.exports.allowedForParent = allowedForParent;
module.exports.PARENT_ALLOWED = PARENT_ALLOWED;
