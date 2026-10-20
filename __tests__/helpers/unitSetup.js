// supertest's servers listen on 127.0.0.1 only (see the helper; M8 flakes).
require('./loopbackListen');

// Set env vars BEFORE any controller modules load
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-unit-tests';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test_resend_key';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
process.env.BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
process.env.CROSS_ORIGIN_URL = process.env.CROSS_ORIGIN_URL || 'http://localhost:3000';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-service-role-key';
process.env.SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'test@test.com';
process.env.MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'test.com';
// Observe capture is off in unit tests: its fire-and-forget last_seen UPDATE
// would otherwise consume a response another test queued for its controller.
process.env.OBSERVE_DISABLED = 'true';

// RBAC: the real access resolver reads users + staff_roles. Unit tests derive
// the row from the token claims instead, so it never consumes a response a
// test queued on the db mock. ADMIN tokens are full admins, TEACHER (and the
// legacy 'STAFF' fixture) get the teacher default. Override per user with
// helpers/mockAccess.js.
jest.mock('../../services/access/accessStore', () => {
  const actual = jest.requireActual('../../services/access/accessStore');
  const rows = new Map();
  const STAFF_BASES = ['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'];
  return {
    ...actual,
    __rows: rows,
    invalidateUser: jest.fn(),
    invalidateAll: jest.fn(),
    fetchAccessRow: jest.fn(async (who) => {
      const claimRole = who.baseRole ?? who.role;
      return {
        user_id: who.userId,
        school: who.school,
        base_role: STAFF_BASES.includes(claimRole) ? claimRole : 'TEACHER',
        is_archived: false,
        is_verified_school: true,
        staff_role_id: null,
        role_found: false,
        role_name: null,
        permissions: null,
        ...(rows.get(who.userId) || {}),
      };
    }),
    // Teachers teach; override with mockAccess.setRow(id, { teaches: true }).
    teachesAnyClass: jest.fn(async (who) => {
      const override = rows.get(who.userId);
      if (override && 'teaches' in override) return override.teaches;
      return (who.baseRole ?? who.role) === 'TEACHER';
    }),
  };
});

// Global afterEach for unit tests - resets all mocks between tests
const db = require('../__mocks__/config/database');
const supabase = require('../__mocks__/config/supabaseClient');

afterEach(() => {
  db._reset();
  supabase._reset();
  require('../../services/access/accessStore').__rows.clear();
  jest.clearAllMocks();
});
