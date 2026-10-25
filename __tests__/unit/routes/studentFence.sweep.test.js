// The student fence, swept across the whole API. Routes are discovered from
// source (server.js mounts + each router's verbs, __tests__/helpers/
// routeInventory.js), so a route added later is covered without touching this
// file: every token-guarded path outside the allowlist must answer a STUDENT
// token with 403 STUDENT_FORBIDDEN before any route code runs.
//
// The fence lives inside verifyUser, so a route with no verifyUser in front of
// it is never fenced. Those routes are pinned below (UNFENCED_ROUTES), and the
// sweep fails on anything it cannot classify, so a new unguarded route or an
// unreadable mount breaks this test instead of slipping past it.
const fs = require('fs');
const http = require('http');
const path = require('path');
const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockStudentUser } = require('../../helpers/mockAuth');
const { inventory } = require('../../helpers/routeInventory');
const { isStudentAllowed } = require('../../../middleware/studentFence');

const ROOT = path.resolve(__dirname, '../../..');
const ID = '00000000-0000-4000-8000-000000000001';

// Routes with no verifyUser in front of them, so a student token is never
// fenced there. Each is public (works signed out) or self-authenticating and
// answers only about the caller. Adding one is a conscious decision: list it
// here with the reason.
const UNFENCED_ROUTES = [
  'GET /api/health',                                              // liveness probe
  'POST /api/auth/register',                                      // public signup
  'POST /api/auth/login',                                         // public sign-in
  'POST /api/auth/email-link',
  'POST /api/auth/google',                                        // public Google sign-in/up
  'POST /api/auth/apple',                                         // public Sign in with Apple (iOS app)
  'POST /api/auth/push-device/release',                           // the app's sign-out (session may have just expired)
  'POST /api/auth/student-qr',                                    // public QR-card sign-in, rate limited
  'POST /api/auth/student-invite',                                // public invite check, rate limited
  'POST /api/auth/student-invite/accept',                         // public invite acceptance, rate limited
  'POST /api/auth/student-request',                               // public student account request, rate limited
  'POST /api/auth/verify-email',                                  // public, rate limited
  'GET /api/auth/confirm-email',                                  // email link
  'POST /api/auth/logout',                                        // no data
  'POST /api/auth/request-password-reset',                        // public, rate limited
  'GET /api/auth/validate-reset-token',                           // email link
  'POST /api/auth/reset-password',                                // email link
  'GET /api/auth/me',                                             // validateSession: the caller's own session only
  'POST /api/email/contact',                                      // public contact form
  'GET /api/registration/public/:schoolSlug/:formSlug',           // public registration form
  'POST /api/registration/public/:schoolSlug/:formSlug/submit',   // public registration form
  'GET /api/registration/google/callback',                        // Google OAuth redirect (signed state)
  'GET /api/finance/qbo/callback',                                // Intuit OAuth redirect (signed state)
  'GET /api/schedule/public/:schoolSlug/:shareToken',             // shared schedule link
];

