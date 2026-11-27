// services/payments/connect.js
//
// Connecting a school to Stripe: open its account, send it to Stripe's hosted
// sign-up, and keep our copy of its status in step with Stripe's.
//
// The school is created as the merchant with the full Stripe Dashboard. Stripe
// collects its identity documents and bank details on its own pages; none of
// that passes through SchoolMule.

const db = require('../../config/database');
const queries = require('../../queries/payments.queries');
const stripeClient = require('./stripeClient');
const { StripeConfigError } = require('./errors');

// Every school today is Canadian (see finance/format.ts on the web). When a
// school elsewhere signs up this becomes a column on `schools`.
const COUNTRY = 'ca';
const CURRENCY = 'cad';

const PAYMENTS_PATH = '/finance/payments';

const DUE_NOW = new Set(['currently_due', 'past_due']);

/** The few facts we keep from a Stripe account object. */
function summarizeAccount(account) {
  const caps = account?.configuration?.merchant?.capabilities || {};
  // Entries Stripe itself is still working on are not the school's to fix.
  const dueNow = (account?.requirements?.entries || [])
    .filter((e) => e?.awaiting_action_from !== 'stripe' && DUE_NOW.has(e?.minimum_deadline?.status));
  return {
    cardPaymentsStatus: caps.card_payments?.status || null,
    payoutsStatus: caps.stripe_balance?.payouts?.status || null,
    requirementsDue: dueNow.length,
    requirementsPastDue: dueNow.some((e) => e.minimum_deadline.status === 'past_due'),
    displayName: account?.display_name || null,
  };
}

/**
 * One word for where the school stands.
 * `wasActive` separates a school still setting up from one that was taking
 * payments and has been stopped.
 */
function deriveStatus({ cardPaymentsStatus, requirementsDue, wasActive }) {
  if (cardPaymentsStatus === 'active') return 'active';
  if (wasActive) return 'restricted';
  if (requirementsDue > 0) return 'onboarding';
  if (cardPaymentsStatus === 'pending') return 'pending';
  return 'onboarding';
}

async function findAccount(school, livemode) {
  const { rows } = await db.query(queries.selectAccount, [school, livemode]);
  return rows[0] || null;
}

async function applyStripeAccount(row, account) {
  const summary = summarizeAccount(account);
  const status = deriveStatus({ ...summary, wasActive: Boolean(row.activated_at) });
  const { rows } = await db.query(queries.updateAccountFromStripe, [
    row.payment_account_id, status, summary.cardPaymentsStatus, summary.payoutsStatus,
    summary.requirementsDue, summary.requirementsPastDue, summary.displayName,
  ]);
  // No row back means it was disconnected meanwhile: report it as it now is.
  return rows[0] || findAccount(row.school, row.livemode);
}

/** Opens the school's Stripe account on first use; returns the existing row otherwise. */
async function ensureAccount({ school, user, client }) {
  const existing = await findAccount(school, client.livemode);
  if (existing) return existing;

  const { rows: schools } = await db.query(queries.selectSchoolForAccount, [school]);
  if (!schools[0]) {
    const error = new Error('School not found');
    error.status = 404;
    throw error;
  }

  // The key makes a double click, or a retry after a crash, land on the same
  // Stripe account instead of opening a second one.
  const account = await client.createAccount(
    { displayName: schools[0].name, contactEmail: schools[0].email || user.email, country: COUNTRY, currency: CURRENCY },
    { idempotencyKey: `schoolmule-account-${school}-${client.mode}` },
  );

  const { rows } = await db.query(queries.insertAccount, [
    school, client.livemode, account.id, schools[0].name, COUNTRY, CURRENCY, user.userId,
  ]);
  const row = rows[0] || await findAccount(school, client.livemode);
  return applyStripeAccount(row, account);
}

/**
 * A fresh link to Stripe's hosted sign-up for this school, creating its
 * account the first time. Links are single-use, so one is minted per click.
 */
async function startOnboarding({ school, user, client = stripeClient.clientFromEnv() }) {
  // Checked before Stripe is touched: a relative return URL would be refused
  // only after the school's account had already been opened.
  const appUrl = process.env.FRONTEND_URL;
  if (!/^https?:\/\//.test(appUrl || '')) throw new StripeConfigError('FRONTEND_URL is not set, so Stripe has nowhere to send the school back to');

  let row = await ensureAccount({ school, user, client });
  if (row.status === 'disconnected') {
    const { rows } = await db.query(queries.reconnectAccount, [row.payment_account_id, user.userId]);
    row = rows[0];
  }

  const link = await client.createAccountLink({
    accountId: row.stripe_account_id,
    // Coming back only means the school left Stripe's form, not that it finished.
    returnUrl: `${appUrl}${PAYMENTS_PATH}?stripe=return`,
    // Stripe sends an expired or reused link here; the page asks for a new one.
    refreshUrl: `${appUrl}${PAYMENTS_PATH}?stripe=refresh`,
  });
  return { url: link.url, account: row };
}

/**
 * Reads one connected account from Stripe and stores what changed. A failure
 * is noted on the row and thrown, so the caller decides whether to retry.
 */
async function refreshAccount(row, client) {
  if (row.status === 'disconnected') return row;
  let account;
  try {
    account = await client.retrieveAccount(row.stripe_account_id);
  } catch (error) {
    await db.query(queries.setAccountError, [row.payment_account_id, String(error.message || error).slice(0, 500)]);
    throw error;
  }
  return applyStripeAccount(row, account);
}

/** Reads the school's account from Stripe and stores what changed. */
async function syncAccount({ school, client = stripeClient.clientFromEnv() }) {
  const row = await findAccount(school, client.livemode);
  return row ? refreshAccount(row, client) : row;
}

/**
 * Turns payments off in SchoolMule. The school's Stripe account is theirs and
 * is left alone; reconnecting picks it up again.
 */
async function disconnect({ school, client = stripeClient.clientFromEnv() }) {
  const { rows } = await db.query(queries.disconnectAccount, [school, client.livemode]);
  return rows[0] || null;
}

module.exports = { summarizeAccount, deriveStatus, findAccount, startOnboarding, syncAccount, refreshAccount, disconnect, COUNTRY, CURRENCY };
