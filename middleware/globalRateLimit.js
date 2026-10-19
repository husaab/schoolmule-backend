// middleware/globalRateLimit.js
//
// The app-wide request limiter (1000 requests a minute). A school's students
// and teachers reach us from one public IP (the school's NAT), so keying on
// the IP alone let one lab period of students lock the whole school out
// (final review I3). A signed-in request counts against its user: the user id
// of a token that verifies with our secret. Anonymous traffic, and any token
// that does not verify (forged, expired, malformed), counts against the
// network as before, so a made-up token never buys a fresh budget. The
// sign-in limiters (spamProtection.js) are separate and unchanged.

const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 1000;

/** The limiter bucket for a request: `user:<id>` for a verified token, else `ip:<address>`. */
function rateLimitKey(req) {
  const header = req.headers && req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
      const id = decoded && (decoded.userId || decoded.sub);
      if (id) return `user:${id}`;
    } catch {
      // Not a token we issued (or no longer valid): the network's bucket.
    }
  }
  return `ip:${req.ip}`;
}

const createGlobalLimiter = ({ windowMs = WINDOW_MS, max = MAX_PER_WINDOW } = {}) => rateLimit({
  windowMs,
  max,
  keyGenerator: rateLimitKey,
});

const globalLimiter = createGlobalLimiter();

module.exports = { rateLimitKey, createGlobalLimiter, globalLimiter, WINDOW_MS, MAX_PER_WINDOW };
