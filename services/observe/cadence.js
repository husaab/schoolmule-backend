// Request-cadence rules for the Observe scanner. The gaps themselves are
// computed in SQL (queries/observe.queries.js, scannerRoutes / scannerSuspects):
// a gap is the seconds between one user's consecutive requests to the same
// method+route, never measured across users, so two 30 s pollers offset by
// 15 s still read as 30 s. This module owns the thresholds and turns the raw
// per-route numbers into shares and a pattern label.
//
//   timer      steady median gap of 2 min or less with few bursts: a setInterval
//   duplicate  most gaps under BURST_THRESHOLD_S: the same fetch fired from
//              several mounted components, or an effect re-running per render
//   burst      a noticeable share of sub-2 s gaps, but not the majority

const BURST_THRESHOLD_S = 2;
const SUSPECT_MIN_REQUESTS = 200;
const SUSPECT_MAX_MEDIAN_GAP_S = 120;
const TIMER_MAX_MEDIAN_GAP_S = 120;
const DUPLICATE_MIN_BURST_SHARE = 0.3;
const BURST_MIN_SHARE = 0.1;
// Fewer gaps than this is a handful of clicks, not a pattern.
const PATTERN_MIN_GAPS = 5;

const THRESHOLDS = Object.freeze({
  burstGapS: BURST_THRESHOLD_S,
  suspectMinRequests: SUSPECT_MIN_REQUESTS,
  suspectMaxMedianGapS: SUSPECT_MAX_MEDIAN_GAP_S,
});

const share = (part, whole) => (whole > 0 ? part / whole : 0);

function patternOf({ gaps, medianGapS, burstShare }) {
  if (!(gaps >= PATTERN_MIN_GAPS)) return null;
  if (burstShare >= DUPLICATE_MIN_BURST_SHARE) return 'duplicate';
  if (medianGapS !== null && medianGapS !== undefined && medianGapS <= TIMER_MAX_MEDIAN_GAP_S && burstShare < BURST_MIN_SHARE) return 'timer';
  if (burstShare >= BURST_MIN_SHARE) return 'burst';
  return null;
}

// Raw SQL aggregates -> the cadence fields every scanner row carries.
// gaps/bursts are counts; medianGapS is null when there were no gaps.
function cadenceOf({ gaps, bursts, medianGapS }) {
  const n = Number(gaps) || 0;
  const median = n > 0 && medianGapS !== null && medianGapS !== undefined ? Number(medianGapS) : null;
  const burstShare = share(Number(bursts) || 0, n);
  return { gaps: n, medianGapS: median, burstShare, pattern: patternOf({ gaps: n, medianGapS: median, burstShare }) };
}

// One user hammering one route: more than minRequests in the window with a
// median gap under maxMedianGapS. The SQL applies the same bounds so only
// candidates come back; this is the single definition both sides share.
function isPollingSuspect({ requests, medianGapS }, { minRequests = SUSPECT_MIN_REQUESTS, maxMedianGapS = SUSPECT_MAX_MEDIAN_GAP_S } = {}) {
  if (!(requests > minRequests)) return false;
  if (medianGapS === null || medianGapS === undefined) return false;
  return medianGapS < maxMedianGapS;
}

module.exports = {
  BURST_THRESHOLD_S,
  SUSPECT_MIN_REQUESTS,
  SUSPECT_MAX_MEDIAN_GAP_S,
  PATTERN_MIN_GAPS,
  THRESHOLDS,
  share,
  patternOf,
  cadenceOf,
  isPollingSuspect,
};
