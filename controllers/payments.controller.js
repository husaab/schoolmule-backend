// controllers/payments.controller.js
//
// HTTP surface for Finance → Payments. For now that is the school's Stripe
// connection: its status, the link to Stripe's hosted sign-up, a re-check, and
// turning payments off. Everything here needs the `finance` permission
// (routes/payments.routes.js).

const logger = require('../logger');
const connect = require('../services/payments/connect');
const stripeClient = require('../services/payments/stripeClient');
const { StripeApiError, StripeConfigError } = require('../services/payments/errors');

const fail = (res, status, message) => res.status(status).json({ status: 'failed', message });
const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

const toAccount = (row) => (row ? {
  connected: row.status !== 'disconnected',
  status: row.status,
  canTakePayments: row.status === 'active',
  stripeAccountId: row.stripe_account_id,
  livemode: row.livemode,
  cardPaymentsStatus: row.card_payments_status,
  payoutsStatus: row.payouts_status,
  requirementsDue: row.requirements_due,
  requirementsPastDue: row.requirements_past_due,
  displayName: row.display_name,
  currency: row.default_currency,
  activatedAt: row.activated_at,
  lastSyncedAt: row.last_synced_at,
  // last_error holds Stripe's own words; it stays on the server (and in the log).
  syncFailed: Boolean(row.last_error),
  connectedAt: row.connected_at,
  disconnectedAt: row.disconnected_at,
} : null);

/** One answer for every way a Stripe call can fail, with the detail kept in the log. */
function failStripe(res, error, action) {
  if (error instanceof StripeConfigError) {
    logger.error({ err: error }, `Payments: ${action} refused, Stripe is not configured`);
    return fail(res, 503, 'Payments are not set up on this server yet');
  }
  if (error instanceof StripeApiError) {
    logger.error({ err: error, stripeCode: error.code, stripeStatus: error.status }, `Payments: Stripe call failed (${action})`);
    return fail(res, 502, 'Stripe could not complete that. Please try again in a moment.');
  }
  if (error.status === 404) return fail(res, 404, error.message);
  logger.error({ err: error }, `Payments: error (${action})`);
  return fail(res, 500, 'Something went wrong with payments');
}

/** The school's connection, without calling Stripe. `configured` is false until the server has a key. */
const getAccount = async (req, res) => {
  let client;
  try {
    client = stripeClient.clientFromEnv();
  } catch (error) {
    if (error instanceof StripeConfigError) return ok(res, { configured: false, mode: null, account: null });
    return failStripe(res, error, 'load account');
  }
  try {
    const row = await connect.findAccount(req.user.school, client.livemode);
    return ok(res, { configured: true, mode: client.mode, account: toAccount(row) });
  } catch (error) {
    return failStripe(res, error, 'load account');
  }
};

/** A single-use link to Stripe's hosted sign-up; opens the school's account the first time. */
const createOnboardingLink = async (req, res) => {
  try {
    const { url, account } = await connect.startOnboarding({ school: req.user.school, user: req.user });
    logger.info({ school: req.user.school, userId: req.user.userId, stripeAccountId: account.stripe_account_id }, 'Payments: Stripe onboarding link created');
    return ok(res, { url, account: toAccount(account) }, 201);
  } catch (error) {
    return failStripe(res, error, 'create onboarding link');
  }
};

/** Re-reads the school's account from Stripe, for the moment it comes back from the sign-up. */
const syncAccount = async (req, res) => {
  try {
    const row = await connect.syncAccount({ school: req.user.school });
    if (!row) return fail(res, 404, 'Stripe is not connected');
    return ok(res, { account: toAccount(row) });
  } catch (error) {
    return failStripe(res, error, 'sync account');
  }
};

const disconnect = async (req, res) => {
  try {
    const row = await connect.disconnect({ school: req.user.school });
    if (!row) return fail(res, 404, 'Stripe is not connected');
    logger.info({ school: req.user.school, userId: req.user.userId, stripeAccountId: row.stripe_account_id }, 'Payments: Stripe disconnected');
    return ok(res, { account: toAccount(row) });
  } catch (error) {
    return failStripe(res, error, 'disconnect');
  }
};

module.exports = { getAccount, createOnboardingLink, syncAccount, disconnect };
