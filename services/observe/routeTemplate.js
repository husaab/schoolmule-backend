const ID_SEG_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

// "/api/x/550e…/7?q=1" -> "/api/x/:id/:id"
function templateFromPath(path) {
  const clean = String(path || '').split('?')[0];
  return clean
    .split('/')
    .map((seg) => (ID_SEG_RE.test(seg) ? ':id' : seg))
    .join('/');
}

// Express leaves req.baseUrl (mount path) and req.route (matched layer) set
// when a handler responds without calling next(), which is every controller
// here. 404s have no route, so template the raw url instead.
function routeFor(req) {
  const routePath = req.route && typeof req.route.path === 'string' ? req.route.path : null;
  if (routePath !== null) {
    const base = req.baseUrl || '';
    return templateFromPath(base + (routePath === '/' ? '' : routePath)) || '/';
  }
  return templateFromPath(req.originalUrl || req.url || '/');
}

module.exports = { routeFor, templateFromPath };
