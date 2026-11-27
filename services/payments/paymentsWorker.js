// services/payments/paymentsWorker.js
//
// Drains the Stripe events inbox (stripe_events), which the webhook endpoint
// fills. Stripe is answered at once and the work happens here, so a slow or
// failing step is retried by us rather than by Stripe.
//
// Once per Toronto day it also re-reads every connected school's account, in
// case an event never arrived, and clears out old handled events.
//
// A process only ever claims events of its own Stripe mode: a backend with a
// test key (any local one) never touches a live event.
//
// IMPORTANT: startWorker() must only be called from a real server process
// (see the require.main guard in server.js).

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/payments.queries');
const stripeClient = require('./stripeClient');
const connect = require('./connect');
const events = require('./events');
const charges = require('./charges');
const requests = require('./requests');
const chargeQueries = require('../../queries/charges.queries');

const DEFAULT_INTERVAL_MS = 5000;
// 4^attempts seconds over six attempts spans roughly an hour.
const MAX_ATTEMPTS = 6;
const UNDEFINED_TABLE = '42P01';

let timer = null;
let draining = false;
let lastDailyDate = null;
let disabledReason = null;

const torontoDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

/** Worth another try later? Stripe saying "no" to the request itself is not. */
const isPermanent = (error) => error?.name === 'StripeApiError' && error.retryable === false;

/**
 * Process one event, if any is due.
 * @returns the number of events handled (0 or 1)
 */
async function drainOnce({ client = stripeClient.clientFromEnv() } = {}) {
  if (disabledReason) return 0;
  const { rows } = await db.query(queries.claimNextEvent, [client.livemode]);
  const event = rows[0];
  if (!event) return 0;

  const target = { eventId: event.event_id, type: event.type, stripeAccountId: event.stripe_account_id };
  try {
    await events.processEvent(event, { client });
    await db.query(queries.completeEvent, [event.event_id]);
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    if (isPermanent(error)) {
      await db.query(queries.failEventPermanently, [event.event_id, message]);
      logger.error({ ...target, err: error }, 'Payments: a Stripe event could not be handled and will not be retried');
      return 1;
    }
    const { rows: after } = await db.query(queries.failEvent, [event.event_id, message, MAX_ATTEMPTS]);
    if (after[0]?.state === 'failed') logger.error({ ...target, attempts: event.attempts, err: error }, 'Payments: a Stripe event failed every attempt');
    else logger.warn({ ...target, attempts: event.attempts, err: error.message }, 'Payments: a Stripe event failed; will retry');
  }
  return 1;
}

/** Drains until the inbox is empty, so a burst clears in one tick. */
async function drainAll({ client = stripeClient.clientFromEnv(), limit = 25 } = {}) {
  let handled = 0;
  while (handled < limit) {
    const n = await drainOnce({ client });
    if (n === 0) break;
    handled += n;
  }
  return handled;
}

/**
 * Re-reads every connected school's account from Stripe. One school failing
 * does not stop the rest.
 * @returns how many were refreshed
 */
async function refreshAllAccounts({ client = stripeClient.clientFromEnv() } = {}) {
  const { rows } = await db.query(queries.selectAccountsToRefresh, [client.livemode]);
  let refreshed = 0;
  for (const row of rows) {
    try {
      await connect.refreshAccount(row, client);
      refreshed += 1;
    } catch (error) {
      logger.warn({ school: row.school, stripeAccountId: row.stripe_account_id, err: error.message }, 'Payments: nightly account re-check failed');
    }
  }
  return refreshed;
}

/**
 * The safety net for card payments: a family who paid but whose webhook never
 * arrived, or a payment page that expired unnoticed. Asks Stripe about every
 * charge still waiting on a page after ten minutes, at most every five.
 * @returns how many were looked at
 */
async function checkStaleCheckouts({ client = stripeClient.clientFromEnv() } = {}) {
  const { rows } = await db.query(chargeQueries.selectStaleCheckouts, [client.livemode]);
  for (const row of rows) {
    try {
      const session = await client.retrieveCheckoutSession(row.stripe_account_id, row.checkout_session_id);
      if (session.status === 'open') {
        await db.query('UPDATE charges SET updated_at = now() WHERE charge_id = $1', [row.charge_id]);
      } else {
        await charges.fulfillSession({ client, accountId: row.stripe_account_id, session });
      }
    } catch (error) {
      await db.query('UPDATE charges SET updated_at = now() WHERE charge_id = $1', [row.charge_id]).catch(() => {});
      logger.warn({ chargeId: row.charge_id, err: error.message }, 'Payments: safety-net check of a payment page failed');
    }
  }
  return rows.length;
}

let lastStaleCheck = 0;
const STALE_CHECK_MS = 5 * 60 * 1000;

async function checkStaleIfDue({ client, now = Date.now() } = {}) {
  if (now - lastStaleCheck < STALE_CHECK_MS) return 0;
  lastStaleCheck = now;
  const looked = await checkStaleCheckouts({ client });
  await charges.fillMissingFees({ client });
  return looked;
}

/** The once-a-day work. Several server instances may each run it; it is idempotent. */
async function runDailyIfDue({ client = stripeClient.clientFromEnv(), today = torontoDate() } = {}) {
  if (today === lastDailyDate) return false;
  // Mark first so a failure does not make every tick retry it.
  lastDailyDate = today;
  const refreshed = await refreshAllAccounts({ client });
  const { rowCount } = await db.query(queries.purgeOldEvents, [client.livemode]);
  // Families who still owe on a request due within three days get one reminder.
  const reminded = await requests.sendDueSoonReminders({ livemode: client.livemode, today });
  logger.info({ refreshed, purged: rowCount, reminded }, 'Payments: daily account re-check done');
  return true;
}

function startWorker(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return;
  let client;
  try {
    client = stripeClient.clientFromEnv();
  } catch (error) {
    // No key, or a live key where live is not allowed: nothing to drain.
    logger.info({ reason: error.message }, 'Payments worker not started: Stripe is not configured');
    return;
  }
  disabledReason = null;
  // A restart part-way through the day must not re-run the daily work.
  lastDailyDate = torontoDate();

  timer = setInterval(async () => {
    // Skip a tick rather than overlapping runs; the next one picks up anyway.
    if (draining) return;
    draining = true;
    try {
      await runDailyIfDue({ client });
      await drainAll({ client });
      await checkStaleIfDue({ client });
    } catch (error) {
      if (error?.code === UNDEFINED_TABLE && !disabledReason) {
        disabledReason = 'the payments migrations have not been applied';
        stopWorker();
        logger.error(
          { migrations: ['payments_stripe_connect_migration.sql', 'payments_stripe_events_migration.sql', 'payments_form_charges_migration.sql', 'payments_requests_migration.sql'] },
          'Payments worker disabled: tables are missing. Apply the migrations and restart.',
        );
        return;
      }
      // Never let a worker error take the process down.
      logger.error({ err: error }, 'Payments worker tick failed');
    } finally {
      draining = false;
    }
  }, intervalMs);

  // Don't hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ intervalMs, mode: client.mode }, 'Payments worker started');
}

function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startWorker,
  stopWorker,
  drainOnce,
  drainAll,
  refreshAllAccounts,
  checkStaleCheckouts,
  runDailyIfDue,
  MAX_ATTEMPTS,
  isDisabled: () => disabledReason,
  // Test hook: forget the last daily date.
  _resetDaily: () => { lastDailyDate = null; },
};
