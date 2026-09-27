// services/finance/qboClient.js
//
// A small HTTP client for the QuickBooks Online v3 Accounting API, ported from
// the `qbo` bash wrapper: mandatory minorversion, one refresh-and-retry on
// 401, backoff on 429/5xx, and Fault detection under both spellings QBO uses.
//
// Everything that touches the network is injectable (fetchImpl, sleep) so the
// behaviour is unit-testable without a live realm.

const { buildQuery } = require('./qboQuery');
const { parseCdc } = require('./normalize');
const { NeedsReconnectError, QboApiError, QboThrottledError } = require('./errors');

const PROD_BASE = 'https://quickbooks.api.intuit.com';
const SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const MINOR_VERSION = 75;
const REQUEST_TIMEOUT_MS = 30 * 1000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 250);

function faultOf(json) {
  const fault = json?.Fault || json?.fault;
  if (!fault) return null;
  const first = (fault.Error || fault.error || [])[0] || {};
  return {
    code: first.code ? String(first.code) : null,
    message: first.Message || first.message || fault.type || 'QuickBooks fault',
    detail: first.Detail || first.detail || null,
    type: fault.type || null,
  };
}

/**
 * @param {object} opts
 * @param {string}   opts.school
 * @param {string}   opts.realmId
 * @param {Function} opts.getToken   async ({force}) => bearer token
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.onCall]   called once per HTTP request (for run accounting)
 * @param {number}   [opts.maxRetries=5]
 * @param {boolean}  [opts.sandbox]
 */
function createClient({
  school, realmId, getToken, fetchImpl = globalThis.fetch.bind(globalThis), sleep = defaultSleep,
  onCall = () => {}, maxRetries = 5, sandbox = process.env.QBO_ENV === 'sandbox',
}) {
  if (!/^\d+$/.test(String(realmId))) throw new Error(`Invalid QBO realm id: ${realmId}`);
  const base = `${sandbox ? SANDBOX_BASE : PROD_BASE}/v3/company/${realmId}/`;

  async function request(method, path, { body, query = {} } = {}) {
    // Percent-encode by hand (like the bash wrapper's jq @uri): URLSearchParams
    // would turn spaces into '+', which QBO's query parser does not accept.
    const params = { ...query, minorversion: String(MINOR_VERSION) };
    const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const url = `${base}${path}${path.includes('?') ? '&' : '?'}${qs}`;

    let refreshed = false;
    let forceNext = false;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = await getToken({ force: forceNext });
      forceNext = false;
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      let res;
      try {
        onCall();
        res = await fetchImpl(url, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < maxRetries) { attempt += 1; await sleep(jitter(Math.min(30000, 1000 * 2 ** attempt))); continue; }
        throw new QboApiError(`QuickBooks request failed: ${error.message}`, { retryable: true });
      }

      if (res.status === 401) {
        if (!refreshed) {
          // One forced refresh, then retry. A second 401 means the grant is dead.
          refreshed = true;
          forceNext = true;
          continue;
        }
        throw new NeedsReconnectError('QuickBooks rejected a freshly refreshed token');
      }

      if (res.status === 429) {
        if (attempt < maxRetries) {
          const retryAfter = Number(res.headers.get('Retry-After'));
          attempt += 1;
          // Honour Intuit's own wait exactly; only our guess gets jitter.
          await sleep(retryAfter > 0 ? retryAfter * 1000 : jitter(Math.min(60000, 5000 * 2 ** attempt)));
          continue;
        }
        throw new QboThrottledError();
      }

      if (res.status >= 500) {
        if (attempt < maxRetries) { attempt += 1; await sleep(jitter(Math.min(30000, 1000 * 2 ** attempt))); continue; }
        throw new QboApiError(`QuickBooks server error (${res.status})`, { status: res.status, retryable: true });
      }

      let json = null;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : {}; } catch { json = null; }

      const fault = faultOf(json);
      if (fault) {
        throw new QboApiError(fault.message, { status: res.status, code: fault.code, detail: fault.detail, retryable: false });
      }
      if (!res.ok) {
        throw new QboApiError(`QuickBooks HTTP ${res.status}`, { status: res.status, detail: text?.slice(0, 500), retryable: false });
      }
      if (json === null) {
        throw new QboApiError('QuickBooks returned a non-JSON body', { status: res.status, retryable: true });
      }
      return json;
    }
  }

  /** Runs one query statement and returns its QueryResponse ({} when empty). */
  async function query(sql) {
    const json = await request('GET', 'query', { query: { query: sql } });
    return json.QueryResponse || {};
  }

  /** Yields arrays of entities, one page at a time, until a short or empty page. */
  async function* queryPages({ entity, where = [], orderBy = 'Id', pageSize = 1000 }) {
    let start = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sql = buildQuery({ entity, where, orderBy, startPosition: start, maxResults: pageSize });
      const res = await query(sql);
      const rows = res[entity] || [];
      if (rows.length === 0) return;
      yield rows;
      if (rows.length < pageSize) return;
      start += pageSize;
    }
  }

  async function getEntity(type, id) {
    if (!/^\d+$/.test(String(id))) throw new Error(`Invalid QBO id: ${id}`);
    const json = await request('GET', `${type.toLowerCase()}/${id}`);
    return json[type] || json;
  }

  async function cdc(entities, changedSince) {
    const json = await request('GET', 'cdc', { query: { entities: entities.join(','), changedSince } });
    return parseCdc(json);
  }

  return { school, realmId: String(realmId), request, query, queryPages, getEntity, cdc };
}

module.exports = { createClient, QboApiError, QboThrottledError, NeedsReconnectError, MINOR_VERSION };
