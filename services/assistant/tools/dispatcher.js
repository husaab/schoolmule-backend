// services/assistant/tools/dispatcher.js
//
// How a Muley tool reads school data: by calling this backend's own routes
// over loopback HTTP with the signed-in person's own token and school year.
// Every guard a route has (the token check, permissions, the class and
// student guards, the school-year rules, the read-only rule for an admin
// preview) runs exactly as it does for the app, so a tool can never read
// more than the person could by opening the page.
//
// Tool handlers are given `read` and nothing else: there is no way to write
// from inside a tool. `write` exists for services/assistant/actions alone.

const config = require('../config');
const { ToolError } = require('../errors');
const { ROUTES } = require('./routes');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT_MS = 20_000;

/** The default transport: a real request to this server. -> { status, body } */
async function httpTransport({ method, path, headers, body }) {
  const response = await fetch(`${config.loopbackUrl()}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = await response.json().catch(() => null);
  return { status: response.status, body: answer };
}

/**
 * @param {{ token: string, schoolYearId?: string|null, requestId?: string,
 *   transport?: (req: {method: string, path: string, headers: object}) => Promise<{status: number, body: any}> }} options
 */
// Tests replace the real request with one that calls the app in-process.
let defaultTransport = httpTransport;
const __setTransportForTests = (replacement) => {
  defaultTransport = replacement || httpTransport;
};

function createDispatcher({ token, schoolYearId = null, requestId = 'assistant', transport = defaultTransport }) {
  let calls = 0;

  const pathOf = (routeId, route, params) => route.path.replace(/:(\w+)/g, (_match, name) => {
    const value = params[name];
    if (!UUID_RE.test(String(value))) throw new Error(`Route "${routeId}" needs a valid ${name}`);
    return value;
  });
  const headersFor = () => {
    calls += 1;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'schoolmule-assistant/1',
      'X-Request-Id': `${requestId}:${calls}`,
    };
    if (schoolYearId) headers['X-School-Year'] = schoolYearId;
    return headers;
  };

  /**
   * POST one of the named write routes. Only the actions service calls this,
   * for a change the person pressed Apply or Undo on. -> the route's JSON body.
   * Throws a ToolError carrying the route's own refusal message.
   */
  async function write(routeId, { params = {}, body } = {}) {
    const route = ROUTES[routeId];
    if (!route || route.method !== 'POST') throw new Error(`"${routeId}" is not a route a change can be written through`);
    let answer;
    try {
      answer = await transport({ method: 'POST', path: pathOf(routeId, route, params), headers: headersFor(), body });
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if (/needs a valid/.test(err.message)) throw err;
      throw new ToolError('WRITE_FAILED', 'SchoolMule could not be reached to save the change.');
    }
    if (answer.status >= 400 || !answer.body) {
      const said = answer.body && typeof answer.body.message === 'string' ? answer.body.message : null;
      const code = answer.status === 403 ? 'FORBIDDEN' : answer.status === 404 ? 'NOT_FOUND' : (answer.body && answer.body.code) || 'WRITE_REFUSED';
      throw new ToolError(code, said || 'SchoolMule refused the change.');
    }
    return answer.body;
  }

  /** GET one of the named routes. -> the route's JSON body. Throws a ToolError the model can read. */
  async function read(routeId, { params = {}, query = {} } = {}) {
    const route = ROUTES[routeId];
    if (!route || route.method !== 'GET') throw new Error(`"${routeId}" is not a route a tool can read`);

    const path = pathOf(routeId, route, params);
    const search = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString();

    let answer;
    try {
      answer = await transport({ method: 'GET', path: search ? `${path}?${search}` : path, headers: headersFor() });
    } catch (err) {
      throw new ToolError('READ_FAILED', 'That could not be loaded just now. Try again in a moment.');
    }
    if (answer.status === 403) throw new ToolError('FORBIDDEN', "This person's account doesn't have access to that.");
    if (answer.status === 404) throw new ToolError('NOT_FOUND', "That wasn't found.");
    if (answer.status === 429) throw new ToolError('BUSY', 'Too many requests at once. Wait a moment before trying again.');
    if (answer.status >= 400 || !answer.body) throw new ToolError('READ_FAILED', 'That could not be loaded just now.');
    return answer.body;
  }

  return { read, write };
}

module.exports = { createDispatcher, httpTransport, __setTransportForTests };
