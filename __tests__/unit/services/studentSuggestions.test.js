const { buildRosterIndex, matchRow, suggestStudents } = require('../../../services/classroom/studentSuggestions');

const row = (student_id, name, grade) => ({ student_id, name, grade, student_email: null });
const ROSTER = [
  row('s-amal', 'Amal Haddad', '5'),
  row('s-sami', 'Sami Haddad', '3'),
  row('s-lina1', 'Lina Nassar', '4'),
  row('s-lina2', 'Lina Nassar', '6'),
  row('s-yusuf', 'Yusuf Rahman', '7'),
];
const index = buildRosterIndex(ROSTER);
const ids = (list) => list.map((s) => s.student.student_id);

describe('matchRow (Import emails)', () => {
  it('matches one exact name with no grade, and a name plus the same grade', () => {
    expect(matchRow(index, { name: 'amal haddad', grade: null })).toMatchObject({ kind: 'matched' });
    expect(matchRow(index, { name: 'Amal Haddad', grade: '5' }).matches.map((m) => m.student_id)).toEqual(['s-amal']);
  });
  it('asks to check a shared name, a right name in another grade, or a close name; not_found otherwise', () => {
    expect(matchRow(index, { name: 'Lina Nassar', grade: null }).kind).toBe('check');
    expect(matchRow(index, { name: 'Amal Haddad', grade: '6' }).kind).toBe('check');
    expect(matchRow(index, { name: 'Amal Hadad', grade: '5' }).kind).toBe('check');
    expect(matchRow(index, { name: 'Zainab Ali', grade: '5' })).toEqual({ kind: 'not_found', matches: [] });
  });
});

describe('suggestStudents (account requests)', () => {
  it('one student with the exact name is an exact suggestion, whatever grade the student typed', () => {
    expect(suggestStudents(index, { name: 'Amal Haddad', grade: '5' })).toEqual([{ student: ROSTER[0], kind: 'exact' }]);
    // A wrong guess at the grade never hides the record.
    expect(suggestStudents(index, { name: 'amal  haddad', grade: '8' })).toEqual([{ student: ROSTER[0], kind: 'exact' }]);
  });
  it('a shared name gives close suggestions with the typed grade first', () => {
    const list = suggestStudents(index, { name: 'Lina Nassar', grade: '6' });
    expect(ids(list)).toEqual(['s-lina2', 's-lina1']);
    expect(list.every((s) => s.kind === 'close')).toBe(true);
  });
  it('a near name is close; nothing for an unknown name; the limit holds', () => {
    expect(suggestStudents(index, { name: 'Yusef Rahman', grade: '7' })).toEqual([{ student: ROSTER[4], kind: 'close' }]);
    expect(suggestStudents(index, { name: 'Zainab Ali', grade: '5' })).toEqual([]);
    expect(suggestStudents(index, { name: 'Lina Nassar', grade: '4' }, 1)).toHaveLength(1);
  });
});
