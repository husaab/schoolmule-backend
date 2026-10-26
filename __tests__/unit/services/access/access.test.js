const perms = require('../../../../config/permissions');
const store = require('../../../../services/access/accessStore');
const {
  buildAccess, ensureAccess, accessForSession, can, canAny, isFullAdmin, effectiveRole, accessPayload,
  AccessRevokedError,
} = require('../../../../services/access/access');
const { giveRole, giveDanglingRole, archive, setRow, ROLE_ID } = require('../../../helpers/mockAccess');

const row = (fields = {}) => ({
  user_id: 'u1', school: 'ALHAADIACADEMY', base_role: 'ADMIN', is_archived: false, is_verified_school: true,
  staff_role_id: null, role_found: false, role_name: null, permissions: null, ...fields,
});
const reqFor = (user) => ({ user: { userId: 'u1', school: 'ALHAADIACADEMY', role: 'ADMIN', ...user } });

describe('buildAccess', () => {
  it('makes a built-in admin a full admin with every key', () => {
    const a = buildAccess(row(), 'ADMIN');
    expect(a.isFullAdmin).toBe(true);
    expect(a.isStaffView).toBe(true);
    expect([...a.permissions]).toEqual(perms.KEYS);
    expect(a.roleName).toBe('Admin');
  });

  it('gives a built-in teacher the teacher default', () => {
    const a = buildAccess(row({ base_role: 'TEACHER' }), 'TEACHER');
    expect(a.isFullAdmin).toBe(false);
    expect([...a.permissions]).toEqual([...perms.TEACHER_DEFAULT]);
  });

  it('gives an admin with a custom role exactly that role, and no full-admin powers', () => {
    const a = buildAccess(row({ staff_role_id: ROLE_ID, role_found: true, role_name: 'Office Staff', permissions: ['students', 'forms'] }), 'ADMIN');
    expect(a.isFullAdmin).toBe(false);
    expect([...a.permissions]).toEqual(['students', 'forms']);
    expect(a.roleName).toBe('Office Staff');
    expect(a.staffRoleId).toBe(ROLE_ID);
  });

  it('can widen a teacher with a custom role', () => {
    const a = buildAccess(row({ base_role: 'TEACHER', staff_role_id: ROLE_ID, role_found: true, permissions: ['finance'] }), 'TEACHER');
    expect([...a.permissions]).toEqual(['finance']);
  });

  it('fails closed when the role row is missing', () => {
    const a = buildAccess(row({ staff_role_id: ROLE_ID, role_found: false }), 'ADMIN');
    expect(a.permissions.size).toBe(0);
    expect(a.isFullAdmin).toBe(false);
  });

  it('drops unknown stored keys', () => {
    const a = buildAccess(row({ staff_role_id: ROLE_ID, role_found: true, permissions: ['students', 'roles.manage'] }), 'ADMIN');
    expect([...a.permissions]).toEqual(['students']);
  });

  it('gives parent and student views nothing', () => {
    expect(buildAccess(row(), 'PARENT').permissions.size).toBe(0);
    expect(buildAccess(row(), 'PARENT').isStaffView).toBe(false);
    expect(buildAccess(null, 'STUDENT').isStaffView).toBe(false);
  });
});

