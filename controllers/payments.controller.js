// controllers/payments.controller.js
//
// HTTP surface for Finance → Payments. For now that is the school's Stripe
// connection: its status, the link to Stripe's hosted sign-up, a re-check, and
// turning payments off. Everything here needs the `finance` permission
// (routes/payments.routes.js).

const ExcelJS = require('exceljs');
const db = require('../config/database');
const logger = require('../logger');
const connect = require('../services/payments/connect');
const charges = require('../services/payments/charges');
const chargeQueries = require('../queries/charges.queries');
const { formatCents } = require('../services/payments/paymentField');
const { paidWith } = require('../services/payments/emails');
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
  if (error instanceof charges.ChargeError) {
    return res.status(error.status).json({ status: 'failed', code: error.code, message: error.message });
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

// ─── The ledger ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['open', 'unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'waived']);

/** The Stripe mode this server works in; without a key, only the test-mode (offline) ledger. */
const livemodeOf = () => {
  const client = charges.clientOrNull();
  return client ? client.livemode : false;
};

/** Midnight on the first of this month, school time (every school is in Toronto today). */
function monthStart() {
  const now = new Date();
  const [y, m] = now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).split('-');
  // Toronto is UTC-5 or UTC-4; asking Postgres would be exact, but a few hours either side of midnight on the 1st is fine for a tile.
  return new Date(`${y}-${m}-01T05:00:00Z`);
}

const getSummary = async (req, res) => {
  try {
    const { rows: [row] } = await db.query(chargeQueries.summary, [req.user.school, livemodeOf(), monthStart()]);
    return ok(res, {
      collectedThisMonthCents: row.collected_this_month_cents,
      refundedThisMonthCents: row.refunded_this_month_cents,
      outstandingCents: row.outstanding_cents,
      outstandingCount: row.outstanding_count,
      openDisputes: row.open_disputes,
    });
  } catch (error) {
    return failStripe(res, error, 'load summary');
  }
};

function listParams(query) {
  const status = STATUSES.has(query.status) ? query.status : null;
  const formId = UUID_RE.test(String(query.formId || '')) ? query.formId : null;
  const search = String(query.q || '').trim().slice(0, 80) || null;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { status, formId, search, limit, page };
}

const listCharges = async (req, res) => {
  try {
    const { status, formId, search, limit, page } = listParams(req.query);
    const { rows } = await db.query(chargeQueries.listCharges, [req.user.school, livemodeOf(), limit, status, formId, search, (page - 1) * limit]);
    return res.status(200).json({
      status: 'success',
      data: rows.map((row) => charges.toCharge(row, { finance: true })),
      pagination: { total: rows[0] ? Number(rows[0].total_count) : 0, page, limit },
    });
  } catch (error) {
    return failStripe(res, error, 'list payments');
  }
};

const STATUS_LABELS = {
  unpaid: 'Unpaid', partially_paid: 'Part paid', paid: 'Paid', partially_refunded: 'Part refunded', refunded: 'Refunded', waived: 'Waived',
};

const exportCharges = async (req, res) => {
  try {
    const { status, formId, search } = listParams(req.query);
    const { rows } = await db.query(chargeQueries.listCharges, [req.user.school, livemodeOf(), 10000, status, formId, search, 0]);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Payments');
    sheet.addRow(['Date', 'For', 'Email', 'Status', 'Amount', 'Paid', 'Refunded', 'Still owed', 'Stripe fee', 'Paid with', 'Accounting code', 'Reference']);
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      const c = charges.toCharge(row, { finance: true });
      const last = row.last_payment;
      sheet.addRow([
        new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }),
        row.form_title || row.description,
        row.payer_email || '',
        STATUS_LABELS[row.status] || row.status,
        formatCents(c.amountCents),
        formatCents(c.amountPaidCents),
        c.amountRefundedCents ? formatCents(c.amountRefundedCents) : '',
        c.balanceCents ? formatCents(c.balanceCents) : '',
        c.stripeFeeCents ? formatCents(c.stripeFeeCents) : '',
        last ? paidWith({ kind: last.kind, card_brand: last.cardBrand, card_last4: last.cardLast4, wallet: last.wallet }) : '',
        row.accounting_code || '',
        String(row.charge_id).slice(0, 8).toUpperCase(),
      ]);
    }
    sheet.columns.forEach((col) => { col.width = 16; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Payments.csv"');
    await workbook.csv.write(res);
  } catch (error) {
    logger.error({ err: error }, 'Payments: export failed');
    if (!res.headersSent) fail(res, 500, 'Error exporting payments');
  }
};

