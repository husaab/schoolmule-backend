// The places that feed the alert counters.
const signals = require('../../../../../services/observe/alerts/signals');
const alertRequestCounter = require('../../../../../middleware/alertRequestCounter');
const { onLogLine } = require('../../../../../services/observe/logMirror');
const { postClientEvents } = require('../../../../../controllers/observeClientEvents.controller');

const sum = (field) => signals.snapshot().buckets.reduce((n, b) => n + b[field], 0);

function fakeRes(statusCode) {
  const handlers = {};
  return {
    statusCode,
    on: (event, fn) => { handlers[event] = fn; },
    finish: () => handlers.finish && handlers.finish(),
    status(code) { this.statusCode = code; return this; },
    end: jest.fn(),
    json: jest.fn(),
  };
}

beforeEach(() => signals.reset());
afterEach(() => {
  delete process.env.ALERTS_ENABLED;
});

describe('alertRequestCounter', () => {
  it('counts signed-out failures too', () => {
    process.env.ALERTS_ENABLED = 'true';
    const res = fakeRes(500);
    const next = jest.fn();
    alertRequestCounter({ originalUrl: '/api/auth/login', user: undefined }, res, next);
    res.finish();
    expect(next).toHaveBeenCalled();
    expect(sum('req')).toBe(1);
    expect(sum('s5xx')).toBe(1);
  });

  it('skips its own health checks and does nothing when alerts are off', () => {
    process.env.ALERTS_ENABLED = 'true';
    const health = fakeRes(503);
    alertRequestCounter({ originalUrl: '/api/health' }, health, jest.fn());
    health.finish();
    delete process.env.ALERTS_ENABLED;
    const off = fakeRes(500);
    alertRequestCounter({ originalUrl: '/api/classes' }, off, jest.fn());
    off.finish();
    expect(sum('req')).toBe(0);
  });
});

describe('log mirror', () => {
  const line = (obj) => JSON.stringify({ level: 50, time: Date.now(), ...obj });
  it('counts error lines, but not the alert engine’s own', () => {
    onLogLine(line({ msg: 'Error loading unread summary', err: { message: 'password authentication failed' } }));
    onLogLine(line({ msg: 'Alerts worker tick failed', observe: true }));
    onLogLine(JSON.stringify({ level: 40, msg: 'just a warning' }));
    expect(sum('logged')).toBe(1);
    const [entry] = [...signals.snapshot().buckets[0].errors.values()];
    expect(entry.message).toBe('Error loading unread summary: password authentication failed');
  });
});

describe('browser error beacons', () => {
  it('count errors but not notification-tap traces', () => {
    const res = fakeRes(204);
    postClientEvents({ body: { events: [{ kind: 'js_error', message: 'x' }, { kind: 'push_tap', message: 'tapped' }] }, headers: {} }, res);
    expect(sum('client')).toBe(1);
  });
});
