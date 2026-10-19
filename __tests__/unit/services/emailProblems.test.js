const {
  isOutsideDomain, mentionsName, conflictMessage, problemsFor,
} = require('../../../services/classroom/emailProblems');

describe('isOutsideDomain', () => {
  const domains = ['students.example.org'];
  it('is false on a declared domain, in any case', () => {
    expect(isOutsideDomain('a@students.example.org', domains)).toBe(false);
    expect(isOutsideDomain('a@Students.Example.ORG', domains)).toBe(false);
  });
  it('is true elsewhere, including a subdomain or a look-alike', () => {
    expect(isOutsideDomain('a@gmail.com', domains)).toBe(true);
    expect(isOutsideDomain('a@x.students.example.org', domains)).toBe(true);
    expect(isOutsideDomain('a@students.example.org.evil.com', domains)).toBe(true);
  });
  it('is false when the school declares no domain', () => {
    expect(isOutsideDomain('a@gmail.com', [])).toBe(false);
    expect(isOutsideDomain('a@gmail.com', undefined)).toBe(false);
  });
});

describe('mentionsName', () => {
  it('finds a 3+ letter name part in the local part', () => {
    expect(mentionsName('amal.haddad@x.org', 'Amal Haddad')).toBe(true);
    expect(mentionsName('ahaddad7@x.org', 'Amal Haddad')).toBe(true);
    expect(mentionsName('Jose.Perez@x.org', 'José Pérez')).toBe(true);
  });
  it('is false when no name part appears', () => {
    expect(mentionsName('zaid.m@x.org', 'Dina Nasser')).toBe(false);
  });
  it('has nothing to compare for very short names, so it never warns', () => {
    expect(mentionsName('qq@x.org', 'Al Bo')).toBe(true);
  });
});

describe('conflictMessage', () => {
  it("names the role only for an account in the student's own school (R12)", () => {
    expect(conflictMessage('email_in_use', { role: 'PARENT', sameSchool: true }))
      .toBe('Already used by a parent account in this school. Each student needs their own address.');
    expect(conflictMessage('email_in_use', { role: 'ADMIN', sameSchool: true }))
      .toBe('Already used by an admin account in this school. Each student needs their own address.');
    expect(conflictMessage('email_in_use', { role: 'TEACHER', sameSchool: false }))
      .toBe('Already used by another SchoolMule account.');
  });
  it("keeps today's parent wording and names the other student for a shared address", () => {
    expect(conflictMessage('family_address')).toBe("This is a parent's address on file. Use the student's own school address.");
    expect(conflictMessage('shared_with_student', { otherName: 'Sara Haddad', otherGrade: '3' }))
      .toBe('Same address as Sara Haddad (Grade 3). Each student needs their own.');
    expect(conflictMessage('shared_with_student', { otherName: 'Lina Haddad', otherGrade: 'SK' }))
      .toBe('Same address as Lina Haddad (SK). Each student needs their own.');
  });
});

describe('problemsFor', () => {
  const base = { name: 'Amal Haddad', currentEmail: null, loginEmail: null, conflict: null };
  const codes = (list) => list.map((p) => [p.code, p.blocking]);

  it('an invalid address is the only problem', () => {
    expect(codes(problemsFor({ ...base, email: 'not-an-address' }, { domains: ['students.example.org'] })))
      .toEqual([['invalid_email', true]]);
  });

  it('a conflict blocks; domain and name are warnings', () => {
    const p = problemsFor(
      { ...base, email: 'mona@gmail.com', conflict: { kind: 'family_address' } },
      { domains: ['students.example.org'] },
    );
    expect(codes(p)).toEqual([['family_address', true], ['outside_domain', false], ['name_mismatch', false]]);
    expect(p[1].message).toBe('Not a school address (students.example.org)');
    expect(p[2].message).toBe("This address doesn't mention Amal or Haddad");
  });

  it('replacing a different address is a warning the admin must opt into', () => {
    const [p] = problemsFor({ ...base, email: 'amal.haddad@x.org', currentEmail: 'amal.h@x.org' }, { domains: [] });
    expect(p).toEqual({ code: 'replaces_existing', blocking: false, defaultUnticked: true, message: 'Replaces amal.h@x.org' });
  });

  it('the same address again is no change, so no warning', () => {
    expect(problemsFor({ ...base, email: 'amal.haddad@x.org', currentEmail: 'Amal.Haddad@x.org' }, { domains: [] })).toEqual([]);
  });

  it('a student with a login can only change address through Edit email (import)', () => {
    expect(codes(problemsFor(
      { ...base, email: 'amal.haddad@x.org', loginEmail: 'amal.old@x.org' }, { domains: [], forImport: true },
    ))).toEqual([['has_login', true]]);
    // The same address as the login is fine.
    expect(problemsFor({ ...base, email: 'amal.haddad@x.org', loginEmail: 'amal.haddad@x.org' }, { domains: [], forImport: true }))
      .toEqual([]);
  });
});
