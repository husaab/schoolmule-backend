// services/payments/stripeClient.js
//
// A small HTTP client for the parts of Stripe that connect a school: creating
// its account, reading it back, and minting the hosted onboarding link. These
// are Accounts v2 endpoints (JSON bodies, Bearer auth).
//
// Everything that touches the network is injectable (fetchImpl, sleep) so the
// behaviour is unit-testable without a Stripe account, like qboClient.
//
// Two rules live here because every caller needs them:
//   - The API version is pinned. Stripe changes shapes between versions.
//   - A live key only works where STRIPE_LIVE_ENABLED=true (Railway). A local
//     backend uses the production database, so it must never hold a key that
//     can move real money.

const { StripeApiError, StripeConfigError } = require('./errors');

const BASE = 'https://api.stripe.com';
const DEFAULT_API_VERSION = '2026-11-18.endive';
const REQUEST_TIMEOUT_MS = 30 * 1000;

const ACCOUNT_RE = /^acct_[A-Za-z0-9]+$/;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * 250);

/** 'live' or 'test' from the key's prefix; anything else is not a secret key. */
function keyMode(secretKey) {
  if (/^(sk|rk)_live_/.test(secretKey || '')) return 'live';
  if (/^(sk|rk)_test_/.test(secretKey || '')) return 'test';
  return null;
}

/**
 * v1 bodies are form-encoded with nested keys:
 *   { line_items: [{ price_data: { currency: 'cad' } }] } → line_items[0][price_data][currency]=cad
 */
