const { normalizeName, isNearName, buildCandidateIndex, resolveMatch } = require('../../../../services/import/matching');
const target = require('../../../../services/import/studentImportTarget');

describe('normalizeName', () => {
  it('lowercases, collapses whitespace, and trims', () => {
    expect(normalizeName('  Maya   EL-Mnini ')).toBe('maya el mnini');
  });

  it('strips accents so "José" and "Jose" compare equal', () => {
    expect(normalizeName('José Ávila')).toBe(normalizeName('Jose Avila'));
  });

  it('treats punctuation as a separator', () => {
    expect(normalizeName("O'Brien-Smith")).toBe('o brien smith');
  });

  it('returns an empty string for null/undefined', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('isNearName', () => {
  it('catches reordered name parts', () => {
    expect(isNearName('Fatimah Khan Castro', 'Khan Castro Fatimah')).toBe(true);
  });

  it('catches a single-character typo', () => {
    expect(isNearName('Ahmad Hamze', 'Ahmed Hamze')).toBe(true);
  });

  it('catches a dropped middle name', () => {
    expect(isNearName('Sajjad Dhurgam Allami', 'Sajjad Allami')).toBe(true);
  });

  it('is false for an exact match — that is a different tier', () => {
    expect(isNearName('Ali Hassan', 'ali  HASSAN')).toBe(false);
  });

  it('does not match unrelated names', () => {
    expect(isNearName('Zaynab Assi', 'Hadi Assaf')).toBe(false);
    expect(isNearName('Noor Theheb', 'Mila Faour')).toBe(false);
  });

  it('does not collide short distinct names', () => {
    expect(isNearName('Ali', 'Adi')).toBe(false);
  });
});

describe('resolveMatch', () => {
  const s = (id, name, grade) => ({ student_id: id, name, grade });
  const idx = students => buildCandidateIndex(students, target.getCandidateName);
  const resolve = (students, name, grade) =>
    resolveMatch(idx(students), { name, grade }, target.getCandidateName, target.getCandidateGrade);

  it('returns none when there is nothing to match', () => {
    expect(resolve([], 'Ahmad Hamze', '2').tier).toBe('none');
  });

  it('returns exact for the same name in the same grade', () => {
    const r = resolve([s('st1', 'Ahmad Hamze', '2')], 'Ahmad Hamze', '2');
    expect(r.tier).toBe('exact');
    expect(r.matches[0].student_id).toBe('st1');
  });

  it('returns near for the same name in a different grade', () => {
    expect(resolve([s('st1', 'Ahmad Hamze', '5')], 'Ahmad Hamze', '2').tier).toBe('near');
  });

  it('returns near when several students share a name and grade', () => {
    const r = resolve(
      [s('st1', 'Ahmad Hamze', '2'), s('st2', 'Ahmad Hamze', '2')],
      'Ahmad Hamze', '2',
    );
    expect(r.tier).toBe('near');
    expect(r.matches).toHaveLength(2);
  });

  it('compares JK/SK grades as tokens', () => {
    expect(resolve([s('st1', 'Lea Hammoud', 'JK')], 'Lea Hammoud', 'JK').tier).toBe('exact');
    expect(resolve([s('st1', 'Lea Hammoud', 'SK')], 'Lea Hammoud', 'JK').tier).toBe('near');
  });

  it('returns none for an empty submitted name', () => {
    expect(resolve([s('st1', 'Ahmad Hamze', '2')], '', '2').tier).toBe('none');
  });
});

describe('studentImportTarget.suggestMapping', () => {
  // The real Al Haadi "New Students 2026-2027" form.
  const fields = [
    { field_id: 'f0', field_type: 'text',  label: 'Email' },
    { field_id: 'f1', field_type: 'text',  label: 'Name of student as it appears on their birth certificate:' },
    { field_id: 'f2', field_type: 'radio', label: 'Which grade is your child going to?',
      options: ['Junior Kindergarten (born in 2022)', 'Senior Kindergarten', 'Grade 1', 'Grade 8'] },
    { field_id: 'f3', field_type: 'date',  label: 'Date of birth:' },
    { field_id: 'f4', field_type: 'text',  label: 'Last school attended in Canada (name, phone number, and address).' },
    { field_id: 'f5', field_type: 'text',  label: "Child's health card number:" },
    { field_id: 'f6', field_type: 'text',  label: 'Parent/Guardian full name:' },
    { field_id: 'f7', field_type: 'text',  label: 'Parent/Guardian phone number:' },
    { field_id: 'f8', field_type: 'text',  label: "Parents' email address:" },
    { field_id: 'f9', field_type: 'text',  label: 'Please write your residential address:' },
    { field_id: 'f10', field_type: 'text', label: 'Does your child suffer from any medical condition(s)...' },
    { field_id: 'f11', field_type: 'text', label: 'Emergency contact name and phone number:' },
  ];

  const suggested = target.suggestMapping(fields);
  const byTarget = Object.fromEntries(suggested.map(m => [m.targetField, m]));

  it('finds the student name field', () => {
    expect(byTarget.name.fieldId).toBe('f1');
  });

  it('finds the grade field and translates every option', () => {
    expect(byTarget.grade.fieldId).toBe('f2');
    expect(byTarget.grade.valueMap).toEqual({
      'Junior Kindergarten (born in 2022)': 'JK',
      'Senior Kindergarten': 'SK',
      'Grade 1': '1',
      'Grade 8': '8',
    });
  });

  it('finds date of birth, health card, medical notes and emergency contact', () => {
    expect(byTarget.dateOfBirth.fieldId).toBe('f3');
    expect(byTarget.healthCardNumber.fieldId).toBe('f5');
    expect(byTarget.medicalNotes.fieldId).toBe('f10');
    expect(byTarget.emergencyContact.fieldId).toBe('f11');
  });

  it('routes generic parent/guardian wording to the mother columns', () => {
    expect(byTarget.motherName.fieldId).toBe('f6');
    expect(byTarget.motherPhone.fieldId).toBe('f7');
    expect(byTarget.motherEmail.fieldId).toBe('f8');
  });

  it('maps the residential address, not the "last school attended" address', () => {
    expect(byTarget.address.fieldId).toBe('f9');
  });

  it('never assigns one form field to two student fields', () => {
    const ids = suggested.map(m => m.fieldId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves fields it is unsure about unmapped', () => {
    const mapped = new Set(suggested.map(m => m.fieldId));
    expect(mapped.has('f4')).toBe(false); // "Last school attended" has no student column
  });
});

describe('studentImportTarget.coerceValue', () => {
  it('accepts a grade token typed directly into a text field', () => {
    expect(target.coerceValue('grade', 'JK', null)).toEqual({ ok: true, value: 'JK' });
    expect(target.coerceValue('grade', '3', null)).toEqual({ ok: true, value: '3' });
  });

  it('rejects a grade outside the enum', () => {
    expect(target.coerceValue('grade', '12', null).ok).toBe(false);
  });

  it('lowercases emails for consistent matching', () => {
    expect(target.coerceValue('motherEmail', ' Parent@Example.COM ', null))
      .toEqual({ ok: true, value: 'parent@example.com' });
  });

  it('rejects a phone number with no digits', () => {
    expect(target.coerceValue('motherPhone', 'call me', null).ok).toBe(false);
  });

  it('rejects an unparseable date', () => {
    expect(target.coerceValue('dateOfBirth', 'sometime in 2019', null).ok).toBe(false);
  });

  it('treats a blank answer as no value rather than an error', () => {
    expect(target.coerceValue('medicalNotes', '   ', null)).toEqual({ ok: true, value: null });
  });
});
