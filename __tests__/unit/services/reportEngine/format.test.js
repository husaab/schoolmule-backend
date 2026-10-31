const f = require('../../../../services/reportEngine/data/format');

describe('termLabel (legacy formatTermDisplay)', () => {
  it('maps the bare term names', () => {
    expect(f.termLabel('Term 1')).toBe('FIRST TERM');
    expect(f.termLabel(' term 2 ')).toBe('SECOND TERM');
    expect(f.termLabel('Term 3')).toBe('THIRD TERM');
    expect(f.termLabel('4')).toBe('FOURTH TERM');
  });

  it('upper-cases anything else, exactly like the legacy title', () => {
    expect(f.termLabel('Term 2 2025-2026')).toBe('TERM 2 2025-2026');
    expect(f.termLabel('Winter')).toBe('WINTER');
  });

  it('falls back to TERM when there is no term', () => {
    expect(f.termLabel('')).toBe('TERM');
    expect(f.termLabel(null)).toBe('TERM');
    expect(f.termLabel(undefined)).toBe('TERM');
  });
});

describe('termNumber', () => {
  it('reads the number after "Term" / "T", or a bare number', () => {
    expect(f.termNumber('Term 1')).toBe(1);
    expect(f.termNumber('Term 2 2025-2026')).toBe(2);
    expect(f.termNumber('term3')).toBe(3);
    expect(f.termNumber('T2')).toBe(2);
    expect(f.termNumber('4')).toBe(4);
  });

  it('is null when the name has no term number', () => {
    expect(f.termNumber('Winter 2026')).toBeNull();
    expect(f.termNumber('Fall')).toBeNull();
    expect(f.termNumber('')).toBeNull();
    expect(f.termNumber(null)).toBeNull();
  });
});

describe('school year labels', () => {
  it('spaces the hyphen of a year pair', () => {
    expect(f.formatSchoolYearLabel('2026-2027')).toBe('2026 - 2027');
    expect(f.formatSchoolYearLabel('2026 - 2027')).toBe('2026 - 2027');
    expect(f.formatSchoolYearLabel('2026–2027')).toBe('2026 - 2027');
  });

  it('keeps any other label as it is', () => {
    expect(f.formatSchoolYearLabel('Pilot year')).toBe('Pilot year');
    expect(f.formatSchoolYearLabel(null)).toBe('');
  });

  it('rolls the legacy academic year over in September', () => {
    expect(f.academicYearFor('2026-08-31')).toBe('2025 - 2026');
    expect(f.academicYearFor('2026-09-01')).toBe('2026 - 2027');
    expect(f.academicYearFor('2026-10-31')).toBe('2026 - 2027');
    expect(f.academicYearFor('2027-01-15')).toBe('2026 - 2027');
  });
});

describe('grades', () => {
  it('labels kindergarten and numbered grades', () => {
    expect(f.gradeLabel('JK')).toBe('Junior Kindergarten');
    expect(f.gradeLabel('sk')).toBe('Senior Kindergarten');
    expect(f.gradeLabel('4')).toBe('Grade 4');
    expect(f.gradeLabel(7)).toBe('Grade 7');
    expect(f.gradeLabel(null)).toBe('');
  });

  it('numbers JK as -1 and SK as 0', () => {
    expect(f.gradeNumber('JK')).toBe(-1);
    expect(f.gradeNumber('SK')).toBe(0);
    expect(f.gradeNumber('1')).toBe(1);
    expect(f.gradeNumber('8')).toBe(8);
    expect(f.gradeNumber('')).toBe(0);
  });

  it('gives the grade as text', () => {
    expect(f.gradeText('jk')).toBe('JK');
    expect(f.gradeText(3)).toBe('3');
    expect(f.gradeText(null)).toBe('');
  });
});

describe('splitName', () => {
  it('splits on the first space', () => {
    expect(f.splitName('Test Student A')).toEqual({ firstName: 'Test', lastName: 'Student A' });
    expect(f.splitName('  Sample   Pupil  ')).toEqual({ firstName: 'Sample', lastName: 'Pupil' });
  });

  it('keeps a one-word name as the first name', () => {
    expect(f.splitName('Mononym')).toEqual({ firstName: 'Mononym', lastName: '' });
    expect(f.splitName(null)).toEqual({ firstName: '', lastName: '' });
  });
});

describe('humanizeKey', () => {
  it('turns snake_case keys into words', () => {
    expect(f.humanizeKey('language_arts')).toBe('Language Arts');
    expect(f.humanizeKey('academic_achievement')).toBe('Academic Achievement');
    expect(f.humanizeKey('socio_emotional')).toBe('Socio Emotional');
    expect(f.humanizeKey('')).toBe('');
    expect(f.humanizeKey(null)).toBe('');
  });
});

describe('isAlHaadiT2', () => {
  it('matches Al Haadi Academy and any term containing "term 2"', () => {
    expect(f.isAlHaadiT2('ALHAADIACADEMY', 'Term 2')).toBe(true);
    expect(f.isAlHaadiT2('Al Haadi Academy', 'term 2 2025-2026')).toBe(true);
  });

  it('leaves other schools and terms on the standard card', () => {
    expect(f.isAlHaadiT2('PLAYGROUND', 'Term 2')).toBe(false);
    expect(f.isAlHaadiT2('ALHAADIACADEMY', 'Term 1')).toBe(false);
    expect(f.isAlHaadiT2(null, null)).toBe(false);
  });
});

describe('dates', () => {
  const lateEveningToronto = new Date('2026-11-01T02:30:00Z'); // Oct 31, 22:30 EDT

  it('takes today in the school timezone', () => {
    expect(f.isoDateInTimeZone('America/Toronto', lateEveningToronto)).toBe('2026-10-31');
    expect(f.isoDateInTimeZone('UTC', lateEveningToronto)).toBe('2026-11-01');
  });

  it('falls back to Toronto for a missing or unknown timezone', () => {
    expect(f.isoDateInTimeZone(null, lateEveningToronto)).toBe('2026-10-31');
    expect(f.isoDateInTimeZone('Not/AZone', lateEveningToronto)).toBe('2026-10-31');
  });

  it('formats generatedDate as en-CA', () => {
    expect(f.generatedDateToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts only real YYYY-MM-DD dates', () => {
    expect(f.isIsoDate('2026-02-28')).toBe(true);
    expect(f.isIsoDate('2026-02-30')).toBe(false);
    expect(f.isIsoDate('2026/02/28')).toBe(false);
    expect(f.isIsoDate(20260228)).toBe(false);
  });
});

describe('text', () => {
  it('turns null into an empty string', () => {
    expect(f.text(null)).toBe('');
    expect(f.text(undefined)).toBe('');
    expect(f.text(0)).toBe('0');
    expect(f.text('E')).toBe('E');
  });
});
