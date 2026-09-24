const {
  payDatesBetween,
  periodEndingOn,
  periodContaining,
  periodsPaidInMonth,
  recordHours,
  sumHours,
  normalizeSchedule,
  describeSchedule,
} = require('../../../services/payPeriods');

const monthly25 = { frequency: 'MONTHLY', payDayOfMonth: 25 };
const monthly31 = { frequency: 'MONTHLY', payDayOfMonth: 31 };
const semi = { frequency: 'SEMI_MONTHLY', payDayOfMonth: 15, secondPayDayOfMonth: 31 };
// 2026-09-11 is a Friday.
const biweeklyFri = { frequency: 'BIWEEKLY', anchorPayDate: '2026-09-11' };
const weeklyFri = { frequency: 'WEEKLY', anchorPayDate: '2026-09-11' };

describe('payPeriods', () => {
  describe('payDatesBetween', () => {
    it('lists monthly pay dates in a range', () => {
      expect(payDatesBetween(monthly25, '2026-08-26', '2026-10-25')).toEqual(['2026-09-25', '2026-10-25']);
    });

    it('clamps a pay day past the end of a short month', () => {
      expect(payDatesBetween(monthly31, '2026-02-01', '2026-04-30')).toEqual([
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
      ]);
    });

    it('lists semi-monthly pay dates', () => {
      expect(payDatesBetween(semi, '2026-09-01', '2026-10-31')).toEqual([
        '2026-09-15',
        '2026-09-30',
        '2026-10-15',
        '2026-10-31',
      ]);
    });

    it('steps biweekly from the anchor in both directions', () => {
      expect(payDatesBetween(biweeklyFri, '2026-08-01', '2026-10-15')).toEqual([
        '2026-08-14',
        '2026-08-28',
        '2026-09-11',
        '2026-09-25',
        '2026-10-09',
      ]);
    });

    it('steps weekly from the anchor', () => {
      expect(payDatesBetween(weeklyFri, '2026-09-11', '2026-09-30')).toEqual([
        '2026-09-11',
        '2026-09-18',
        '2026-09-25',
      ]);
    });

    it('returns nothing without a schedule or for an inverted range', () => {
      expect(payDatesBetween(null, '2026-09-01', '2026-09-30')).toEqual([]);
      expect(payDatesBetween(monthly25, '2026-09-30', '2026-09-01')).toEqual([]);
    });
  });

  describe('periods', () => {
    it('ends on the pay day and starts the day after the previous one', () => {
      expect(periodEndingOn(monthly25, '2026-09-25')).toEqual({
        payDate: '2026-09-25',
        startDate: '2026-08-26',
        endDate: '2026-09-25',
      });
    });

    it('puts a date in the period paid on the next pay day, pay day inclusive', () => {
      expect(periodContaining(monthly25, '2026-09-23').payDate).toBe('2026-09-25');
      expect(periodContaining(monthly25, '2026-09-25').payDate).toBe('2026-09-25');
      expect(periodContaining(monthly25, '2026-09-26').payDate).toBe('2026-10-25');
    });

    it('handles clamped month ends across the year boundary', () => {
      expect(periodEndingOn(monthly31, '2027-01-31')).toEqual({
        payDate: '2027-01-31',
        startDate: '2027-01-01',
        endDate: '2027-01-31',
      });
      expect(periodEndingOn(monthly31, '2027-02-28').startDate).toBe('2027-02-01');
    });

    it('lists every period paid in a month', () => {
      expect(periodsPaidInMonth(biweeklyFri, '2026-09')).toEqual([
        { payDate: '2026-09-11', startDate: '2026-08-29', endDate: '2026-09-11' },
        { payDate: '2026-09-25', startDate: '2026-09-12', endDate: '2026-09-25' },
      ]);
      expect(periodsPaidInMonth(monthly25, '2026-09')).toHaveLength(1);
    });
  });

  describe('hours', () => {
    it('counts a present day as a full work day, an absence as nothing', () => {
      expect(recordHours({ status: 'PRESENT' }, 7)).toBe(7);
      expect(recordHours({ status: 'ABSENT' }, 7)).toBe(0);
    });

    it('lets an explicit override win, even a zero', () => {
      expect(recordHours({ status: 'PRESENT', hours: '3.5' }, 7)).toBe(3.5);
      expect(recordHours({ status: 'PRESENT', hours: 0 }, 7)).toBe(0);
      expect(recordHours({ status: 'ABSENT', hours: 2 }, 7)).toBe(2);
    });

    it('sums to two decimals', () => {
      const records = [
        { status: 'PRESENT' },
        { status: 'PRESENT', hours: 3.25 },
        { status: 'ABSENT' },
      ];
      expect(sumHours(records, 7.5)).toBe(10.75);
    });
  });

  describe('normalizeSchedule', () => {
    it('accepts a monthly schedule', () => {
      expect(normalizeSchedule({ frequency: 'monthly', payDayOfMonth: 25, defaultHoursPerDay: 7 })).toEqual({
        value: {
          frequency: 'MONTHLY',
          payDayOfMonth: 25,
          secondPayDayOfMonth: null,
          anchorPayDate: null,
          defaultHoursPerDay: 7,
        },
      });
    });

    it('orders semi-monthly days', () => {
      const { value } = normalizeSchedule({ frequency: 'SEMI_MONTHLY', payDayOfMonth: 30, secondPayDayOfMonth: 15 });
      expect(value.payDayOfMonth).toBe(15);
      expect(value.secondPayDayOfMonth).toBe(30);
      expect(value.defaultHoursPerDay).toBe(7.5);
    });

    it('rejects bad input', () => {
      expect(normalizeSchedule({ frequency: 'DAILY' }).error).toMatch(/frequency/);
      expect(normalizeSchedule({ frequency: 'MONTHLY', payDayOfMonth: 0 }).error).toMatch(/payDayOfMonth/);
      expect(normalizeSchedule({ frequency: 'SEMI_MONTHLY', payDayOfMonth: 15, secondPayDayOfMonth: 15 }).error).toMatch(
        /secondPayDayOfMonth/
      );
      expect(normalizeSchedule({ frequency: 'BIWEEKLY', anchorPayDate: '2026-02-30' }).error).toMatch(/anchorPayDate/);
      expect(normalizeSchedule({ frequency: 'MONTHLY', payDayOfMonth: 25, defaultHoursPerDay: 25 }).error).toMatch(
        /defaultHoursPerDay/
      );
    });
  });

  it('describes schedules', () => {
    expect(describeSchedule(monthly25)).toBe('Monthly on the 25th');
    expect(describeSchedule(semi)).toBe('Twice a month, on the 15th and 31st');
    expect(describeSchedule(biweeklyFri)).toBe('Every second Friday');
    expect(describeSchedule(weeklyFri)).toBe('Every Friday');
    expect(describeSchedule(null)).toBeNull();
  });
});