const getCharge = async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.chargeId)) return fail(res, 404, 'Payment not found');
    const charge = await charges.detailForStaff({ school: req.user.school, livemode: livemodeOf(), chargeId: req.params.chargeId, finance: true });
    if (!charge) return fail(res, 404, 'Payment not found');
    return ok(res, charge);
  } catch (error) {
    return failStripe(res, error, 'load payment');
  }
};

/** Runs an office action on a charge and answers with the charge as it now stands. */
const action = (name, run) => async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.chargeId)) return fail(res, 404, 'Payment not found');
    const base = { school: req.user.school, livemode: livemodeOf(), chargeId: req.params.chargeId, user: req.user };
    await run(base, req.body || {}, req);
    const charge = await charges.detailForStaff({ ...base, finance: true });
    logger.info({ school: req.user.school, userId: req.user.userId, chargeId: req.params.chargeId, action: name }, `Payments: ${name}`);
    return ok(res, charge);
  } catch (error) {
    return failStripe(res, error, name);
  }
};

const recordOffline = action('offline payment recorded', (base, body) => charges.recordOffline({
  ...base, kind: body.kind, amountCents: body.amountCents ?? null, note: body.note, sendReceipt: body.sendReceipt !== false,
}));

const waive = action('fee waived', (base, body) => charges.waive({ ...base, note: body.note }));

const voidPayment = action('payment removed', (base, body, req) => {
  if (!UUID_RE.test(req.params.paymentId)) throw new charges.ChargeError('Payment not found', 404);
  return charges.voidPayment({ ...base, paymentId: req.params.paymentId });
});

const refund = action('refund issued', (base, body) => charges.refund({ ...base, amountCents: body.amountCents ?? null, note: body.note }));

const sendLink = action('payment link sent', (base) => charges.sendPaymentLink(base));

/** The school's payouts to its bank, straight from Stripe. */
const listPayouts = async (req, res) => {
  try {
    const client = stripeClient.clientFromEnv();
    const row = await connect.findAccount(req.user.school, client.livemode);
    if (!row || row.status === 'disconnected') return ok(res, { payouts: [], balance: null });
    const [payouts, balance] = await Promise.all([
      client.listPayouts(row.stripe_account_id, { limit: 20 }),
      client.retrieveBalance(row.stripe_account_id).catch(() => null),
    ]);
    const sum = (list) => (list || []).filter((b) => b.currency === 'cad').reduce((s, b) => s + b.amount, 0);
    return ok(res, {
      payouts: (payouts.data || []).map((p) => ({
        payoutId: p.id,
        amountCents: p.amount,
        currency: p.currency,
        status: p.status,
        arrivalDate: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString() : null,
        createdAt: p.created ? new Date(p.created * 1000).toISOString() : null,
        automatic: Boolean(p.automatic),
        failureMessage: p.failure_message || null,
      })),
      balance: balance ? { availableCents: sum(balance.available), pendingCents: sum(balance.pending) } : null,
    });
  } catch (error) {
    return failStripe(res, error, 'list payouts');
  }
};

module.exports = {
  getAccount, createOnboardingLink, syncAccount, disconnect,
  getSummary, listCharges, exportCharges, getCharge, recordOffline, waive, voidPayment, refund, sendLink, listPayouts,
};
