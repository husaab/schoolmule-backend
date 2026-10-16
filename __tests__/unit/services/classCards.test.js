const { classLabel, dedupeParents, toPeopleStudent, peopleCounts, toComingUpRow } = require('../../../services/classroom/classCards');

const SETTINGS = { loginFromGrade: '1', qrUntilGrade: '3' };

describe('classLabel', () => {
  it.each([
    ['5', 'Science', 'Grade 5 Science'],
    ['8', 'Islamic Studies', 'Grade 8 Islamic Studies'],
    ['JK', 'Science', 'JK Science'],
    ['SK', 'Senior Kindergarten', 'Senior Kindergarten'],
    ['JK', 'JK Play', 'JK Play'],
  ])('grade %s %s reads "%s"', (grade, subject, label) => {
    expect(classLabel(grade, subject)).toBe(label);
  });
});

describe('dedupeParents', () => {
  it('keeps one parent per address, ignoring case, and keeps the first (the one with a login)', () => {
    const out = dedupeParents([
      { name: 'Mona Haddad', relation: 'Mother', hasAccount: true, emailKey: 'mona@example.com' },
      { name: 'M. Haddad', relation: null, hasAccount: false, emailKey: 'mona@example.com' },
      { name: 'Karim Haddad', relation: 'Father', hasAccount: false, emailKey: 'karim@example.com' },
    ]);
    expect(out).toEqual([
      { name: 'Mona Haddad', relation: 'Mother', hasAccount: true },
      { name: 'Karim Haddad', relation: 'Father', hasAccount: false },
    ]);
  });

  it('falls back to the name when there is no address, and drops a row with neither', () => {
    const out = dedupeParents([
      { name: 'Nour Haddad', relation: 'Aunt', hasAccount: false, emailKey: '' },
      { name: 'nour haddad', relation: null, hasAccount: false, emailKey: '' },
      { name: null, relation: null, hasAccount: false, emailKey: '' },
    ]);
    expect(out).toEqual([{ name: 'Nour Haddad', relation: 'Aunt', hasAccount: false }]);
  });

  it('shows a parent with an address but no name as "Parent", one entry per address, and never returns the address', () => {
    const out = dedupeParents([
      { name: null, relation: null, hasAccount: false, emailKey: 'a@example.com' },
      { name: null, relation: 'Father', hasAccount: false, emailKey: 'b@example.com' },
      { name: null, relation: null, hasAccount: false, emailKey: 'A@example.com'.toLowerCase() },
    ]);
    expect(out).toEqual([
      { name: 'Parent', relation: null, hasAccount: false },
      { name: 'Parent', relation: 'Father', hasAccount: false },
    ]);
    expect(JSON.stringify(out)).not.toContain('example.com');
  });

  it('tolerates a missing list', () => {
    expect(dedupeParents(null)).toEqual([]);
  });
});

describe('people shaping', () => {
  const base = { student_id: 's1', name: 'Amal Haddad', grade: '2', avatar: null, parents: [], missing_count: 0 };

  it('derives the status and QR eligibility from the login', () => {
    const active = toPeopleStudent({ ...base, user_id: 'u1', is_archived: false, invite_pending: false, last_seen_at: '2026-10-14T15:00:00Z' }, SETTINGS);
    expect(active.account).toEqual({ status: 'active', userId: 'u1', lastSeenAt: '2026-10-14T15:00:00.000Z', qrEligible: true });
    const none = toPeopleStudent({ ...base, grade: 'SK', user_id: null }, SETTINGS);
    expect(none.account).toEqual({ status: 'not_eligible', userId: null, lastSeenAt: null, qrEligible: false });
  });

  it('counts students not signed in and with missing work', () => {
    const rows = [
      { ...base, user_id: null },
      { ...base, student_id: 's2', user_id: 'u2', is_archived: false, invite_pending: true },
      { ...base, student_id: 's3', user_id: 'u3', is_archived: false, invite_pending: false, missing_count: 2 },
      { ...base, student_id: 's4', grade: 'SK', user_id: null },
    ].map((r) => toPeopleStudent(r, SETTINGS));
    expect(peopleCounts(rows)).toEqual({ students: 4, notSignedIn: 2, missingWork: 1 });
  });
});

describe('toComingUpRow', () => {
  it('is an in-class assessment with nothing to turn in', () => {
    expect(toComingUpRow({ assessment_id: 'a1', class_id: 'c1', grade: '5', subject: 'Science', title: 'Unit test', date: '2026-10-23' })).toEqual({
      itemId: null, assessmentId: 'a1', classId: 'c1', classLabel: 'Grade 5 Science', title: 'Unit test',
      kind: 'assessment', date: '2026-10-23', dueAt: null, inClass: true, stillToTurnIn: null,
    });
  });
});
