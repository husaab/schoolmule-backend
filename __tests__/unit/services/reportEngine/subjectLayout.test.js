const { readSubjectLayout, applySubjectLayout, OTHER_HEADING } = require('../../../../services/reportEngine/subjectLayout');

const LAYOUT = [
  { heading: 'Language & Literacy', subjects: [{ name: 'English Language Arts', classes: ['English'] }] },
  { heading: 'Science & Technology', subjects: [{ name: 'Science', classes: [] }, { name: 'Computer Studies', classes: [] }] },
  {
    heading: 'Religious Studies',
    subjects: [
      { name: 'Quran', classes: ['Quran', 'Quran Teaching', 'Quran Teaching and Memorization'] },
      { name: 'Islamic Studies', classes: [] },
      { name: 'Salaat', classes: [] },
    ],
  },
];

describe('readSubjectLayout', () => {
  it('tidies names, drops empty and repeated class names, and keeps the order', () => {
    const read = readSubjectLayout([
      { heading: '  The   Arts ', subjects: [{ name: ' Visual  Arts', classes: ['Art', ' ', 'art', 'Arts '] }] },
      { heading: 'Physical Education', subjects: [{ name: 'Physical Education' }] },
    ]);
    expect(read.value).toEqual([
      { heading: 'The Arts', subjects: [{ name: 'Visual Arts', classes: ['Art', 'Arts'] }] },
      { heading: 'Physical Education', subjects: [{ name: 'Physical Education', classes: [] }] },
    ]);
  });

  it.each([
    [[], 'Add at least one heading'],
    ['nope', 'Add at least one heading'],
    [[{ heading: ' ', subjects: [{ name: 'Math' }] }], 'Every heading needs a name'],
    [[{ heading: 'Math', subjects: [] }], 'Add a subject under "Math"'],
    [[{ heading: 'Math', subjects: [{ name: '' }] }], 'Every subject under "Math" needs a name'],
    [[{ heading: 'A', subjects: [{ name: 'X' }] }, { heading: 'a', subjects: [{ name: 'Y' }] }], '"a" is in the list twice'],
    [[{ heading: 'A', subjects: [{ name: 'X', classes: 'Art' }] }], 'The classes for "X" must be a list'],
    [[{ heading: 'A', subjects: [{ name: 'X', classes: [3] }] }], 'The classes for "X" must be names'],
  ])('refuses %j', (sections, error) => {
    expect(readSubjectLayout(sections)).toEqual({ error });
  });

  it('refuses a class name under two subjects, naming both', () => {
    const read = readSubjectLayout([
      { heading: 'The Arts', subjects: [{ name: 'Visual Arts', classes: ['Art'] }] },
      { heading: 'Other', subjects: [{ name: 'art' }] },
    ]);
    expect(read.error).toBe('Classes named "art" are under both "Visual Arts" and "art". Keep them under one.');
  });

  it('refuses text over 80 characters and too many headings', () => {
    expect(readSubjectLayout([{ heading: 'x'.repeat(81), subjects: [{ name: 'Math' }] }]).error).toMatch(/longer than 80/);
    const many = Array.from({ length: 21 }, (_, i) => ({ heading: `H${i}`, subjects: [{ name: `S${i}` }] }));
    expect(readSubjectLayout(many).error).toBe('A report can have at most 20 headings');
  });
});

describe('applySubjectLayout', () => {
  const rows = ['Salaat', 'Science', 'quran  teaching', 'English', 'Math', 'Computer Studies', 'Art'].map((name) => ({ id: name, name }));

  it('puts the rows in the layout order under their headings and printed names, others last', () => {
    const out = applySubjectLayout(rows, LAYOUT);
    expect(out.map((r) => [r.section, r.name])).toEqual([
      ['Language & Literacy', 'English Language Arts'],
      ['Science & Technology', 'Science'],
      ['Science & Technology', 'Computer Studies'],
      ['Religious Studies', 'Quran'],
      ['Religious Studies', 'Salaat'],
      [OTHER_HEADING, 'Math'],
      [OTHER_HEADING, 'Art'],
    ]);
    expect(out[3].id).toBe('quran  teaching');
  });

  it('keeps two classes under one subject in their own order', () => {
    const out = applySubjectLayout([{ name: 'Quran Teaching' }, { name: 'Quran' }], LAYOUT);
    expect(out.map((r) => r.name)).toEqual(['Quran', 'Quran']);
  });

  it('leaves the rows as they were with no layout', () => {
    expect(applySubjectLayout(rows, null)).toBe(rows);
    expect(applySubjectLayout(rows, [])).toBe(rows);
  });

  it('works on another field (the legacy generator names it subject)', () => {
    const out = applySubjectLayout([{ subject: 'Salaat' }, { subject: 'English' }], LAYOUT, 'subject');
    expect(out).toEqual([
      { subject: 'English Language Arts', section: 'Language & Literacy' },
      { subject: 'Salaat', section: 'Religious Studies' },
    ]);
  });
});
