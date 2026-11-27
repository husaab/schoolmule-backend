// services/payments/webhookSignature.js
//
// Checks that a webhook really came from Stripe. Stripe signs the exact bytes
// it sent, together with the time it sent them:
//
//   Stripe-Signature: t=1700000000,v1=<hex HMAC-SHA256 of "t.body">[,v1=…]
//
// so the body must be the raw request body (never re-serialized JSON), and an
// old timestamp is refused so a captured request cannot be replayed later.

const crypto = require('crypto');

const DEFAULT_TOLERANCE_SECONDS = 300;

class WebhookSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

const hmac = (secret, timestamp, rawBody) =>
  crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');

function parseHeader(header) {
  const parts = { timestamp: null, signatures: [] };
  for (const item of String(header || '').split(',')) {
    const at = item.indexOf('=');
    if (at === -1) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (key === 't') parts.timestamp = value;
    else if (key === 'v1') parts.signatures.push(value);
  }
  return parts;
}

const sameHex = (a, b) => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Throws WebhookSignatureError unless `header` signs `rawBody` with one of
 * `secrets` and is no older than the tolerance.
 *
 * @param {object} opts
 * @param {Buffer|string} opts.rawBody  the request body exactly as received
 * @param {string}   opts.header        the Stripe-Signature header
 * @param {string[]} opts.secrets       this server's endpoint signing secrets
 * @param {number}   [opts.toleranceSeconds=300]
 * @param {number}   [opts.now]         milliseconds, for tests
 */
function verify({ rawBody, header, secrets, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() }) {
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') throw new WebhookSignatureError('The raw request body is not available');
  const { timestamp, signatures } = parseHeader(header);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new WebhookSignatureError('The Stripe-Signature header is missing or malformed');

  const matched = (secrets || []).some((secret) => {
    const expected = hmac(secret, timestamp, rawBody);
    return signatures.some((given) => sameHex(expected, given));
  });
  if (!matched) throw new WebhookSignatureError('No signature matches this server’s signing secret');

  const ageSeconds = Math.abs(now / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) throw new WebhookSignatureError('The signature is too old');
  return true;
}

/** The header Stripe would send for this body. For tests. */
function sign({ rawBody, secret, timestamp = Math.floor(Date.now() / 1000) }) {
  return `t=${timestamp},v1=${hmac(secret, timestamp, rawBody)}`;
}

/** The signing secrets this server accepts: STRIPE_WEBHOOK_SECRET, comma-separated when there is more than one endpoint. */
function secretsFromEnv() {
  return String(process.env.STRIPE_WEBHOOK_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { verify, sign, secretsFromEnv, WebhookSignatureError, DEFAULT_TOLERANCE_SECONDS };
