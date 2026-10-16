// Reads server.js and the routers it mounts, as source, and lists every route
// with whether a verifyUser (and so the student fence inside it) runs in front
// of it. Used by the student fence sweep.
//
// Anything the reader cannot classify is reported in `problems` rather than
// skipped, so a new kind of mount or route definition fails the sweep loudly
// instead of slipping past it: an /api mount that does not resolve to a
// ./routes/<file> variable, routes defined on `app` directly, router.route(),
// router.all(), path-mounted router.use(), a non-literal route path, or a
// chained route call.

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const ROUTER_NON_ROUTING = new Set(['param']); // router.param: id validation, no route
const APP_NON_ROUTING = new Set(['set', 'listen']);

// Blank out comments (keeping offsets and newlines) so commented-out code is
// never read as a route. String and template contents are left untouched.
function stripComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] ?? ''; i += 1; } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      if (i < src.length) out += '\n';
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close < 0 ? src.length : close + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    out += ch;
  }
  return out;
}

// The top-level arguments of the call whose "(" is at `open`, as trimmed
// source strings, and the index of the matching ")".
function readArgs(src, open) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = open + 1;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const last = src.slice(start, i).trim();
        if (last) args.push(last);
        return { args, end: i };
      }
      continue;
    }
    if (ch === ',' && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1; }
  }
  return { args, end: src.length };
}

// A plain string literal ('x', "x" or `x` without interpolation) → its text;
// anything else → null.
function literal(arg) {
  const m = /^(['"`])([^'"`]*)\1$/.exec(arg || '');
  if (!m || (m[1] === '`' && m[2].includes('${'))) return null;
  return m[2];
}

const isVerifyUser = (arg) => /^verifyUser(\.tokenOnly)?$/.test(arg);

const joinPath = (mount, sub) => (sub === '/' ? mount : `${mount}${sub}`).replace(/\/+$/, '') || '/';

function scanRouter(file, rawSrc, mount, mountGuarded, routes, problems) {
  const src = stripComments(rawSrc);
  const decls = [...src.matchAll(/\b(\w+)\s*=\s*(?:express\s*\.\s*)?Router\s*\(/g)].map((m) => m[1]);
  if (decls.length !== 1 || decls[0] !== 'router') {
    problems.push(`routes/${file}.js: expected exactly one "router = express.Router()", found [${decls.join(', ')}]`);
  }
  let fileGuardAt = -1; // router.use(verifyUser) guards every route after it
  for (const c of src.matchAll(/\brouter\s*\.\s*(\w+)\s*\(/g)) {
    const verb = c[1];
    const { args, end } = readArgs(src, c.index + c[0].length - 1);
    const where = `routes/${file}.js: router.${verb}(${args[0] ?? ''}, …)`;
    if (/^\s*\./.test(src.slice(end + 1))) problems.push(`${where}: chained calls are not read; declare one route per statement`);
    if (ROUTER_NON_ROUTING.has(verb)) continue;
    if (verb === 'use') {
      if (literal(args[0]) !== null || /^[[`'"]/.test(args[0] || '')) {
        problems.push(`${where}: path-mounted router.use is not read; mount the sub-router in server.js`);
      } else if (args.some(isVerifyUser) && fileGuardAt < 0) {
        fileGuardAt = c.index;
      }
      continue;
    }
    if (!ROUTE_VERBS.has(verb)) {
      problems.push(`${where}: router.${verb} is not read; use router.get/post/put/patch/delete`);
      continue;
    }
    const sub = literal(args[0]);
    if (sub === null) {
      problems.push(`${where}: the route path must be a string literal`);
      continue;
    }
    const guarded = mountGuarded || (fileGuardAt >= 0 && c.index > fileGuardAt) || args.slice(1).some(isVerifyUser);
    routes.push({ method: verb.toUpperCase(), path: joinPath(mount, sub), guarded });
  }
}

/**
 * @param {object} p
 * @param {string} p.serverSrc        server.js source
 * @param {(file: string) => string} p.readRouter  routes/<file>.js source
 * @param {string[]} p.nonRouterMounts  path mounts that are not routers (body parsers)
 * @param {string[]} p.globalMiddleware path-less app.use(...) arguments that are allowed
 * @returns {{ routes: {method: string, path: string, guarded: boolean}[], problems: string[] }}
 */
function inventory({ serverSrc, readRouter, nonRouterMounts = [], globalMiddleware = [] }) {
  const server = stripComments(serverSrc);
  const routes = [];
  const problems = [];

  const files = {};
  for (const m of server.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*(['"])\.\/routes\/([\w.]+)\2\s*\)/g)) {
    files[m[1]] = m[3];
  }

  const guardAt = server.search(/\bapp\.use\(\s*verifyUser\s*\)/);
  if (guardAt < 0) problems.push('server.js: no global app.use(verifyUser) guard found');

  for (const call of server.matchAll(/\bapp\s*\.\s*(\w+)\s*\(/g)) {
    const method = call[1];
    if (APP_NON_ROUTING.has(method)) continue;
    const { args } = readArgs(server, call.index + call[0].length - 1);
    const where = `server.js: app.${method}(${args.join(', ')})`;
    if (method !== 'use') {
      problems.push(`${where}: define routes in a router, not on app`);
      continue;
    }
    const mount = literal(args[0]);
    if (mount === null) {
      if (args.length !== 1 || !globalMiddleware.includes(args[0])) {
        problems.push(`${where}: unknown path-less middleware; add it to the sweep's list if it is not a router`);
      }
      continue;
    }
    if (nonRouterMounts.includes(mount)) continue;
    const routerVar = args[args.length - 1];
    if (args.length < 2 || !files[routerVar]) {
      problems.push(`${where}: cannot resolve the router to a "const x = require('./routes/<file>')"`);
      continue;
    }
    const mountGuarded = (guardAt >= 0 && call.index > guardAt) || args.slice(1, -1).some(isVerifyUser);
    scanRouter(files[routerVar], readRouter(files[routerVar]), mount, mountGuarded, routes, problems);
  }

  return { routes, problems };
}

module.exports = { inventory, stripComments, readArgs, literal };
