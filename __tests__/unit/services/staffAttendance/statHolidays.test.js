const { easterSunday, ontarioStatHolidays, statHolidaysBetween } = require('../../../../services/staffAttendance/statHolidays');

const asObject = (map) => Object.fromEntries(map);

describe('easterSunday', () => {
  it.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2038, '2038-04-25'],
  ])('%i → %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });
});

describe('ontarioStatHolidays', () => {
  it('lists the nine Ontario public holidays for 2026', () => {
    expect(asObject(ontarioStatHolidays(2026))).toEqual({
      '2026-01-01': "New Year's Day",
      '2026-02-16': 'Family Day',
      '2026-04-03': 'Good Friday',
      '2026-05-18': 'Victoria Day',
      '2026-07-01': 'Canada Day',
      '2026-09-07': 'Labour Day',
      '2026-10-12': 'Thanksgiving',
      '2026-12-25': 'Christmas Day',
      // Boxing Day is a Saturday: observed the next Monday.
      '2026-12-28': 'Boxing Day (observed)',
    });
  });

  it('matches the 2027 calendar, Christmas and Boxing Day both on a weekend', () => {
    expect(asObject(ontarioStatHolidays(2027))).toEqual({
      '2027-01-01': "New Year's Day",
      '2027-02-15': 'Family Day',
      '2027-03-26': 'Good Friday',
      '2027-05-24': 'Victoria Day',
      '2027-07-01': 'Canada Day',
      '2027-09-06': 'Labour Day',
      '2027-10-11': 'Thanksgiving',
      '2027-12-27': 'Christmas Day (observed)',
      '2027-12-28': 'Boxing Day (observed)',
    });
  });

  it('pushes a Sunday Christmas past a Monday Boxing Day', () => {
    const holidays = ontarioStatHolidays(2022);
    expect(holidays.get('2022-12-26')).toBe('Boxing Day');
    expect(holidays.get('2022-12-27')).toBe('Christmas Day (observed)');
  });

  it('observes a Saturday New Year’s Day and a Sunday Canada Day on the Monday', () => {
    expect(ontarioStatHolidays(2022).get('2022-01-03')).toBe("New Year's Day (observed)");
    expect(ontarioStatHolidays(2029).get('2029-07-02')).toBe('Canada Day (observed)');
  });

  it('puts Victoria Day on the Monday before May 25, even when the 24th is a Monday', () => {
    expect(ontarioStatHolidays(2027).get('2027-05-24')).toBe('Victoria Day');
    expect(ontarioStatHolidays(2026).get('2026-05-18')).toBe('Victoria Day');
  });
});

describe('statHolidaysBetween', () => {
  it('keeps only the holidays inside the range, across a year boundary', () => {
    expect(asObject(statHolidaysBetween('2026-12-01', '2027-01-31'))).toEqual({
      '2026-12-25': 'Christmas Day',
      '2026-12-28': 'Boxing Day (observed)',
      '2027-01-01': "New Year's Day",
    });
  });

  it('is empty for a range with no holidays', () => {
    expect(statHolidaysBetween('2026-09-08', '2026-10-09').size).toBe(0);
  });
});
