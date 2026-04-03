const { getSchoolName, schoolDisplayNames } = require('../../../utils/schoolUtils');

describe('schoolUtils', () => {
  describe('getSchoolName', () => {
    it('returns mapped name for ALHAADIACADEMY', () => {
      expect(getSchoolName('ALHAADIACADEMY')).toBe('Al Haadi Academy');
    });

    it('returns mapped name for PLAYGROUND', () => {
      expect(getSchoolName('PLAYGROUND')).toBe('Playground School');
    });

    it('falls back to formatted name for unknown school codes', () => {
      expect(getSchoolName('MY_NEW_SCHOOL')).toBe('My New School');
    });

    it('handles single-word unknown codes', () => {
      expect(getSchoolName('TESTSCHOOL')).toBe('Testschool');
    });
  });

  describe('schoolDisplayNames', () => {
    it('exports the mapping object', () => {
      expect(schoolDisplayNames).toBeDefined();
      expect(schoolDisplayNames.ALHAADIACADEMY).toBe('Al Haadi Academy');
      expect(schoolDisplayNames.PLAYGROUND).toBe('Playground School');
    });
  });
});
