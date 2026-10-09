// The browser beacons its own failures here. Any signed-in user may post,
// verified or not (an unverified account is the one stuck in a redirect loop);
// the body is small, validated and truncated, then handed to the buffer.
const buffer = require('../services/observe/eventBuffer');
const { fingerprint } = require('../services/observe/fingerprint');

const KINDS = new Set(['js_error', 'unhandled_rejection', 'api_failure', 'render_error', 'redirect_loop']);
const MAX_EVENTS = 20;
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
// client_events.status is a SMALLINT; anything that isn't an HTTP status is dropped.
const httpStatus = (v) => (Number.isInteger(v) && v >= 100 && v <= 599 ? v : null);

const postClientEvents = (req, res) => {
  const events = req.body && req.body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ status: 'failed', message: 'events[] required' });
  }
  if (events.length > MAX_EVENTS) {
    return res.status(413).json({ status: 'failed', message: `At most ${MAX_EVENTS} events per batch` });
  }
  for (const e of events) {
    if (!e || typeof e !== 'object' || !KINDS.has(e.kind) || typeof e.message !== 'string' || !e.message.trim()) {
      return res.status(400).json({ status: 'failed', message: 'Each event needs a known kind and a message' });
    }
  }
  const user = req.user || {};
  const userAgent = clip(req.headers['user-agent'], 300);
  for (const e of events) {
    const page = clip(e.page, 300);
    const message = clip(e.message, 500);
    buffer.push('client_events', {
      user_id: user.userId || null,
      school: user.school || null,
      role: user.role || null,
      kind: e.kind,
      message,
      stack: clip(e.stack, 2000),
      page,
      user_agent: userAgent,
      request_id: clip(e.requestId, 100),
      status: httpStatus(e.status),
      fingerprint: fingerprint(page, message),
    });
  }
  return res.status(204).end();
};

module.exports = { postClientEvents, KINDS, MAX_EVENTS };
