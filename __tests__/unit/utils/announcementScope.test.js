const { scopeLabel } = require('../../../utils/announcementScope');

describe('scopeLabel', () => {
  it('names every scope and never falls back to Whole school for custom', () => {
    expect(scopeLabel({ scope: 'class', class_grade: '6', class_subject: 'Math' })).toBe('Gr 6 Math');
    expect(scopeLabel({ scope: 'grade', grade: '6' })).toBe('Grade 6');
    expect(scopeLabel({ scope: 'school' })).toBe('Whole school');
    expect(scopeLabel({ scope: 'custom' })).toBe('Selected families');
  });
});
