// controllers/paymentsWebhook.controller.js
//
// Stripe's webhook. No JWT: the proof that a request is Stripe's is its
// signature over the raw body, so this route is mounted with a raw-body
// parser ahead of the JSON one (server.js).
//
// It does as little as possible: check the signature, keep the event, answer.
// The payments worker does the rest, so Stripe is never kept waiting and a
// failing step is retried by us.

const logger = require('../logger');
const stripeClient = require('../services/payments/stripeClient');
const { StripeConfigError } = require('../services/payments/errors');
const signature = require('../services/payments/webhookSignature');
const events = require('../services/payments/events');

const answer = (res, status, body) => res.status(status).json(body);

const receive = async (req, res) => {
  const secrets = signature.secretsFromEnv();
  let client;
  try {
    client = stripeClient.clientFromEnv();
  } catch (error) {
    if (!(error instanceof StripeConfigError)) throw error;
    client = null;
  }
  if (!client || secrets.length === 0) {
    // A 5xx makes Stripe try again later, by which time the server may be set up.
    logger.error({ hasKey: Boolean(client), hasSecret: secrets.length > 0 }, 'Payments: a Stripe webhook arrived but this server is not configured for it');
    return answer(res, 503, { status: 'failed', message: 'Payments are not set up on this server yet' });
  }

  try {
    signature.verify({ rawBody: req.body, header: req.get('stripe-signature'), secrets });
  } catch (error) {
    logger.warn({ reason: error.message }, 'Payments: a webhook with a bad signature was refused');
    return answer(res, 400, { status: 'failed', message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return answer(res, 400, { status: 'failed', message: 'Invalid body' });
  }
  if (!event || !/^evt_[A-Za-z0-9_]+$/.test(String(event.id)) || typeof event.type !== 'string' || typeof event.livemode !== 'boolean') {
    return answer(res, 400, { status: 'failed', message: 'Invalid event' });
  }

  // A live endpoint is also sent test events (and the reverse). Only this
  // server's own mode is its business.
  if (event.livemode !== client.livemode) return answer(res, 200, { received: true, kept: false, reason: 'other mode' });
  if (!events.handles(event.type)) return answer(res, 200, { received: true, kept: false, reason: 'not handled' });

  try {
    const outcome = await events.store(event);
    return answer(res, 200, { received: true, kept: outcome === 'stored' });
  } catch (error) {
    // Not kept: answer 5xx so Stripe delivers it again.
    logger.error({ err: error, eventId: event.id, type: event.type }, 'Payments: a Stripe event could not be stored');
    return answer(res, 500, { status: 'failed', message: 'Could not store the event' });
  }
};

module.exports = { receive };
