const { validateLimits, isKind, KINDS, KEY } = require('../../../services/reportComments/rules');

const body = (reportCard, progressReport = {}) => ({ reportCard, progressReport });

describe('report comment rules: validateLimits', () => {
  it('accepts whole numbers and reads a missing or blank end as no limit', () => {
    expect(validateLimits(body({ minWords: 50, maxWords: 120 }, { minWords: null }))).toEqual({
      value: {
        reportCard: { minWords: 50, maxWords: 120 },
        progressReport: { minWords: null, maxWords: null },
      },
    });
    expect(validateLimits(body({ minWords: '', maxWords: 80 })).value.reportCard).toEqual({ minWords: null, maxWords: 80 });
  });

  it('accepts a minimum equal to the maximum', () => {
    expect(validateLimits(body({ minWords: 60, maxWords: 60 })).value.reportCard).toEqual({ minWords: 60, maxWords: 60 });
  });

  it('refuses a minimum above the maximum, naming the document', () => {
    expect(validateLimits(body({ minWords: 121, maxWords: 120 })).error).toMatch(/Report card comments: the minimum/);
    expect(validateLimits(body({}, { minWords: 10, maxWords: 5 })).error).toMatch(/Progress report comments: the minimum/);
  });

  it('refuses zero, negatives, fractions, text and numbers over 2000', () => {
    for (const bad of [0, -1, 1.5, '50', 2001, true, NaN]) {
      expect(validateLimits(body({ minWords: bad })).error).toMatch(/whole numbers of words from 1 to 2000/);
      expect(validateLimits(body({ maxWords: bad })).error).toMatch(/whole numbers of words from 1 to 2000/);
    }
  });

  it('refuses a body that leaves a document out', () => {
    expect(validateLimits(null).error).toBeTruthy();
    expect(validateLimits([]).error).toBeTruthy();
    expect(validateLimits({ reportCard: { minWords: 1 } }).error).toMatch(/progressReport/);
    expect(validateLimits({ reportCard: null, progressReport: {} }).error).toMatch(/reportCard/);
  });
});

describe('report comment rules: kinds', () => {
  it('knows the two documents and their JSON keys', () => {
    expect(KINDS).toEqual(['report_card', 'progress_report']);
    expect(KEY).toEqual({ report_card: 'reportCard', progress_report: 'progressReport' });
    expect(isKind('report_card')).toBe(true);
    expect(isKind('reportCard')).toBe(false);
    expect(isKind(undefined)).toBe(false);
  });
});
