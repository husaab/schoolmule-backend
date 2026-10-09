// Receives every pino line at level error or above (see logger.js) and
// turns it into an error_events row. This is how the ~150 controller
// catch blocks that call logger.error(...) reach the console without being
// edited: the request context supplies who and where.
const buffer = require('./eventBuffer');
const requestContext = require('./requestContext');
const { fingerprint } = require('./fingerprint');
const { routeFor } = require('./routeTemplate');

const AUTO_HTTP_ERR = /^failed with status code \d+$/;

function levelNumber(level) {
  if (typeof level === 'number') return level;
  return { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 }[level] || 0;
}

function shouldSkip(obj) {
  if (!obj || typeof obj !== 'object') return true;
  if (levelNumber(obj.level) < 50) return true;
  if (obj.observe === true) return true; // our own warnings/errors
  const errMsg = obj.err && obj.err.message;
  // pino-http logs its own line for every >=500 response; request_events
  // already carries that, and the controller's own line carries the cause.
  if (typeof errMsg === 'string' && AUTO_HTTP_ERR.test(errMsg)) return true;
  return false;
}

function onLogLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }
  if (shouldSkip(obj)) return false;
  try {
    const ctx = requestContext.get();
    const err = obj.err && typeof obj.err === 'object' ? obj.err : null;
    const base = typeof obj.msg === 'string' && obj.msg ? obj.msg : (err && err.message) || 'Unknown error';
    const message = err && err.message && err.message !== base ? `${base}: ${err.message}` : base;
    const route = ctx && ctx.req ? routeFor(ctx.req) : obj.url || null;
    buffer.push('error_events', {
      source: obj.source === 'process' ? 'process' : 'server',
      request_id: (ctx && ctx.requestId) || obj.reqId || null,
      user_id: (ctx && ctx.userId) || obj.userId || null,
      school: (ctx && ctx.school) || null,
      route,
      message: String(message).slice(0, 1000),
      stack: err && typeof err.stack === 'string' ? err.stack.slice(0, 2000) : null,
      fingerprint: fingerprint(route, message),
      context: obj.statusCode ? { statusCode: obj.statusCode } : null,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { onLogLine, shouldSkip };