// server.js mounts on an /api path that are not routers.
const NON_ROUTER_MOUNTS = ['/api/finance/families/import']; // larger JSON body limit
// Path-less app.use(...) calls in server.js (global middleware, not routes).
const GLOBAL_MIDDLEWARE = [
  'cors(corsOptions)', 'express.json()', 'globalLimiter', 'httpLogger',
  'verifyUser', 'observeRequest', 'attachAccess', 'parentApiGate', 'resolveSchoolYear', 'errorHandler',
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INVENTORY = inventory({
  serverSrc: read('server.js'),
  readRouter: (file) => read(`routes/${file}.js`),
  nonRouterMounts: NON_ROUTER_MOUNTS,
  globalMiddleware: GLOBAL_MIDDLEWARE,
});
const label = (r) => `${r.method} ${r.path}`;
const toRow = (r) => [r.method, r.path.replace(/:[A-Za-z_]+/g, ID)];
const guarded = INVENTORY.routes.filter((r) => r.guarded);
const refused = guarded.filter((r) => !isStudentAllowed(toRow(r)[1])).map(toRow);
const allowed = guarded.filter((r) => isStudentAllowed(toRow(r)[1])).map(toRow);

// One server bound to 127.0.0.1 for the whole sweep: supertest always dials
// 127.0.0.1, and a fresh wildcard listen per request (its default) can share a
// port with another local process bound to 127.0.0.1, which then answers.
let server;
beforeAll((done) => { server = http.createServer(getApp()).listen(0, '127.0.0.1', done); });
afterAll((done) => { server.close(done); });
const asStudent = (method, url) =>
  request(server)[method.toLowerCase()](url).set('Authorization', `Bearer ${mockStudentUser()}`);

describe('student fence sweep', () => {
  it('classifies every mount and route in server.js and the routers (nothing skipped)', () => {
    expect(INVENTORY.problems).toEqual([]);
  });

  it('found the whole API (parser sanity)', () => {
    expect(guarded.length).toBeGreaterThan(400);
  });

  it('pins the unfenced surface: only the listed public routes skip verifyUser', () => {
    const unguarded = INVENTORY.routes.filter((r) => !r.guarded).map(label);
    expect([...unguarded].sort()).toEqual([...UNFENCED_ROUTES].sort());
  });

  it.each(refused)('refuses a STUDENT token: %s %s', async (method, url) => {
    const res = await asStudent(method, url);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  (allowed.length ? it.each(allowed) : it.skip.each([['-', '-']]))(
    'lets a STUDENT token through to allowlisted %s %s', async (method, url) => {
      const res = await asStudent(method, url);
      expect(res.body.code).not.toBe('STUDENT_FORBIDDEN');
    });

  it('also refuses a STUDENT token on a path no router knows (deny by default, not 404)', async () => {
    const res = await asStudent('GET', '/api/not-a-real-route');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it('refuses a STUDENT token whose path only differs in case or a trailing slash', async () => {
    for (const url of ['/api/Classes', '/API/CLASSES', '/api/classes/', '/api/students?next=/api/student']) {
      const res = await asStudent('GET', url);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STUDENT_FORBIDDEN');
    }
  });

  it('refuses a STUDENT token below the client-events beacon (an exact path, not a prefix)', async () => {
    const res = await asStudent('GET', '/api/observe/client-events/anything');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STUDENT_FORBIDDEN');
  });
});

// The reader itself: what it must refuse to skip.
describe('route inventory (the sweep\'s source reader)', () => {
  const SERVER_HEAD = `
    const verifyUser = require('./middleware/verifyUserMiddleware');
    const openRoutes = require("./routes/open.routes");
    const staffRoutes = require("./routes/staff.routes");
  `;
  const run = (serverBody, routers) => inventory({
    serverSrc: SERVER_HEAD + serverBody,
    readRouter: (file) => routers[file],
    globalMiddleware: ['verifyUser'],
  });
  const ROUTER = (body) => `const express = require('express');\nconst router = express.Router();\n${body}\nmodule.exports = router;`;

  it('reports a pre-guard route as unguarded and a post-guard one as guarded', () => {
    const inv = run(
      `app.use("/api/open", openRoutes);\napp.use(verifyUser);\napp.use("/api/staff", staffRoutes);`,
      { 'open.routes': ROUTER(`router.get('/x', h);`), 'staff.routes': ROUTER(`router.get('/y', h);`) },
    );
    expect(inv.problems).toEqual([]);
    expect(inv.routes).toEqual([
      { method: 'GET', path: '/api/open/x', guarded: false },
      { method: 'GET', path: '/api/staff/y', guarded: true },
    ]);
  });

  it('reads an inline verifyUser on a multi-line route, and router.use(verifyUser)', () => {
    const inv = run(
      `app.use("/api/open", openRoutes);\napp.use(verifyUser);`,
      { 'open.routes': ROUTER(`router.post(\n  '/a',\n  limiter,\n  verifyUser.tokenOnly,\n  h\n);\nrouter.get('/b', h);\nrouter.use(verifyUser);\nrouter.get('/c', h);`) },
    );
    expect(inv.problems).toEqual([]);
    expect(inv.routes.map((r) => [r.path, r.guarded])).toEqual([
      ['/api/open/a', true], ['/api/open/b', false], ['/api/open/c', true],
    ]);
  });

  it('ignores commented-out code', () => {
    const inv = run(
      `// app.use("/api/old", oldRoutes);\napp.use(verifyUser);\napp.use("/api/staff", staffRoutes);`,
      { 'staff.routes': ROUTER(`// router.all('/x', h);\n/* router.route('/y') */\nrouter.get('/z', h);`) },
    );
    expect(inv.problems).toEqual([]);
    expect(inv.routes.map(label)).toEqual(['GET /api/staff/z']);
  });

  it.each([
    ['an inline require', `app.use("/api/x", require("./routes/x.routes"));`],
    ['a sub-directory require', `const subRoutes = require("./routes/sub/x.routes");\napp.use("/api/x", subRoutes);`],
    ['an unknown router variable', `app.use("/api/x", mysteryRoutes);`],
    ['a non-literal mount path', `app.use(PREFIX, staffRoutes);`],
    ['a route defined on app', `app.get("/api/x", h);`],
    ['an unknown path-less middleware', `app.use(somethingNew);`],
  ])('fails on %s in server.js', (_name, body) => {
    const inv = run(`app.use(verifyUser);\n${body}`, { 'staff.routes': ROUTER('') });
    expect(inv.problems).toHaveLength(1);
  });

  it.each([
    ['router.route()', `router.route('/x').get(h);`],
    ['router.all()', `router.all('/x', h);`],
    ['a path-mounted router.use()', `router.use('/sub', subRouter);`],
    ['a non-literal route path', `router.get(PATH, h);`],
    ['an interpolated route path', 'router.get(`/${p}`, h);'],
    ['a chained route call', `router.get('/a', h).post('/b', h);`],
    ['a second router in the file', `const other = express.Router();\nother.get('/x', h);`],
  ])('fails on %s in a router', (_name, body) => {
    const inv = run(`app.use(verifyUser);\napp.use("/api/staff", staffRoutes);`, { 'staff.routes': ROUTER(body) });
    expect(inv.problems.length).toBeGreaterThan(0);
  });

  it('fails when server.js has no global verifyUser guard', () => {
    const inv = run(`app.use("/api/staff", staffRoutes);`, { 'staff.routes': ROUTER(`router.get('/y', h);`) });
    expect(inv.problems).toEqual([expect.stringContaining('no global app.use(verifyUser)')]);
  });
});
