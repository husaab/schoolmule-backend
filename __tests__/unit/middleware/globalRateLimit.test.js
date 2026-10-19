// The global request limiter (final review I3): a whole school's students and
// teachers share one public IP, so a signed-in request counts against its
// user (the verified token's user id) and only anonymous traffic, or a token
// that does not verify, counts against the network.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'unit-test-secret';
process.env.JWT_SECRET = SECRET;

const { rateLimitKey, createGlobalLimiter } = require('../../../middleware/globalRateLimit');

const tokenFor = (userId, secret = SECRET) => jwt.sign({ userId, role: 'STUDENT' }, secret, { expiresIn: '1h' });
const appWith = (max) => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createGlobalLimiter({ max, windowMs: 60 * 1000 }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
};
const ping = (app, { token, ip = '203.0.113.7' } = {}) => {
  const r = request(app).get('/ping').set('X-Forwarded-For', ip);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

describe('globalRateLimit', () => {
  it('keys a verified token by its user id and everything else by the network', () => {
    expect(rateLimitKey({ headers: { authorization: `Bearer ${tokenFor('u-1')}` }, ip: '203.0.113.7' })).toBe('user:u-1');
    expect(rateLimitKey({ headers: {}, ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
    expect(rateLimitKey({ headers: { authorization: 'Bearer not-a-token' }, ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
    // A token signed with another secret proves nothing: it counts against the network.
    expect(rateLimitKey({ headers: { authorization: `Bearer ${tokenFor('u-1', 'forged')}` }, ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
    const expired = jwt.sign({ userId: 'u-1' }, SECRET, { expiresIn: -10 });
    expect(rateLimitKey({ headers: { authorization: `Bearer ${expired}` }, ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
    expect(rateLimitKey({ headers: { authorization: 'Basic abc' }, ip: '203.0.113.7' })).toBe('ip:203.0.113.7');
  });

  it('users on one school network each get their own budget', async () => {
    const app = appWith(3);
    const amal = tokenFor('amal');
    for (let n = 0; n < 3; n += 1) expect((await ping(app, { token: amal })).status).toBe(200);
    expect((await ping(app, { token: amal })).status).toBe(429);
    // Same network, another student and an anonymous visitor: untouched.
    expect((await ping(app, { token: tokenFor('bilal') })).status).toBe(200);
    expect((await ping(app)).status).toBe(200);
  });

  it('anonymous requests (and tokens that do not verify) share the network budget', async () => {
    const app = appWith(2);
    expect((await ping(app)).status).toBe(200);
    expect((await ping(app, { token: tokenFor('x', 'forged') })).status).toBe(200);
    expect((await ping(app)).status).toBe(429);
    expect((await ping(app, { token: tokenFor('y', 'forged') })).status).toBe(429);
    // Another network has its own.
    expect((await ping(app, { ip: '198.51.100.9' })).status).toBe(200);
  });
});
