// services/payments/events.js
//
// What SchoolMule does with a Stripe event. The webhook endpoint stores an
// event only if a handler exists for its type (`handles`), and the worker
// hands each stored event to that handler (`processEvent`).
//
// A handler never trusts the event's own copy of an object: events arrive
// late, twice and out of order, so it reads the current state from Stripe.
// Every handler must be safe to run again for the same event.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/payments.queries');
const connect = require('./connect');
const charges = require('./charges');

/**
 * The school's account an account event is about. From a "Connected accounts"
 * destination it is the event's account; Accounts v2 sends these to a "Your
 * account" destination, where the account is the event's object instead.
 */
const accountOf = (event) => event.stripe_account_id
  || (String(event.object_id || '').startsWith('acct_') ? event.object_id : null);

/** Stripe changed something about a school's account: capabilities, requirements, payouts. */
async function accountUpdated(event, { client }) {
  const { rows } = await db.query(queries.selectAccountByStripeId, [accountOf(event), event.livemode]);
  // Not a school of ours (another account on the platform), or already turned off here.
  if (!rows[0]) return;
  await connect.refreshAccount(rows[0], client);
}

/** The school removed SchoolMule from its Stripe account, from Stripe's side. */
async function accountDeauthorized(event) {
  const { rows } = await db.query(queries.selectAccountByStripeId, [accountOf(event), event.livemode]);
  if (!rows[0]) return;
  const { rows: changed } = await db.query(queries.markAccountDeauthorized, [rows[0].payment_account_id]);
  if (changed[0]) logger.warn({ school: changed[0].school, stripeAccountId: rows[0].stripe_account_id }, 'Payments: a school disconnected SchoolMule from Stripe');
}

/** A family finished, abandoned or failed a Stripe payment page. */
async function checkoutSession(event, { client }) {
  // A platform-level session isn't one of ours: ours live on a school's account.
  if (!event.stripe_account_id || !event.object_id) return;
  await charges.fulfillSession({ client, accountId: event.stripe_account_id, sessionId: event.object_id });
}

/** Stripe's id of the card payment a charge, refund or dispute belongs to. */
async function paymentIntentOf(event, { client }) {
  const id = event.object_id || '';
  if (id.startsWith('ch_')) {
    const { rows } = await db.query(
      'SELECT stripe_payment_intent_id FROM charge_payments WHERE stripe_charge_id = $1 AND stripe_payment_intent_id IS NOT NULL LIMIT 1',
      [id],
    );
    if (rows[0]) return rows[0].stripe_payment_intent_id;
    const found = await client.request('GET', `/v1/charges/${id}`, { stripeAccount: event.stripe_account_id });
    return typeof found.payment_intent === 'string' ? found.payment_intent : found.payment_intent?.id || null;
  }
  if (id.startsWith('re_')) {
    const found = await client.request('GET', `/v1/refunds/${id}`, { stripeAccount: event.stripe_account_id });
    return typeof found.payment_intent === 'string' ? found.payment_intent : found.payment_intent?.id || null;
  }
  return null;
}

/** Money went back to a family: refunded here, or in the school's own Stripe Dashboard. */
async function refundChanged(event, { client }) {
  if (!event.stripe_account_id) return;
  const paymentIntentId = await paymentIntentOf(event, { client });
  if (!paymentIntentId) return;
  await charges.syncRefunds({ client, accountId: event.stripe_account_id, paymentIntentId });
}

/** A family disputed a card payment with their bank, or a dispute ended. */
async function disputeChanged(event, { client }) {
  if (!event.stripe_account_id || !String(event.object_id || '').startsWith('du_')) return;
  await charges.syncDispute({ client, accountId: event.stripe_account_id, disputeId: event.object_id });
}

const HANDLERS = {
  'account.updated': accountUpdated,
  'account.application.deauthorized': accountDeauthorized,
  'checkout.session.completed': checkoutSession,
  'checkout.session.async_payment_succeeded': checkoutSession,
  'checkout.session.async_payment_failed': checkoutSession,
  'checkout.session.expired': checkoutSession,
  'charge.refunded': refundChanged,
  'charge.refund.updated': refundChanged,
  'charge.dispute.created': disputeChanged,
  'charge.dispute.updated': disputeChanged,
  'charge.dispute.closed': disputeChanged,
};

const handles = (type) => Object.prototype.hasOwnProperty.call(HANDLERS, type);

/**
 * Keeps an event for the worker.
 * @returns 'stored', or 'duplicate' when Stripe had already delivered it
 */
async function store(event) {
  const { rows } = await db.query(queries.insertEvent, [
    event.id, event.livemode, event.type, event.account || null, event.data?.object?.id || null, event.created || null,
  ]);
  return rows[0] ? 'stored' : 'duplicate';
}

/** Runs the handler for one stored event (a stripe_events row). */
async function processEvent(row, { client }) {
  const handler = HANDLERS[row.type];
  // A type we stopped handling since it was stored: nothing to do.
  if (!handler) return;
  await handler(row, { client });
}

module.exports = { handles, store, processEvent, HANDLED_TYPES: Object.keys(HANDLERS) };
