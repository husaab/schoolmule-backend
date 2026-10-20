// services/access/access.js
//
// What a signed-in request may do. Resolved per request from the database
// (accessStore), never from the JWT, so a role edit applies on the next
// request and an archived account loses access at once instead of keeping a
// working token for days.
//
//   buildAccess(row, view)  pure: the permission set for an account row
//   ensureAccess(req)       resolves once per request onto req.access
//   can / canAny / isFullAdmin   sync checks once req.access is set
//
// Only staff views carry permissions. A PARENT or STUDENT view has none and
// skips the database: those portals have their own guards (requireParent,
// the student fence).

const perms = require('../../config/permissions');
const store = require('./accessStore');
const logger = require('../../logger');

const STAFF_BASES = new Set(['ADMIN', 'TEACHER']);
const NON_STAFF_VIEWS = new Set(['PARENT', 'STUDENT']);

class AccessRevokedError extends Error {
  constructor(code = 'SESSION_REVOKED') {
    super(code);
    this.code = code;
    this.status = code === 'ACCOUNT_NOT_VERIFIED' ? 403 : 401;
  }
}

const make = (fields) => Object.freeze({
  userId: null,
  school: null,
  baseRole: null,
  view: null,
  isStaffView: false,
  isFullAdmin: false,
  permissions: new Set(),
  staffRoleId: null,
  roleName: null,
  ...fields,
});

/** Pure. row: an accessStore row or null; view: the token's active `role`. */
function buildAccess(row, view) {
  const base = row?.base_role ?? null;
  const common = { userId: row?.user_id ?? null, school: row?.school ?? null, baseRole: base, view };
  if (!row || NON_STAFF_VIEWS.has(view) || !STAFF_BASES.has(base)) return make(common);

  const staff = { ...common, isStaffView: true };
  if (row.staff_role_id) {
    // A role that went missing (or belongs to another school) grants nothing:
    // fail closed, never fall back to the built-in.
    const granted = row.role_found ? (row.permissions || []).filter(perms.isKnownPermission) : [];
    return make({ ...staff, permissions: new Set(granted), staffRoleId: row.staff_role_id, roleName: row.role_name ?? null });
  }
  if (base === 'ADMIN') {
    return make({ ...staff, isFullAdmin: true, permissions: new Set(perms.ADMIN_DEFAULT), roleName: 'Admin' });
  }
  return make({ ...staff, permissions: new Set(perms.TEACHER_DEFAULT), roleName: 'Teacher' });
}

/** Memoized on req.access. Throws AccessRevokedError for a dead session. */
async function ensureAccess(req) {
  if (req.access) return req.access;
  if (!req.user || !req.user.userId) throw new AccessRevokedError();
  if (NON_STAFF_VIEWS.has(req.user.role)) {
    req.access = buildAccess(null, req.user.role);
    return req.access;
  }
  const row = await store.fetchAccessRow(req.user);
  if (!row || row.is_archived || row.school !== req.user.school) throw new AccessRevokedError();
  if (row.base_role !== 'ADMIN' && !row.is_verified_school) throw new AccessRevokedError('ACCOUNT_NOT_VERIFIED');
  req.access = buildAccess(row, req.user.role);
  return req.access;
}

/**
 * Fresh (uncached) access for a session payload: sign-in, /me, view switch,
 * preview. who = { userId, school, baseRole }; view = the session's active role.
 */
async function accessForSession(who, view) {
  if (NON_STAFF_VIEWS.has(view)) return buildAccess(null, view);
  const row = await store.fetchAccessRow({ ...who, role: view }, { fresh: true });
  return buildAccess(row && row.school === who.school ? row : null, view);
}

const assertKey = (key) => {
  if (!perms.isKnownPermission(key)) throw new Error(`Unknown permission key: ${key}`);
};

// Fail closed: no req.access means no permission.
const can = (req, key) => {
  assertKey(key);
  return Boolean(req.access && req.access.permissions.has(key));
};
const canAny = (req, ...keys) => keys.some((k) => can(req, k));
const isFullAdmin = (req) => Boolean(req.access && req.access.isFullAdmin);
const isStaffView = (req) => Boolean(req.access && req.access.isStaffView);

/**
 * Some SQL still branches on "$role = 'ADMIN'" to mean "sees the whole
 * school". Callers pass this instead of req.user.role, so a restricted admin
 * is treated as a teacher there unless they hold the key that covers it.
 */
const effectiveRole = (req, key) => {
  if (req.user && req.user.role === 'ADMIN') return can(req, key) ? 'ADMIN' : 'TEACHER';
  if (req.user && req.user.role === 'TEACHER' && can(req, key)) return 'ADMIN';
  return req.user ? req.user.role : null;
};

/** The JSON a session carries to the frontend (UI hints only; the API decides). */
const accessPayload = (access) => ({
  permissions: [...access.permissions],
  isFullAdmin: access.isFullAdmin,
  // "access role" in the API: the frontend already uses staffRole for a job title.
  accessRole: access.staffRoleId ? { id: access.staffRoleId, name: access.roleName } : null,
});

const accessErrorResponse = (res, err) => {
  if (err instanceof AccessRevokedError) {
    return res.status(err.status).json({
      success: false,
      status: 'failed',
      code: err.code,
      message: err.code === 'ACCOUNT_NOT_VERIFIED'
        ? 'Access denied: account not fully verified.'
        : 'Your session is no longer valid. Please sign in again.',
    });
  }
  logger.error({ err }, 'Access resolution failed');
  return res.status(500).json({ success: false, status: 'failed', message: 'Could not check your access' });
};

module.exports = {
  buildAccess,
  ensureAccess,
  accessForSession,
  assertKey,
  can,
  canAny,
  isFullAdmin,
  isStaffView,
  effectiveRole,
  accessPayload,
  accessErrorResponse,
  AccessRevokedError,
};
