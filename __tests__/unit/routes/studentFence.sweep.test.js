// The student fence, swept across the whole API. Routes are discovered from
// source (server.js mounts + each router's verbs), so a route added later is
// covered without touching this file: every token-guarded path outside the
// allowlist must answer a STUDENT token with 403 STUDENT_FORBIDDEN before any
// route code runs.
const fs = require('fs');
const http = require('http');
const path = require('path');
const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockStudentUser } = require('../../helpers/mockAuth');
const { isStudentAllowed } = require('../../../middleware/studentFence');

const ROOT = path.resolve(__dirname, '../../..');
const ID = '00000000-0000-4000-8000-000000000001';

function discoverRoutes() {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const guardAt = server.indexOf('app.use(verifyUser);');
  const files = Object.fromEntries(
    [...server.matchAll(/const (\w+) = require\(["']\.\/routes\/([\w.]+)["']\)/g)].map((m) => [m[1], m[2]]),
  );
  const out = [];
  for (const m of server.matchAll(/app\.use\(\s*["'](\/api\/[^"']+)["']\s*,([^)]*)\)/g)) {
    const varName = m[2].split(',').map((s) => s.trim()).pop();
    if (!files[varName]) continue;
    const src = fs.readFileSync(path.join(ROOT, 'routes', `${files[varName]}.js`), 'utf8');
    for (const r of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]([^\n]*)/g)) {
      // Guarded by the global verifyUser, by a verifyUser(.tokenOnly) on the
      // mount itself (/api/observe/client-events), or inline on the route.
      const guarded = m.index > guardAt || /verifyUser/.test(m[2]) || /verifyUser/.test(r[3]);
      if (!guarded) continue;
      const url = (m[1] + r[2]).replace(/:[A-Za-z_]+/g, ID).replace(/\/$/, '');
      out.push({ method: r[1], url });
    }
  }
  return out;
}

const ROUTES = discoverRoutes();
const toRow = (r) => [r.method.toUpperCase(), r.url];
const refused = ROUTES.filter((r) => !isStudentAllowed(r.url)).map(toRow);
const allowed = ROUTES.filter((r) => isStudentAllowed(r.url)).map(toRow);

// One server bound to 127.0.0.1 for the whole sweep: supertest always dials
// 127.0.0.1, and a fresh wildcard listen per request (its default) can share a
// port with another local process bound to 127.0.0.1, which then answers.
let server;
beforeAll((done) => { server = http.createServer(getApp()).listen(0, '127.0.0.1', done); });
afterAll((done) => { server.close(done); });
const asStudent = (method, url) =>
  request(server)[method.toLowerCase()](url).set('Authorization', `Bearer ${mockStudentUser()}`);

describe('student fence sweep', () => {
  it('found the whole API (parser sanity)', () => {
    expect(guardSanity()).toBe(true);
    expect(ROUTES.length).toBeGreaterThan(400);
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
});

// The parser keys on this exact line; if server.js stops using it the sweep
// would silently treat every mount as unguarded.
function guardSanity() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes('app.use(verifyUser);');
}
