const perms = require('../../../config/permissions');

describe('config/permissions', () => {
  it('has 15 unique keys, each in a known group', () => {
    expect(perms.KEYS).toHaveLength(15);
    expect(new Set(perms.KEYS).size).toBe(15);
    const groups = new Set(perms.GROUPS.map((g) => g.id));
    perms.PERMISSIONS.forEach((p) => {
      expect(groups.has(p.group)).toBe(true);
      expect(p.label).toBeTruthy();
      expect(p.description).toBeTruthy();
    });
  });

  it('gives the built-in Admin every key', () => {
    expect(perms.ADMIN_DEFAULT).toEqual(perms.KEYS);
  });

  it("keeps today's teacher access: students, analytics, report cards and general attendance", () => {
    expect([...perms.TEACHER_DEFAULT].sort()).toEqual(['analytics', 'attendance.daily', 'report_cards', 'students']);
    perms.TEACHER_DEFAULT.forEach((k) => expect(perms.isKnownPermission(k)).toBe(true));
  });

  it('builds the Office Staff preset without classes, analytics or finance', () => {
    expect(perms.OFFICE_STAFF_PRESET).toEqual([
      'report_cards', 'students', 'users', 'attendance.daily', 'attendance.classes', 'staff_attendance',
      'messages.all', 'announcements.school', 'forms', 'scheduling', 'school_setup',
    ]);
  });

  describe('normalizePermissions', () => {
    it('dedupes, trims and returns catalog order', () => {
      expect(perms.normalizePermissions([' forms', 'students', 'forms'])).toEqual({ valid: ['students', 'forms'], unknown: [] });
    });

    it('reports unknown keys', () => {
      expect(perms.normalizePermissions(['students', 'roles.manage', 7]).unknown).toEqual(['roles.manage', 7]);
    });

    it('flags anything that is not an array', () => {
      expect(perms.normalizePermissions('students')).toEqual({ valid: [], unknown: [], notArray: true });
    });
  });

  it('describes the catalog for the roles editor', () => {
    const catalog = perms.catalogForApi();
    expect(catalog.permissions).toHaveLength(15);
    expect(catalog.builtIns.map((b) => b.id)).toEqual(['admin', 'teacher']);
    expect(catalog.presets[0]).toEqual({ id: 'office-staff', name: 'Office Staff', permissions: [...perms.OFFICE_STAFF_PRESET] });
  });

  it('reserves the built-in names', () => {
    expect(perms.RESERVED_ROLE_NAMES.has('admin')).toBe(true);
    expect(perms.RESERVED_ROLE_NAMES.has('teacher')).toBe(true);
  });
});
