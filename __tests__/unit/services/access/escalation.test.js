const { checkTouch, checkEdit, checkInvite, checkImpersonate, isFullAdminRow } = require('../../../../services/access/escalation');

const FULL = { isFullAdmin: true };
const OFFICE = { isFullAdmin: false }; // a `users` holder without full-admin powers

const fullAdmin = { user_id: 'a1', role: 'ADMIN', staff_role_id: null };
const restrictedAdmin = { user_id: 'a2', role: 'ADMIN', staff_role_id: 'r1' };
const teacher = { user_id: 't1', role: 'TEACHER', staff_role_id: null };
const parent = { user_id: 'p1', role: 'PARENT', staff_role_id: null };
const student = { user_id: 's1', role: 'STUDENT', staff_role_id: null };

describe('escalation', () => {
  it('knows a full admin row', () => {
    expect(isFullAdminRow(fullAdmin)).toBe(true);
    expect(isFullAdminRow(restrictedAdmin)).toBe(false);
    expect(isFullAdminRow(teacher)).toBe(false);
  });

  describe('checkTouch', () => {
    it('lets a full admin touch anyone', () => {
      [fullAdmin, restrictedAdmin, teacher].forEach((t) => expect(checkTouch(FULL, t).ok).toBe(true));
    });

    it('keeps a users holder off full admins only', () => {
      expect(checkTouch(OFFICE, fullAdmin)).toMatchObject({ ok: false, status: 403 });
      expect(checkTouch(OFFICE, restrictedAdmin).ok).toBe(true);
      expect(checkTouch(OFFICE, teacher).ok).toBe(true);
    });
  });

  describe('checkEdit', () => {
    const same = (t) => ({ role: t.role, staffRoleProvided: false });

    it('allows a users holder to edit a teacher without changing access', () => {
      expect(checkEdit(OFFICE, 'x', teacher, same(teacher)).ok).toBe(true);
    });

    it('refuses promoting to admin', () => {
      expect(checkEdit(OFFICE, 'x', teacher, { role: 'ADMIN' }).ok).toBe(false);
      expect(checkEdit(FULL, 'x', teacher, { role: 'ADMIN' }).ok).toBe(true);
    });

    it('refuses giving, changing or clearing an access role', () => {
      expect(checkEdit(OFFICE, 'x', teacher, { role: 'TEACHER', staffRoleProvided: true, staffRoleId: 'r1' }).ok).toBe(false);
      expect(checkEdit(OFFICE, 'x', restrictedAdmin, { role: 'ADMIN', staffRoleProvided: true, staffRoleId: null }).ok).toBe(false);
      // Sending the same value back is not a change.
      expect(checkEdit(OFFICE, 'x', restrictedAdmin, { role: 'ADMIN', staffRoleProvided: true, staffRoleId: 'r1' }).ok).toBe(true);
    });

    it('refuses changing your own role', () => {
      expect(checkEdit(OFFICE, 'a2', restrictedAdmin, { role: 'TEACHER' }).ok).toBe(false);
    });

    it('refuses editing a full admin', () => {
      expect(checkEdit(OFFICE, 'x', fullAdmin, same(fullAdmin)).ok).toBe(false);
    });
  });

  describe('checkInvite', () => {
    it('lets a users holder invite teachers and parents only', () => {
      expect(checkInvite(OFFICE, { role: 'TEACHER' }).ok).toBe(true);
      expect(checkInvite(OFFICE, { role: 'PARENT' }).ok).toBe(true);
      expect(checkInvite(OFFICE, { role: 'ADMIN' }).ok).toBe(false);
      expect(checkInvite(OFFICE, { role: 'TEACHER', staffRoleId: 'r1' }).ok).toBe(false);
      expect(checkInvite(FULL, { role: 'ADMIN', staffRoleId: 'r1' }).ok).toBe(true);
    });
  });

  describe('checkImpersonate', () => {
    it('never previews a full admin', () => {
      expect(checkImpersonate(FULL, fullAdmin).ok).toBe(false);
    });

    it('lets a full admin preview teachers, parents, students and restricted admins', () => {
      [restrictedAdmin, teacher, parent, student].forEach((t) => expect(checkImpersonate(FULL, t).ok).toBe(true));
    });

    it('lets a users holder preview students only', () => {
      expect(checkImpersonate(OFFICE, student).ok).toBe(true);
      [restrictedAdmin, teacher, parent].forEach((t) => expect(checkImpersonate(OFFICE, t).ok).toBe(false));
    });
  });
});
