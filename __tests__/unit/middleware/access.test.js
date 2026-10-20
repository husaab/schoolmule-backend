const {
  attachAccess, requirePermission, requireStaffAccess, requireStaffRead, requireFullAdmin, classAccessGranted,
} = require('../../../middleware/access');
const { ensureAccess } = require('../../../services/access/access');
const { giveRole, archive } = require('../../helpers/mockAccess');

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const reqFor = (user, method = 'GET') => ({ method, user: { userId: 'u1', school: 'ALHAADIACADEMY', role: 'ADMIN', ...user } });

const run = async (mw, req) => {
  const res = makeRes();
  const next = jest.fn();
  await mw(req, res, next);
  return { res, next };
};

describe('middleware/access', () => {
  it('attachAccess resolves access and stops a revoked session', async () => {
    const ok = await run(attachAccess, reqFor({}));
    expect(ok.next).toHaveBeenCalled();

    archive('u1');
    const { res, next } = await run(attachAccess, reqFor({}));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
  });

  describe('requirePermission', () => {
    it('passes on any listed key', async () => {
      giveRole('u1', ['forms']);
      const { next } = await run(requirePermission('finance', 'forms'), reqFor({}));
      expect(next).toHaveBeenCalled();
    });

    it('refuses with PERMISSION_DENIED', async () => {
      giveRole('u1', ['forms']);
      const { res, next } = await run(requirePermission('finance'), reqFor({}));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'PERMISSION_DENIED', required: ['finance'] });
    });

    it('refuses a parent view', async () => {
      const { res } = await run(requirePermission('students'), reqFor({ role: 'PARENT' }));
      expect(res.statusCode).toBe(403);
    });

    it('throws at mount on a mistyped key', () => {
      expect(() => requirePermission('finances')).toThrow('Unknown permission key');
    });
  });

  it('requireStaffAccess lets staff in and keeps parents out', async () => {
    giveRole('u1', []);
    expect((await run(requireStaffAccess, reqFor({}))).next).toHaveBeenCalled();
    expect((await run(requireStaffAccess, reqFor({ userId: 'p1', role: 'PARENT' }))).res.statusCode).toBe(403);
  });

  it('requireStaffRead opens reads to staff and gates writes', async () => {
    giveRole('u1', []);
    const gate = requireStaffRead('school_setup');
    expect((await run(gate, reqFor({}, 'GET'))).next).toHaveBeenCalled();
    expect((await run(gate, reqFor({}, 'POST'))).res.statusCode).toBe(403);
    expect((await run(gate, reqFor({ userId: 'p1', role: 'PARENT' }, 'GET'))).res.statusCode).toBe(403);
  });

  it('requireFullAdmin refuses a restricted admin', async () => {
    expect((await run(requireFullAdmin, reqFor({}))).next).toHaveBeenCalled();
    giveRole('u2', ['users']);
    const { res } = await run(requireFullAdmin, reqFor({ userId: 'u2' }));
    expect(res.body.code).toBe('FULL_ADMIN_REQUIRED');
  });

  describe('classAccessGranted', () => {
    const cls = (fields = {}) => ({ school: 'ALHAADIACADEMY', teacher_id: 'lead', is_co_teacher: false, ...fields });

    it('lets in the lead and co-teachers whatever their role', async () => {
      giveRole('lead', []);
      const req = reqFor({ userId: 'lead' });
      await ensureAccess(req);
      expect(classAccessGranted(req, cls())).toBe(true);
      expect(classAccessGranted(req, cls({ teacher_id: 'other', is_co_teacher: true }))).toBe(true);
    });

    it('lets in classes.all holders and the extra keys, never another school', async () => {
      giveRole('u1', ['attendance.classes']);
      const req = reqFor({});
      await ensureAccess(req);
      expect(classAccessGranted(req, cls())).toBe(false);
      expect(classAccessGranted(req, cls(), ['attendance.classes'])).toBe(true);

      const admin = reqFor({ userId: 'u3' });
      await ensureAccess(admin);
      expect(classAccessGranted(admin, cls())).toBe(true);
      expect(classAccessGranted(admin, cls({ school: 'PLAYGROUND' }))).toBe(false);
    });

    it('keeps a teacher out of a class they do not teach', async () => {
      const req = reqFor({ userId: 't2', role: 'TEACHER' });
      await ensureAccess(req);
      expect(classAccessGranted(req, cls())).toBe(false);
    });
  });
});
