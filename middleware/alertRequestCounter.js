// Counts every response for the alert engine (services/observe/alerts),
// signed in or not. request_events only sees signed-in traffic, and a broken
// sign-in or signup page must still raise an alert. Mounted early in
// server.js; the user is read when the response finishes, by which time
// verifyUser has run.
const signals = require('../services/observe/alerts/signals');

// The worker's own health check every 30 s, and the browser's error beacons
// (counted as browser errors instead).
const SKIP = ['/api/health', '/api/observe/client-events'];

function alertRequestCounter(req, res, next) {
  if (process.env.ALERTS_ENABLED !== 'true') return next();
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (SKIP.some((p) => path === p || path.startsWith(`${p}/`))) return next();
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    signals.noteRequest({
      status: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      userId: (req.user && req.user.userId) || null,
    });
  });
  return next();
}

module.exports = alertRequestCounter;
