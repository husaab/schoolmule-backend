const {
  parseAcademicYear,
  academicYearToRange,
  academicMonthSequence,
  monthGrid,
  schoolWeeksForMonth,
} = require('../../../utils/agendaCalendar');

describe('parseAcademicYear', () => {
  it('parses a valid academic year', () => {
    expect(parseAcademicYear('2026-2027')).toEqual({ startYear: 2026, endYear: 2027 });
  });

  it('rejects malformed input', () => {
    expect(() => parseAcademicYear('2026')).toThrow();
    expect(() => parseAcademicYear('2026-2028')).toThrow();
    expect(() => parseAcademicYear('')).toThrow();
    expect(() => parseAcademicYear(undefined)).toThrow();
  });
});

describe('academicYearToRange', () => {
  it('maps to an Aug 1 - Jul 31 window', () => {
    expect(academicYearToRange('2025-2026')).toEqual({ from: '2025-08-01', to: '2026-07-31' });
  });
});

describe('academicMonthSequence', () => {
  it('returns Sept..June with correct calendar years', () => {
    const seq = academicMonthSequence('2025-2026');
    expect(seq).toHaveLength(10);
    expect(seq[0]).toEqual({ year: 2025, month: 9 });
    expect(seq[3]).toEqual({ year: 2025, month: 12 });
    expect(seq[4]).toEqual({ year: 2026, month: 1 });
    expect(seq[9]).toEqual({ year: 2026, month: 6 });
  });
});

describe('monthGrid', () => {
  it('September 2025 starts on Monday (grid col 1)', () => {
    const grid = monthGrid(2025, 9);
    expect(grid[0].map(c => c.day)).toEqual([null, 1, 2, 3, 4, 5, 6]);
    expect(grid[grid.length - 1].map(c => c.day)).toEqual([28, 29, 30, null, null, null, null]);
  });

  it('September 2026 starts on Tuesday (grid col 2)', () => {
    const grid = monthGrid(2026, 9);
    expect(grid[0].map(c => c.day)).toEqual([null, null, 1, 2, 3, 4, 5]);
  });

  it('handles leap-year February', () => {
    const grid = monthGrid(2028, 2);
    const days = grid.flat().filter(c => c.inMonth);
    expect(days).toHaveLength(29);
  });

  it('handles a month starting on Sunday', () => {
    const grid = monthGrid(2026, 2); // Feb 1 2026 is a Sunday
    expect(grid[0].map(c => c.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('schoolWeeksForMonth (verified against the printed 2025-26 agenda)', () => {
  // Weekly page counts per month in agenda 2025.pdf:
  // Sep 5, Oct 5, Nov 4, Dec 5, Jan 5, Feb 4, Mar 5, Apr 5, May 5, Jun 5
  const expectedWeekCounts = [
    [2025, 9, 5], [2025, 10, 5], [2025, 11, 4], [2025, 12, 5],
    [2026, 1, 5], [2026, 2, 4], [2026, 3, 5], [2026, 4, 5],
    [2026, 5, 5], [2026, 6, 5],
  ];

  it.each(expectedWeekCounts)('%i-%i has %i school weeks', (year, month, count) => {
    expect(schoolWeeksForMonth(year, month)).toHaveLength(count);
  });

  it('boundary week appears in both months with out-of-month days blanked', () => {
    // Week of Sep 29 2025: Mon 29, Tue 30 in September; Wed-Fri are October.
    const sepWeeks = schoolWeeksForMonth(2025, 9);
    const lastSepWeek = sepWeeks[sepWeeks.length - 1];
    expect(lastSepWeek.days.map(d => d.inMonth)).toEqual([true, true, false, false, false]);
    expect(lastSepWeek.days[0]).toMatchObject({ weekday: 'Monday', day: 29, inMonth: true });

    // The same calendar week opens October with Mon/Tue blanked.
    const octWeeks = schoolWeeksForMonth(2025, 10);
    expect(octWeeks[0].mondayIso).toBe(lastSepWeek.mondayIso);
    expect(octWeeks[0].days.map(d => d.inMonth)).toEqual([false, false, true, true, true]);
    expect(octWeeks[0].days[2]).toMatchObject({ weekday: 'Wednesday', day: 1, inMonth: true });
  });

  it('a week with only Friday in the month is included (May 2026)', () => {
    const mayWeeks = schoolWeeksForMonth(2026, 5); // May 1 2026 is a Friday
    expect(mayWeeks[0].days.map(d => d.inMonth)).toEqual([false, false, false, false, true]);
    expect(mayWeeks[0].days[4]).toMatchObject({ day: 1 });
  });

  it('months starting on a weekend skip the preceding week (Nov 2025, Feb 2026)', () => {
    expect(schoolWeeksForMonth(2025, 11)[0].days[0]).toMatchObject({ day: 3, inMonth: true });
    expect(schoolWeeksForMonth(2026, 2)[0].days[0]).toMatchObject({ day: 2, inMonth: true });
  });

  it('every school day of the year appears exactly once as inMonth', () => {
    const seq = academicMonthSequence('2025-2026');
    const seen = new Set();
    for (const { year, month } of seq) {
      for (const week of schoolWeeksForMonth(year, month)) {
        for (const d of week.days) {
          if (d.inMonth) {
            const key = `${d.year}-${d.month}-${d.day}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
          }
        }
      }
    }
    // ~217 weekdays Sept-June
    expect(seen.size).toBeGreaterThan(200);
  });
});
