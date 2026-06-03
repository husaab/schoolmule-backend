const {
  median,
  quartiles,
  histogram,
  stdDev,
  mean,
  percentileRank,
  summarize,
  round1,
} = require('../../../utils/statsUtils');

describe('statsUtils', () => {
  describe('median', () => {
    it('returns null for empty input', () => {
      expect(median([])).toBeNull();
      expect(median(null)).toBeNull();
    });
    it('returns the value for a single element', () => {
      expect(median([42])).toBe(42);
    });
    it('returns middle value for odd length', () => {
      expect(median([3, 1, 2])).toBe(2);
    });
    it('returns mean of two middle values for even length', () => {
      expect(median([4, 1, 3, 2])).toBe(2.5);
    });
    it('does not mutate the input', () => {
      const input = [3, 1, 2];
      median(input);
      expect(input).toEqual([3, 1, 2]);
    });
  });

  describe('quartiles', () => {
    it('returns null for empty input', () => {
      expect(quartiles([])).toBeNull();
    });
    it('returns the same value for all quartiles with one element', () => {
      expect(quartiles([50])).toEqual({ q1: 50, median: 50, q3: 50 });
    });
    it('computes interpolated quartiles', () => {
      const q = quartiles([10, 20, 30, 40, 50]);
      expect(q.q1).toBe(20);
      expect(q.median).toBe(30);
      expect(q.q3).toBe(40);
    });
  });

  describe('histogram', () => {
    it('returns all-zero buckets for empty input', () => {
      const h = histogram([]);
      expect(h).toHaveLength(10);
      expect(h.every((b) => b.count === 0)).toBe(true);
    });
    it('places 100 in the top bucket', () => {
      const h = histogram([100]);
      expect(h[9].bucket).toBe('90-100');
      expect(h[9].count).toBe(1);
    });
    it('places boundary values in the correct bucket', () => {
      const h = histogram([0, 9.9, 10, 89.9, 90]);
      expect(h[0].count).toBe(2); // 0 and 9.9
      expect(h[1].count).toBe(1); // 10
      expect(h[8].count).toBe(1); // 89.9
      expect(h[9].count).toBe(1); // 90
    });
    it('ignores null and NaN values', () => {
      const h = histogram([null, NaN, 50]);
      expect(h.reduce((s, b) => s + b.count, 0)).toBe(1);
    });
  });

  describe('stdDev', () => {
    it('returns null for empty input', () => {
      expect(stdDev([])).toBeNull();
    });
    it('returns 0 for identical values', () => {
      expect(stdDev([5, 5, 5])).toBe(0);
    });
    it('computes population standard deviation', () => {
      expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    });
  });

  describe('mean', () => {
    it('returns null for empty input', () => {
      expect(mean([])).toBeNull();
    });
    it('computes the mean', () => {
      expect(mean([1, 2, 3])).toBe(2);
    });
  });

  describe('percentileRank', () => {
    it('returns null for empty cohort or null value', () => {
      expect(percentileRank(50, [])).toBeNull();
      expect(percentileRank(null, [1, 2])).toBeNull();
    });
    it('counts values strictly below', () => {
      expect(percentileRank(80, [60, 70, 80, 90])).toBe(50);
    });
    it('top of cohort is not 100', () => {
      expect(percentileRank(90, [60, 70, 80, 90])).toBe(75);
    });
  });

  describe('summarize', () => {
    it('returns null for empty input', () => {
      expect(summarize([])).toBeNull();
    });
    it('returns a full descriptive summary rounded to 1 decimal', () => {
      const s = summarize([60, 70, 80, 90]);
      expect(s).toEqual({
        count: 4,
        avg: 75,
        median: 75,
        min: 60,
        max: 90,
        stdDev: 11.2,
        q1: 67.5,
        q3: 82.5,
      });
    });
  });

  describe('round1', () => {
    it('passes null through', () => {
      expect(round1(null)).toBeNull();
    });
    it('rounds to one decimal', () => {
      expect(round1(72.449)).toBe(72.4);
      expect(round1(72.45)).toBe(72.5);
    });
  });
});
