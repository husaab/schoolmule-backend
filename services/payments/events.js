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

/** Stripe changed something about a school's account: capabilities, requirements, payouts. */
async function accountUpdated(event, { client }) {
  const { rows } = await db.query(queries.selectAccountByStripeId, [event.stripe_account_id, event.livemode]);
  // Not a school of ours (another account on the platform), or already turned off here.
  if (!rows[0]) return;
  await connect.refreshAccount(rows[0], client);
}

/** The school removed SchoolMule from its Stripe account, from Stripe's side. */
async function accountDeauthorized(event) {
  const { rows } = await db.query(queries.selectAccountByStripeId, [event.stripe_account_id, event.livemode]);
  if (!rows[0]) return;
  const { rows: changed } = await db.query(queries.markAccountDeauthorized, [rows[0].payment_account_id]);
  if (changed[0]) logger.warn({ school: changed[0].school, stripeAccountId: event.stripe_account_id }, 'Payments: a school disconnected SchoolMule from Stripe');
}

const HANDLERS = {
  'account.updated': accountUpdated,
  'account.application.deauthorized': accountDeauthorized,
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
