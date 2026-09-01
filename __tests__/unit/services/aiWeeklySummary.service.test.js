const service = require('../../../services/aiWeeklySummary.service');

describe('getWeekStart', () => {
  // The school week runs Monday-Sunday in America/Toronto. Times below are
  // UTC; Toronto is UTC-4 in summer, UTC-5 in winter.
  it('returns the same Monday for every day of that week', () => {
    const monday = service.getWeekStart(new Date('2026-08-31T15:00:00Z'));
    expect(monday).toBe('2026-08-31');
    expect(service.getWeekStart(new Date('2026-09-02T15:00:00Z'))).toBe('2026-08-31');
    expect(service.getWeekStart(new Date('2026-09-06T15:00:00Z'))).toBe('2026-08-31'); // Sunday
  });

  it('rolls over to the next Monday', () => {
    expect(service.getWeekStart(new Date('2026-09-07T15:00:00Z'))).toBe('2026-09-07');
  });

  it('uses the school timezone, not UTC, near midnight', () => {
    // 2026-09-07T02:00Z is still Sunday 2026-09-06 at 22:00 in Toronto,
    // so this belongs to the week starting Aug 31 — not Sep 7.
    expect(service.getWeekStart(new Date('2026-09-07T02:00:00Z'))).toBe('2026-08-31');
  });
});

describe('hasActivity', () => {
  const empty = { newMarks: [], missingWork: [], feedback: [], attendance: null };

  it('is false for a completely quiet week', () => {
    expect(service.hasActivity(empty)).toBe(false);
  });

  it('is false when attendance exists but has no recorded days', () => {
    expect(service.hasActivity({ ...empty, attendance: { total: 0 } })).toBe(false);
  });

  it.each([
    ['a new mark', { newMarks: [{ subject: 'Math', name: 'Quiz', pct: 90 }] }],
    ['missing work', { missingWork: [{ subject: 'Math', name: 'HW 1' }] }],
    ['feedback', { feedback: [{ subject: 'Math', comment: 'Good work' }] }],
    ['attendance', { attendance: { total: 5 } }],
  ])('is true given %s', (_label, partial) => {
    expect(service.hasActivity({ ...empty, ...partial })).toBe(true);
  });
});

describe('buildUserPrompt', () => {
  const facts = {
    newMarks: [{ subject: 'Math', name: 'Quiz 4', pct: 88 }],
    attendance: { present: 4, late: 1, absent: 0, total: 5 },
    missingWork: [{ subject: 'Science', name: 'Lab 2' }],
    feedback: [{ subject: 'English', comment: 'Reading has improved.' }],
  };

  it('includes every supplied fact', () => {
    const prompt = service.buildUserPrompt(facts, 'Amina', '2026-08-31', '2026-09-06');
    expect(prompt).toContain('Math: Quiz 4 — 88%');
    expect(prompt).toContain('4 present, 1 late, 0 absent, out of 5 recorded day(s).');
    expect(prompt).toContain('Science: Lab 2');
    expect(prompt).toContain('English: Reading has improved.');
    expect(prompt).toContain('Amina');
  });

  it('says "None" for empty sections rather than omitting them', () => {
    const prompt = service.buildUserPrompt(
      { newMarks: [], attendance: null, missingWork: [], feedback: [] },
      'Amina',
      '2026-08-31',
      '2026-09-06',
    );
    expect(prompt).toContain('None');
    expect(prompt).toContain('No attendance recorded this week.');
  });

  it('instructs the model not to invent anything', () => {
    const prompt = service.buildUserPrompt(facts, 'Amina', '2026-08-31', '2026-09-06');
    expect(prompt).toMatch(/Only use the facts below/);
    expect(prompt).toMatch(/never invent numbers or subjects/);
  });
});
