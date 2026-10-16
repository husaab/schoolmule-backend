const {
  STUDENT_ALLOWED,
  pathOf,
  isStudentAllowed,
  isStudentToken,
} = require('../../../middleware/studentFence');

describe('studentFence', () => {
  describe('isStudentAllowed', () => {
    it.each([
      '/api/student',
      '/api/student/home',
      '/api/student/classes/abc/stream',
      '/api/profile',
      '/api/profile/avatar',
      '/api/observe/client-events',
    ])('allows %s', (path) => {
      expect(isStudentAllowed(path)).toBe(true);
    });

    it.each([
      '/api/students',             // prefix boundary: not /api/student
      '/api/students/abc',
      '/api/student-views',        // prefix boundary with a dash
      '/api/studentAssessments',
      '/api/profiles',
      '/api/messaging/conversations',
      '/api/classes',
      '/api/observe',              // the owner console, not the beacon
      '/api/observe/events',
      '/api/observe/client-events/x', // the beacon is an exact path, not a prefix
      '/api/observe/client-events-x',
      '/api/auth/view',
      '/',
      '',
    ])('refuses %s', (path) => {
      expect(isStudentAllowed(path)).toBe(false);
    });

    it('is a frozen allowlist of exactly the three student-safe prefixes', () => {
      expect(Object.isFrozen(STUDENT_ALLOWED)).toBe(true);
      expect([...STUDENT_ALLOWED]).toEqual(['/api/student', '/api/profile', '/api/observe/client-events']);
    });
  });

  describe('pathOf', () => {
    it('drops the query string and trailing slashes', () => {
      expect(pathOf({ originalUrl: '/api/student/?x=1' })).toBe('/api/student');
      expect(pathOf({ originalUrl: '/api/student//' })).toBe('/api/student');
    });

    it('prefers originalUrl (the full path) over a router-relative url', () => {
      expect(pathOf({ originalUrl: '/api/classes/1', url: '/1' })).toBe('/api/classes/1');
    });

    it('falls back to url, then to the root', () => {
      expect(pathOf({ url: '/api/profile?y=2' })).toBe('/api/profile');
      expect(pathOf({})).toBe('/');
      expect(pathOf({ originalUrl: '/' })).toBe('/');
    });

    it('cannot be tricked by a query string that names an allowed prefix', () => {
      expect(isStudentAllowed(pathOf({ originalUrl: '/api/classes?next=/api/student' }))).toBe(false);
    });
  });

  describe('isStudentToken', () => {
    it('is true for a STUDENT role', () => {
      expect(isStudentToken({ role: 'STUDENT' })).toBe(true);
    });

    it('is true when only the base role is STUDENT (a forged or future view switch)', () => {
      expect(isStudentToken({ role: 'TEACHER', baseRole: 'STUDENT' })).toBe(true);
    });

    it.each([
      [{ role: 'ADMIN' }],
      [{ role: 'TEACHER' }],
      [{ role: 'PARENT', baseRole: 'TEACHER' }],
      [{}],
      [null],
      [undefined],
    ])('is false for %p', (decoded) => {
      expect(isStudentToken(decoded)).toBe(false);
    });
  });
});
