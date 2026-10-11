const {
  share,
  patternOf,
  cadenceOf,
  isPollingSuspect,
  THRESHOLDS,
  BURST_THRESHOLD_S,
  SUSPECT_MIN_REQUESTS,
  SUSPECT_MAX_MEDIAN_GAP_S,
  PATTERN_MIN_GAPS,
} = require('../../../../services/observe/cadence');

describe('thresholds', () => {
  it('match the documented scanner rules', () => {
    expect(BURST_THRESHOLD_S).toBe(2);
    expect(SUSPECT_MIN_REQUESTS).toBe(200);
    expect(SUSPECT_MAX_MEDIAN_GAP_S).toBe(120);
    expect(THRESHOLDS).toEqual({ burstGapS: 2, suspectMinRequests: 200, suspectMaxMedianGapS: 120 });
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
  });
});

describe('share', () => {
  it('is a ratio, and 0 rather than NaN for an empty whole', () => {
    expect(share(1, 4)).toBe(0.25);
    expect(share(0, 0)).toBe(0);
    expect(share(3, 0)).toBe(0);
  });
});

describe('cadenceOf', () => {
  it('describes a steady 30 s poller', () => {
    expect(cadenceOf({ gaps: 249, bursts: 0, medianGapS: 30 })).toEqual({ gaps: 249, medianGapS: 30, burstShare: 0, pattern: 'timer' });
  });
  it('describes duplicate fetches (pairs 100 ms apart every minute)', () => {
    const c = cadenceOf({ gaps: 39, bursts: 20, medianGapS: 0.1 });
    expect(c.burstShare).toBeCloseTo(20 / 39, 5);
    expect(c.pattern).toBe('duplicate');
  });
  it('has a null median and no pattern with no gaps', () => {
    expect(cadenceOf({ gaps: 0, bursts: 0, medianGapS: null })).toEqual({ gaps: 0, medianGapS: null, burstShare: 0, pattern: null });
  });
  it('coerces pg numeric strings', () => {
    expect(cadenceOf({ gaps: '10', bursts: '5', medianGapS: '1.5' })).toEqual({ gaps: 10, medianGapS: 1.5, burstShare: 0.5, pattern: 'duplicate' });
  });
  it('treats a missing median as null even when gaps are counted', () => {
    expect(cadenceOf({ gaps: 3, bursts: 0, medianGapS: undefined }).medianGapS).toBeNull();
  });
});

describe('patternOf', () => {
  it('needs a minimum number of gaps', () => {
    expect(PATTERN_MIN_GAPS).toBe(5);
    expect(patternOf({ gaps: 4, medianGapS: 30, burstShare: 0 })).toBeNull();
    expect(patternOf({ gaps: 5, medianGapS: 30, burstShare: 0 })).toBe('timer');
  });
  it('calls a majority of sub-2 s gaps a duplicate, whatever the median', () => {
    expect(patternOf({ gaps: 50, medianGapS: 0.1, burstShare: 0.3 })).toBe('duplicate');
    expect(patternOf({ gaps: 50, medianGapS: 600, burstShare: 0.5 })).toBe('duplicate');
  });
  it('calls a steady gap of 120 s or less a timer', () => {
    expect(patternOf({ gaps: 50, medianGapS: 120, burstShare: 0 })).toBe('timer');
    expect(patternOf({ gaps: 50, medianGapS: 121, burstShare: 0 })).toBeNull();
    expect(patternOf({ gaps: 50, medianGapS: 30, burstShare: 0.09 })).toBe('timer');
  });
  it('calls 10-30% bursts a burst regardless of median', () => {
    expect(patternOf({ gaps: 50, medianGapS: 30, burstShare: 0.1 })).toBe('burst');
    expect(patternOf({ gaps: 50, medianGapS: 900, burstShare: 0.2 })).toBe('burst');
  });
  it('is null for slow, clean traffic', () => {
    expect(patternOf({ gaps: 50, medianGapS: 400, burstShare: 0 })).toBeNull();
    expect(patternOf({ gaps: 50, medianGapS: null, burstShare: 0 })).toBeNull();
  });
});

describe('isPollingSuspect', () => {
  it('flags more than 200 requests with a median gap under 120 s', () => {
    expect(isPollingSuspect({ requests: 250, medianGapS: 30 })).toBe(true);
  });
  it('is exclusive at both bounds', () => {
    expect(isPollingSuspect({ requests: 200, medianGapS: 30 })).toBe(false);
    expect(isPollingSuspect({ requests: 201, medianGapS: 120 })).toBe(false);
    expect(isPollingSuspect({ requests: 201, medianGapS: 119.9 })).toBe(true);
  });
  it('never flags a stream with no gaps', () => {
    expect(isPollingSuspect({ requests: 500, medianGapS: null })).toBe(false);
  });
  it('honours custom thresholds', () => {
    expect(isPollingSuspect({ requests: 5, medianGapS: 50 }, { minRequests: 3, maxMedianGapS: 60 })).toBe(true);
    expect(isPollingSuspect({ requests: 5, medianGapS: 50 }, { minRequests: 3, maxMedianGapS: 40 })).toBe(false);
  });
});