function formEncode(value, prefix = '', out = []) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => formEncode(v, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

/** v2 list parameters are written include[0]=a&include[1]=b. */
function toQueryString(query) {
  const parts = [];
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach((v, i) => parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(v)}`));
    else if (value !== undefined && value !== null) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

/**
 * @param {object} opts
 * @param {string}   opts.secretKey
 * @param {boolean}  [opts.liveEnabled]  whether this process may use a live key
 * @param {string}   [opts.apiVersion]
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleep]
 * @param {number}   [opts.maxRetries=3]
 */
function createClient({
  secretKey, liveEnabled = false, apiVersion = DEFAULT_API_VERSION,
  fetchImpl = globalThis.fetch.bind(globalThis), sleep = defaultSleep, maxRetries = 3,
}) {
  const mode = keyMode(secretKey);
  if (!mode) throw new StripeConfigError('STRIPE_SECRET_KEY is missing or is not a Stripe secret key');
  if (mode === 'live' && !liveEnabled) {
    throw new StripeConfigError('A live Stripe key is only allowed where STRIPE_LIVE_ENABLED=true');
  }

  /**
   * One call to Stripe. v2 paths take a JSON `body`; v1 paths take `form`
   * (form-encoded). `stripeAccount` makes the call as a school's own
   * account (a direct charge lives there, not on the platform).
   */
  async function request(method, path, { body, form, query, idempotencyKey, stripeAccount } = {}) {
    const qs = query ? toQueryString(query) : '';
    const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
    const headers = { Authorization: `Bearer ${secretKey}`, 'Stripe-Version': apiVersion, Accept: 'application/json' };
    let payload;
    if (form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = formEncode(form).join('&');
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (stripeAccount) {
      if (!ACCOUNT_RE.test(String(stripeAccount))) throw new Error(`Invalid Stripe account id: ${stripeAccount}`);
      headers['Stripe-Account'] = stripeAccount;
    }
    // A write is only repeated when Stripe can tell the repeat from a second request.
    const canRetry = method === 'GET' || Boolean(idempotencyKey);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let res;
      try {
        res = await fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        if (canRetry && attempt < maxRetries) { attempt += 1; await sleep(jitter(Math.min(8000, 500 * 2 ** attempt))); continue; }
        throw new StripeApiError(`Stripe request failed: ${error.message}`, { retryable: true });
      }

      if ((res.status === 429 || res.status >= 500) && canRetry && attempt < maxRetries) {
        attempt += 1;
        await sleep(jitter(Math.min(8000, 500 * 2 ** attempt)));
        continue;
      }

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch { json = null; }

      if (!res.ok) {
        const err = json?.error || {};
        throw new StripeApiError(err.message || `Stripe HTTP ${res.status}`, {
          status: res.status, code: err.code || null, type: err.type || null,
          retryable: res.status === 429 || res.status >= 500,
        });
      }
      if (json === null) throw new StripeApiError('Stripe returned a non-JSON body', { status: res.status, retryable: true });
      return json;
    }
  }

  const ACCOUNT_INCLUDE = ['configuration.merchant', 'requirements'];

  /**
   * A connected account the school owns outright: it is the merchant, it has
   * the full Stripe Dashboard, Stripe bills it and Stripe carries its losses.
   * None of that can be changed after creation.
   */
  function createAccount({ displayName, contactEmail, country, currency }, { idempotencyKey } = {}) {
    return request('POST', '/v2/core/accounts', {
      idempotencyKey,
      body: {
        display_name: displayName,
        contact_email: contactEmail,
        dashboard: 'full',
        identity: { country },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        defaults: { currency, responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
        include: ACCOUNT_INCLUDE,
      },
    });
  }

  function retrieveAccount(accountId) {
    if (!ACCOUNT_RE.test(String(accountId))) throw new Error(`Invalid Stripe account id: ${accountId}`);
    return request('GET', `/v2/core/accounts/${accountId}`, { query: { include: ACCOUNT_INCLUDE } });
  }

  /** A single-use link to Stripe's hosted sign-up. It expires in minutes. */
  function createAccountLink({ accountId, returnUrl, refreshUrl }) {
    return request('POST', '/v2/core/account_links', {
      body: {
        account: accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            // Ask for everything now, so a school is not interrupted mid-year.
            collection_options: { fields: 'eventually_due' },
            return_url: returnUrl,
            refresh_url: refreshUrl,
          },
        },
      },
    });
  }

  // ─── Payments, made on the school's own account (direct charges) ───

  const idOf = (prefix, id) => {
    if (!new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(String(id))) throw new Error(`Invalid Stripe ${prefix} id: ${id}`);
    return id;
  };

  /** A Stripe-hosted payment page for one charge. `params` is the v1 body. */
  function createCheckoutSession(accountId, params, { idempotencyKey } = {}) {
    return request('POST', '/v1/checkout/sessions', { form: params, stripeAccount: accountId, idempotencyKey });
  }

  /** With the payment, its charge and the charge's fee, so one read tells the whole story. */
  function retrieveCheckoutSession(accountId, sessionId) {
    return request('GET', `/v1/checkout/sessions/${idOf('cs', sessionId)}`, {
      stripeAccount: accountId,
      query: { expand: ['payment_intent.latest_charge.balance_transaction'] },
    });
  }

  /** Closes an open payment page so it can't be paid as well as a newer one. */
  function expireCheckoutSession(accountId, sessionId) {
    return request('POST', `/v1/checkout/sessions/${idOf('cs', sessionId)}/expire`, { form: {}, stripeAccount: accountId });
  }

  function retrievePaymentIntent(accountId, paymentIntentId) {
    return request('GET', `/v1/payment_intents/${idOf('pi', paymentIntentId)}`, {
      stripeAccount: accountId,
      query: { expand: ['latest_charge.balance_transaction'] },
    });
  }

  /** A refund of a card payment; `amount` in cents, the whole payment when left out. */
  function createRefund(accountId, { paymentIntentId, amount, metadata }, { idempotencyKey } = {}) {
    return request('POST', '/v1/refunds', {
      stripeAccount: accountId,
      idempotencyKey,
      form: { payment_intent: idOf('pi', paymentIntentId), amount, reason: 'requested_by_customer', metadata },
    });
  }

  function listRefunds(accountId, paymentIntentId) {
    return request('GET', '/v1/refunds', { stripeAccount: accountId, query: { payment_intent: idOf('pi', paymentIntentId), limit: 100 } });
  }

  function retrieveDispute(accountId, disputeId) {
    return request('GET', `/v1/disputes/${idOf('du', disputeId)}`, { stripeAccount: accountId });
  }

  function listPayouts(accountId, { limit = 20 } = {}) {
    return request('GET', '/v1/payouts', { stripeAccount: accountId, query: { limit } });
  }

  function retrieveBalance(accountId) {
    return request('GET', '/v1/balance', { stripeAccount: accountId });
  }

  return {
    mode, livemode: mode === 'live', request, createAccount, retrieveAccount, createAccountLink,
    createCheckoutSession, retrieveCheckoutSession, expireCheckoutSession, retrievePaymentIntent,
    createRefund, listRefunds, retrieveDispute, listPayouts, retrieveBalance,
  };
}

/** The client this process is configured for; throws StripeConfigError if none. */
function clientFromEnv() {
  return createClient({
    secretKey: process.env.STRIPE_SECRET_KEY,
    liveEnabled: process.env.STRIPE_LIVE_ENABLED === 'true',
    apiVersion: process.env.STRIPE_API_VERSION || DEFAULT_API_VERSION,
  });
}

module.exports = { createClient, clientFromEnv, keyMode, formEncode, DEFAULT_API_VERSION, StripeApiError, StripeConfigError };
