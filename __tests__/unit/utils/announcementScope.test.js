const { scopeLabel, studentLink } = require('../../../utils/announcementScope');

describe('scopeLabel', () => {
  it('names every scope and never falls back to Whole school for custom', () => {
    expect(scopeLabel({ scope: 'class', class_grade: '6', class_subject: 'Math' })).toBe('Gr 6 Math');
    expect(scopeLabel({ scope: 'grade', grade: '6' })).toBe('Grade 6');
    expect(scopeLabel({ scope: 'school' })).toBe('Whole school');
    expect(scopeLabel({ scope: 'custom' })).toBe('Selected families');
  });
});

describe('studentLink', () => {
  const ID = '44444444-4444-4444-8444-444444444444';
  const CLASS = '22222222-2222-4222-8222-222222222222';
  beforeEach(() => { process.env.FRONTEND_URL = 'https://app.example.com'; });

  it('opens the class Stream for a class post and the student home otherwise', () => {
    expect(studentLink({ announcement_id: ID, scope: 'class', class_id: CLASS }))
      .toBe(`https://app.example.com/student/classes/${CLASS}?announcement=${ID}`);
    for (const scope of ['grade', 'school', 'custom']) {
      expect(studentLink({ announcement_id: ID, scope, class_id: null })).toBe(`https://app.example.com/student?announcement=${ID}`);
    }
  });

  it("M4: a custom post composed in a class Stream opens that class's Stream", () => {
    expect(studentLink({ announcement_id: ID, scope: 'custom', class_id: CLASS }))
      .toBe(`https://app.example.com/student/classes/${CLASS}?announcement=${ID}`);
  });
});
