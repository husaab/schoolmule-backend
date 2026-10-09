// Records every authenticated request into request_events once the
// response has finished, and keeps users.last_seen_at warm. Mounted right
// after verifyUser so req.user is populated. Must never throw.
const db = require('../config/database');
const logger = require('../logger');
const buffer = require('../services/observe/eventBuffer');
const requestContext = require('../services/observe/requestContext');
const { routeFor } = require('../services/observe/routeTemplate');

const LAST_SEEN_MS = 5 * 60 * 1000;
const lastSeen = new Map();

function touchLastSeen(userId) {
  const now = Date.now();
  if (now - (lastSeen.get(userId) || 0) < LAST_SEEN_MS) return false;
  lastSeen.set(userId, now);
  db.query('UPDATE users SET last_seen_at = NOW() WHERE user_id = $1', [userId]).catch((err) => {
    logger.warn({ observe: true, err }, 'observe: last_seen update failed');
  });
  return true;
}

const stripQuery = (url) => String(url || '').split('?')[0];

function observeRequest(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const user = req.user || {};
  const ctx = {
    requestId: req.id || res.getHeader('X-Request-Id') || null,
    userId: user.userId || null,
    school: user.school || null,
    role: user.role || null,
    req,
  };

  // Controllers answer with res.json({ message }) on failure; keep the
  // message so a 500 row says why without touching 150 catch blocks.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && typeof body.message === 'string') {
      res.locals.observeMessage = body.message;
    }
    return originalJson(body);
  };

  let recorded = false;
  res.on('finish', () => {
    if (recorded) return;
    recorded = true;
    try {
      const status = res.statusCode;
      buffer.push('request_events', {
        request_id: ctx.requestId,
        user_id: ctx.userId,
        school: ctx.school,
        role: ctx.role,
        impersonator_id: user.impersonator ? user.impersonator.userId || null : null,
        method: req.method,
        route: routeFor(req),
        path: stripQuery(req.originalUrl || req.url),
        status,
        duration_ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
        ip: req.ip || null,
        user_agent: (req.headers && req.headers['user-agent']) || null,
        error_message: status >= 400 && res.locals.observeMessage ? String(res.locals.observeMessage).slice(0, 500) : null,
      });
    } catch (err) {
      logger.warn({ observe: true, err }, 'observe: request capture failed');
    }
  });

  if (ctx.userId && !user.impersonator) touchLastSeen(ctx.userId);

  requestContext.run(ctx, next);
}

observeRequest.LAST_SEEN_MS = LAST_SEEN_MS;
observeRequest._resetLastSeen = () => lastSeen.clear();

module.exports = observeRequest;