describe('ensureAccess', () => {
  it('resolves once per request', async () => {
    const req = reqFor({});
    const a = await ensureAccess(req);
    expect(await ensureAccess(req)).toBe(a);
    expect(store.fetchAccessRow).toHaveBeenCalledTimes(1);
  });

  it('gives a parent or student view no permissions, whatever the row says', async () => {
    const parent = await ensureAccess(reqFor({ role: 'PARENT' }));
    const student = await ensureAccess(reqFor({ role: 'STUDENT' }));
    expect(parent.isStaffView).toBe(false);
    expect(student.isStaffView).toBe(false);
  });

  it("ends an archived (or deleted) parent's or student's session too", async () => {
    archive('u1');
    await expect(ensureAccess(reqFor({ role: 'PARENT' }))).rejects.toBeInstanceOf(AccessRevokedError);
    await expect(ensureAccess(reqFor({ role: 'STUDENT' }))).rejects.toBeInstanceOf(AccessRevokedError);
  });

  it('revokes an archived account at once', async () => {
    archive('u1');
    await expect(ensureAccess(reqFor({}))).rejects.toMatchObject({ code: 'SESSION_REVOKED', status: 401 });
  });

  it('revokes a token whose account moved school', async () => {
    setRow('u1', { school: 'PLAYGROUND' });
    await expect(ensureAccess(reqFor({}))).rejects.toBeInstanceOf(AccessRevokedError);
  });

  it('refuses a teacher whose school approval was withdrawn', async () => {
    setRow('u1', { base_role: 'TEACHER', is_verified_school: false });
    await expect(ensureAccess(reqFor({ role: 'TEACHER' }))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_VERIFIED', status: 403 });
  });

  it('applies a custom role from the database, not the token', async () => {
    giveRole('u1', ['users']);
    const req = reqFor({});
    await ensureAccess(req);
    expect(can(req, 'users')).toBe(true);
    expect(can(req, 'finance')).toBe(false);
    expect(isFullAdmin(req)).toBe(false);
  });

  it('treats a dangling role as no permissions', async () => {
    giveDanglingRole('u1');
    const req = reqFor({});
    await ensureAccess(req);
    expect(req.access.permissions.size).toBe(0);
  });
});

describe('accessForSession', () => {
  it('reads fresh and builds the active view', async () => {
    giveRole('u1', ['forms'], 'Office Staff');
    const a = await accessForSession({ userId: 'u1', school: 'ALHAADIACADEMY', baseRole: 'ADMIN' }, 'ADMIN');
    expect(store.fetchAccessRow).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), { fresh: true });
    expect(accessPayload(a)).toEqual({ permissions: ['forms'], isFullAdmin: false, accessRole: { id: ROLE_ID, name: 'Office Staff' } });
  });

  it('is empty for a parent view without a lookup', async () => {
    const a = await accessForSession({ userId: 'u1', school: 'ALHAADIACADEMY', baseRole: 'ADMIN' }, 'PARENT');
    expect(accessPayload(a)).toEqual({ permissions: [], isFullAdmin: false, accessRole: null });
    expect(store.fetchAccessRow).not.toHaveBeenCalled();
  });
});

describe('can and friends', () => {
  it('fail closed without req.access', () => {
    expect(can({}, 'students')).toBe(false);
    expect(isFullAdmin({})).toBe(false);
  });

  it('throw on a mistyped key', () => {
    expect(() => can({}, 'student')).toThrow('Unknown permission key: student');
  });

  it('canAny passes on any key', async () => {
    giveRole('u1', ['forms']);
    const req = reqFor({});
    await ensureAccess(req);
    expect(canAny(req, 'finance', 'forms')).toBe(true);
    expect(canAny(req, 'finance', 'analytics')).toBe(false);
  });
});

describe('effectiveRole', () => {
  it('keeps a full admin an admin', async () => {
    const req = reqFor({});
    await ensureAccess(req);
    expect(effectiveRole(req, 'messages.all')).toBe('ADMIN');
  });

  it('treats a restricted admin without the key as a teacher', async () => {
    giveRole('u1', ['forms']);
    const req = reqFor({});
    await ensureAccess(req);
    expect(effectiveRole(req, 'messages.all')).toBe('TEACHER');
  });

  it('lifts a teacher holding the key', async () => {
    giveRole('u1', ['messages.all']);
    const req = reqFor({ role: 'TEACHER' });
    setRow('u1', { base_role: 'TEACHER', staff_role_id: ROLE_ID, role_found: true, permissions: ['messages.all'] });
    await ensureAccess(req);
    expect(effectiveRole(req, 'messages.all')).toBe('ADMIN');
  });

  it('leaves a parent a parent', async () => {
    const req = reqFor({ role: 'PARENT' });
    await ensureAccess(req);
    expect(effectiveRole(req, 'messages.all')).toBe('PARENT');
  });
});
