const { parseCalendarDate, readCalendarDate, isoFromParts, dateError } = require('../../../utils/calendarDate');

describe('parseCalendarDate', () => {
  it('reads ISO dates and day-first dates', () => {
    expect(parseCalendarDate('2019-04-11')).toEqual({ ok: true, value: '2019-04-11' });
    expect(parseCalendarDate(' 11/04/2019 ')).toEqual({ ok: true, value: '2019-04-11' });
    expect(parseCalendarDate('1-2-2019')).toEqual({ ok: true, value: '2019-02-01' });
    expect(parseCalendarDate('1.2.2019')).toEqual({ ok: true, value: '2019-02-01' });
  });

  it('knows leap years', () => {
    expect(parseCalendarDate('2016-02-29').ok).toBe(true);
    expect(parseCalendarDate('2015-02-29')).toEqual({ ok: false, reason: 'impossible' });
    expect(parseCalendarDate('29/02/2000').ok).toBe(true);
    expect(parseCalendarDate('29/02/1900')).toEqual({ ok: false, reason: 'impossible' });
  });

  it.each(['2015-02-31', '31/04/2015', '2015-00-10', '2015-13-01', '32/01/2015', '0/5/2015'])(
    'refuses %s as a day that does not exist', (raw) => {
      expect(parseCalendarDate(raw)).toEqual({ ok: false, reason: 'impossible' });
    },
  );

  it('refuses years no student could have', () => {
    expect(parseCalendarDate('0019-04-11')).toEqual({ ok: false, reason: 'impossible' });
    expect(parseCalendarDate('11/04/2190')).toEqual({ ok: false, reason: 'impossible' });
  });

  it.each(['', '   ', 'next spring', '2019/04/11', '11-04-19', '2019-4-11', null, undefined])(
    'does not read %p as a date', (raw) => {
      expect(parseCalendarDate(raw)).toEqual({ ok: false, reason: 'format' });
    },
  );
});

describe('isoFromParts', () => {
  it('pads and refuses non-integers', () => {
    expect(isoFromParts(2019, 4, 1)).toBe('2019-04-01');
    expect(isoFromParts(2019, 4.5, 1)).toBeNull();
    expect(isoFromParts(NaN, 4, 1)).toBeNull();
  });
});

describe('dateError', () => {
  it('tells an impossible day from something that is not a date', () => {
    expect(dateError('2015-02-31', 'impossible')).toBe('"2015-02-31" is not a real date');
    expect(dateError('soon', 'format')).toBe('"soon" is not a recognizable date');
  });
});

describe('readCalendarDate', () => {
  it('returns the date, or the sentence to show', () => {
    expect(readCalendarDate(' 1/2/2019 ')).toEqual({ ok: true, value: '2019-02-01' });
    expect(readCalendarDate(' 2015-02-31 ')).toEqual({ ok: false, error: '"2015-02-31" is not a real date' });
    expect(readCalendarDate('soon')).toEqual({ ok: false, error: '"soon" is not a recognizable date' });
  });
});
