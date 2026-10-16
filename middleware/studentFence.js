// middleware/studentFence.js
//
// Deny-by-default for STUDENT tokens (spec §5, risk 1). A student token may
// reach only these prefixes; every other path is refused inside verifyUser,
// before any route code runs, so a staff route that forgot its own guard can
// never leak school data to a student. Extend this list only with routers
// whose every query is keyed on req.student (requireStudent) or req.user.
const STUDENT_ALLOWED = Object.freeze([
  '/api/student',                // the student portal API (requireStudent inside)
  '/api/profile',                // the caller's own avatar and photo
  '/api/observe/client-events',  // browser error reports (tokenOnly mount)
]);

const pathOf = (req) => {
  const raw = String(req.originalUrl || req.url || '').split('?')[0];
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
};
const underPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
const isStudentAllowed = (path) => STUDENT_ALLOWED.some((p) => underPrefix(path, p));
// baseRole too: a forged or future view-switch must not lift the fence.
const isStudentToken = (decoded) => decoded?.role === 'STUDENT' || decoded?.baseRole === 'STUDENT';

module.exports = { STUDENT_ALLOWED, pathOf, isStudentAllowed, isStudentToken };
