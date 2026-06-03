// utils/statsUtils.js
//
// Pure statistical helpers for the analytics feature. No DB access.
// All functions tolerate empty input and return null (or empty arrays)
// rather than NaN so controllers can serialize results directly.

/**
 * Median of an array of numbers. Sorts a copy internally.
 * @param {number[]} values
 * @returns {number|null} null when values is empty
 */
function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Quartiles via linear interpolation (R-7 / Excel method).
 * @param {number[]} values
 * @returns {{ q1: number, median: number, q3: number }|null}
 */
function quartiles(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);

  const at = (p) => {
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };

  return { q1: at(0.25), median: at(0.5), q3: at(0.75) };
}

/**
 * Histogram of percentage values into fixed-size buckets.
 * Values >= 100 land in the top bucket so "90-100" is inclusive.
 * Always returns the full set of buckets (zero counts included) so
 * charts have a stable x-axis.
 * @param {number[]} values
 * @param {number} bucketSize
 * @returns {Array<{ bucket: string, min: number, max: number, count: number }>}
 */
function histogram(values, bucketSize = 10) {
  const bucketCount = Math.ceil(100 / bucketSize);
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const min = i * bucketSize;
    const isTop = i === bucketCount - 1;
    const max = isTop ? 100 : min + bucketSize - 1;
    buckets.push({ bucket: `${min}-${max}`, min, max, count: 0 });
  }

  for (const v of values || []) {
    if (v == null || Number.isNaN(v)) continue;
    const idx = v >= 100 ? bucketCount - 1 : Math.max(0, Math.floor(v / bucketSize));
    buckets[Math.min(idx, bucketCount - 1)].count += 1;
  }
  return buckets;
}

/**
 * Population standard deviation.
 * @param {number[]} values
 * @returns {number|null} null when values is empty
 */
function stdDev(values) {
  if (!values || values.length === 0) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Arithmetic mean.
 * @param {number[]} values
 * @returns {number|null} null when values is empty
 */
function mean(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Percentile rank: percentage of values strictly below `value`.
 * (A student at the top of a class of 20 gets 95, not 100.)
 * @param {number} value
 * @param {number[]} values - the cohort, unsorted is fine
 * @returns {number|null} 0-100, null when values is empty
 */
function percentileRank(value, values) {
  if (!values || values.length === 0 || value == null) return null;
  const below = values.filter((v) => v < value).length;
  return (below / values.length) * 100;
}

/**
 * Full descriptive summary used by every analytics endpoint.
 * @param {number[]} values
 * @returns {{ count, avg, median, min, max, stdDev, q1, q3 }|null}
 */
function summarize(values) {
  if (!values || values.length === 0) return null;
  const q = quartiles(values);
  return {
    count: values.length,
    avg: round1(mean(values)),
    median: round1(q.median),
    min: round1(Math.min(...values)),
    max: round1(Math.max(...values)),
    stdDev: round1(stdDev(values)),
    q1: round1(q.q1),
    q3: round1(q.q3),
  };
}

/** Round to 1 decimal, passing null through. */
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}

module.exports = {
  median,
  quartiles,
  histogram,
  stdDev,
  mean,
  percentileRank,
  summarize,
  round1,
};
