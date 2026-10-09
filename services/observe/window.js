const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const WINDOWS = {
  '1h': { spanMs: HOUR, bucket: '1 minute', bucketMs: MIN },
  '24h': { spanMs: DAY, bucket: '15 minutes', bucketMs: 15 * MIN },
  '7d': { spanMs: 7 * DAY, bucket: '1 hour', bucketMs: HOUR },
  '30d': { spanMs: 30 * DAY, bucket: '1 day', bucketMs: DAY },
};

// `to` is now rounded UP to the next bucket edge so the live bucket is
// included; `from` = to - span, which is then bucket-aligned too.
function parseWindow(key, now = Date.now()) {
  const k = Object.prototype.hasOwnProperty.call(WINDOWS, key) ? key : '24h';
  const { spanMs, bucket, bucketMs } = WINDOWS[k];
  const toMs = Math.ceil(now / bucketMs) * bucketMs;
  const fromMs = toMs - spanMs;
  return {
    key: k,
    from: new Date(fromMs),
    to: new Date(toMs),
    prevFrom: new Date(fromMs - spanMs),
    bucket,
    bucketMs,
    spanMs,
  };
}

module.exports = { parseWindow, WINDOWS };
