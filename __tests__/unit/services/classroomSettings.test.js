const { DEFAULTS, validateSettings } = require('../../../services/classroom/classroomSettings');

// The body main's frontend sends: every original key, none of the new ones.
const mainBody = {
  enabled: true, loginFromGrade: '1', qrUntilGrade: '3', studentEmailFromGrade: '1',
  parentsReadPrivateComments: true, summaryDow: 5, studentPhotos: false, consentNoticeVersion: '2026-10',
};
const current = { ...DEFAULTS, studentEmailDomains: ['students.example.org'], studentSignIn: 'google_only' };

describe('validateSettings', () => {
  it("keeps main's body valid: without studentEmailDomains/studentSignIn it keeps the current values", () => {
    const { value, error } = validateSettings(mainBody, current);
    expect(error).toBeUndefined();
    expect(value).toMatchObject({ studentEmailDomains: ['students.example.org'], studentSignIn: 'google_only' });
  });

  it('defaults the new keys when there is nothing saved', () => {
    const { value } = validateSettings(mainBody, DEFAULTS);
    expect(value).toMatchObject({ studentEmailDomains: [], studentSignIn: 'google_or_password' });
  });

  it('lowercases, trims and de-duplicates domains', () => {
    const { value } = validateSettings(
      { ...mainBody, studentEmailDomains: [' Students.Example.org ', 'students.example.org', 'staff.example.org'] },
      DEFAULTS,
    );
    expect(value.studentEmailDomains).toEqual(['students.example.org', 'staff.example.org']);
  });

  it.each([['not a domain'], ['@example.org'], ['example'], ['a@b.org']])('rejects %p as a domain', (bad) => {
    expect(validateSettings({ ...mainBody, studentEmailDomains: [bad] }, DEFAULTS)).toEqual({
      error: 'studentEmailDomains must be domain names like students.example.org',
    });
  });

  it('rejects more than 5 domains and a non-array', () => {
    const six = ['a.org', 'b.org', 'c.org', 'd.org', 'e.org', 'f.org'];
    expect(validateSettings({ ...mainBody, studentEmailDomains: six }, DEFAULTS).error).toBe('studentEmailDomains can list up to 5 domains');
    expect(validateSettings({ ...mainBody, studentEmailDomains: 'a.org' }, DEFAULTS).error)
      .toBe('studentEmailDomains must be domain names like students.example.org');
  });

  it('rejects a studentSignIn outside the two values', () => {
    expect(validateSettings({ ...mainBody, studentSignIn: 'password_only' }, DEFAULTS)).toEqual({
      error: "studentSignIn must be 'google_or_password' or 'google_only'",
    });
  });
});

// The parents' weekly summary has its own switch (owner, 2026-10-19); the
// consent notice version is no longer shown, so a body may leave it out.
describe('validateSettings: parentSummary and consentNoticeVersion', () => {
  it('parentSummary is off by default and kept when a body leaves it out', () => {
    expect(DEFAULTS.parentSummary).toBe(false);
    expect(validateSettings(mainBody, DEFAULTS).value.parentSummary).toBe(false);
    expect(validateSettings(mainBody, { ...current, parentSummary: true }).value.parentSummary).toBe(true);
  });

  it('parentSummary can be turned on or off on its own, whatever the student portal switch says', () => {
    expect(validateSettings({ ...mainBody, enabled: false, parentSummary: true }, DEFAULTS).value).toMatchObject({ enabled: false, parentSummary: true });
    expect(validateSettings({ ...mainBody, parentSummary: false }, { ...current, parentSummary: true }).value.parentSummary).toBe(false);
    expect(validateSettings({ ...mainBody, parentSummary: 'yes' }, DEFAULTS).error).toBe('parentSummary must be true or false');
  });

  it('a body without consentNoticeVersion keeps the saved one', () => {
    const { consentNoticeVersion, ...withoutVersion } = mainBody;
    expect(consentNoticeVersion).toBe('2026-10');
    expect(validateSettings(withoutVersion, { ...current, consentNoticeVersion: '2027-01' }).value.consentNoticeVersion).toBe('2027-01');
    expect(validateSettings(withoutVersion, DEFAULTS).value.consentNoticeVersion).toBe('2026-10');
  });
});
