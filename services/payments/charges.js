// services/payments/charges.js
//
// The payments ledger: what a family owes (a charge) and what happened to it
// (its payments). A form response with a payment field makes a charge; Stripe
// Checkout, the office (cash, cheque, a waiver) and refunds settle it.
//
// Rules this module keeps:
//   - Totals and status are recomputed from the payments every time
//     (chargeStatus.deriveCharge), inside the same transaction as the change.
//   - A card payment is recorded from Stripe's own copy of the Checkout
//     session, never from the family's browser, and only once per session.
//   - Every Stripe call is made on the school's own account (a direct charge).
//   - Nothing about a student goes to Stripe: the description is the form's
//     title and the metadata is our charge id.
//   - Tax lives on each line (its own copy of the rate), so a rate edited or
//     removed later never changes a charge. amount_cents is what the family
//     owes: the prices plus any tax added on top.

const db = require('../../config/database');
const logger = require('../../logger');
const q = require('../../queries/charges.queries');
const accountQueries = require('../../queries/payments.queries');
const stripeClient = require('./stripeClient');
const { StripeConfigError } = require('./errors');
const { deriveCharge, balanceCents, refundableCents, canPayOnline } = require('./chargeStatus');
const { formatCents } = require('./paymentField');
const tax = require('./tax');
const emails = require('./emails');

// How long a Stripe payment page stays open. An unpaid one then expires and
// the family gets one email with a link to finish paying.
const CHECKOUT_MINUTES = 60;
const OFFLINE_KINDS = new Set(['cash', 'cheque', 'other']);

class ChargeError extends Error {
  /** @param data  optional details for the answer (e.g. the charge a 409 points at) */
  constructor(message, status = 409, code = null, data = undefined) {
    super(message);
    this.name = 'ChargeError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const appUrl = () => process.env.FRONTEND_URL || '';
const payPageUrl = (token) => `${appUrl()}/pay/${token}`;

/** The client this server is configured for, or null when payments are off here. */
function clientOrNull() {
  try {
    return stripeClient.clientFromEnv();
  } catch (error) {
    if (error instanceof StripeConfigError) return null;
    throw error;
  }
}

/**
 * Whether a school can take card payments right now in this server's mode.
 * @returns {{ client, account, online: boolean }}
 */
async function availability(school, client = clientOrNull()) {
  if (!client) return { client: null, account: null, online: false };
  const { rows } = await db.query(accountQueries.selectAccount, [school, client.livemode]);
  const account = rows[0] || null;
  return { client, account, online: Boolean(account && account.status === 'active') };
}

// ─── Shaping ──────────────────────────────────────────────────────────

const toLine = (row) => ({
  lineId: row.line_id,
  itemId: row.item_id,
  label: row.label,
  amountCents: row.amount_cents,
  taxCents: row.tax_cents || 0,
  taxName: row.tax_name || null,
  taxRateMilli: row.tax_rate_milli ?? null,
  taxIncluded: Boolean(row.tax_included),
});

/**
 * A payment as staff see it. The office's note and who recorded it are only
 * for holders of `finance`.
 */
const toPayment = (row, { finance }) => ({
  paymentId: row.payment_id,
  kind: row.kind,
  amountCents: row.amount_cents,
  status: row.status,
  cardBrand: row.card_brand,
  cardLast4: row.card_last4,
  wallet: row.wallet,
  stripeFeeCents: finance ? row.stripe_fee_cents : null,
  note: finance ? row.note : null,
  recordedByName: finance ? row.recorded_by_name || null : null,
  createdAt: row.created_at,
  voidedAt: row.voided_at,
});

/**
 * A waived fee is private: staff without `finance` see it as settled, like a
 * paid one, so a family's assistance isn't visible to every teacher.
 */
const visibleStatus = (status, finance) => (!finance && status === 'waived' ? 'settled' : status);

function toCharge(row, { finance = false, lines, payments } = {}) {
  const charge = {
    chargeId: row.charge_id,
    sourceType: row.source_type,
    submissionId: row.submission_id,
    formId: row.form_id,
    formTitle: row.form_title ?? null,
    requestId: row.request_id ?? null,
    requestTitle: row.request_title ?? null,
    dueDate: row.due_date ?? null,
    studentId: row.student_id ?? null,
    studentName: row.student_name ?? null,
    studentGrade: row.student_grade ?? null,
    description: row.description,
    payerEmail: row.payer_email,
    currency: row.currency,
    amountCents: row.amount_cents,
    taxCents: row.tax_cents || 0,
    amountPaidCents: row.amount_paid_cents,
    amountRefundedCents: row.amount_refunded_cents,
    status: visibleStatus(row.status, finance),
    chosenMethod: row.chosen_method,
    paidAt: row.paid_at,
    disputeStatus: row.dispute_status,
    accountingCode: finance ? row.accounting_code : null,
    linkSentAt: row.link_sent_at,
    createdAt: row.created_at,
  };
  charge.balanceCents = balanceCents({ ...charge, status: row.status });
  if (row.last_payment !== undefined) charge.lastPayment = row.last_payment || null;
  if (row.stripe_fee_cents !== undefined && finance) charge.stripeFeeCents = Number(row.stripe_fee_cents) || 0;
  if (lines) {
    charge.lines = lines.map(toLine);
    charge.taxSummary = tax.summarize(charge.lines);
  }
  if (payments) {
    const visible = finance ? payments : payments.filter((p) => p.kind !== 'waiver');
    charge.payments = visible.map((p) => toPayment(p, { finance }));
    charge.refundableCents = finance ? refundableCents(payments.map(paymentFacts)) : 0;
  }
  return charge;
}

const paymentFacts = (row) => ({ kind: row.kind, status: row.status, amountCents: row.amount_cents, createdAt: row.created_at, intent: row.stripe_payment_intent_id });

// ─── The ledger itself ────────────────────────────────────────────────

/** Recomputes a charge's totals and status from its payments. Run inside the caller's transaction. */
async function recompute(tx, chargeId) {
  const { rows: [charge] } = await tx.query(q.selectChargeForUpdate, [chargeId]);
  if (!charge) return null;
  const { rows: payments } = await tx.query(q.selectPayments, [chargeId]);
  const next = deriveCharge(charge.amount_cents, payments.map(paymentFacts));
  const { rows: [updated] } = await tx.query(q.updateChargeTotals, [
    chargeId, next.status, next.amountPaidCents, next.amountRefundedCents, next.paidAt,
  ]);
  return updated;
}

/** Runs `work(tx)` in one transaction. */
async function inTransaction(work) {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await work(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

/** A charge line's insert parameters, its tax included. */
const lineParams = (chargeId, line, i) => [
  chargeId, line.itemId ?? null, line.label, line.amountCents, i,
  line.taxCents || 0, line.taxName || null, line.taxRateMilli ?? null, Boolean(line.taxIncluded),
];

/**
 * Makes the charge for a form response, inside the response's own
 * transaction. `priced` comes from paymentField.priceSelection: its
 * totalCents (what the family owes) includes any tax added on top.
 */
async function createForSubmission(tx, { school, livemode, submissionId, form, field, priced, method, payerEmail, studentId = null, account = null }) {
  const { rows: [charge] } = await tx.query(q.insertCharge, [
    school, livemode, submissionId, form.form_id, field.field_id, studentId, payerEmail || null,
    String(form.title || 'School payment').slice(0, 200), field.payment_config?.currency || 'cad',
    priced.totalCents, method, field.payment_config?.accountingCode || null, account?.payment_account_id || null,
    priced.taxCents || 0,
  ]);
  for (const [i, line] of priced.lines.entries()) {
    await tx.query(q.insertLine, lineParams(charge.charge_id, line, i));
  }
  return charge;
}

// ─── Stripe Checkout ──────────────────────────────────────────────────

/**
 * The items on Stripe's page: the form's lines and, when tax is added on top,
 * one line per rate ("HST (13%)") so they still sum to what is owed. Tax
 * already inside the prices adds nothing. When part is already paid, one
 * "balance" line instead.
 */
function checkoutLines(charge, lines) {
  const balance = balanceCents({ amountCents: charge.amount_cents, amountPaidCents: charge.amount_paid_cents, status: charge.status });
  const items = lines.map(toLine);
  const added = tax.summarize(items).filter((t) => !t.included);
  const listed = items.reduce((s, l) => s + l.amountCents, 0) + added.reduce((s, t) => s + t.cents, 0);
  if (charge.amount_paid_cents === 0 && lines.length > 0 && listed === balance) {
    return [
      ...items.map((line) => ({
        price_data: { currency: charge.currency, unit_amount: line.amountCents, product_data: { name: line.label } },
        quantity: 1,
      })),
      ...added.map((t) => ({
        price_data: { currency: charge.currency, unit_amount: t.cents, product_data: { name: tax.taxLineName(t) } },
        quantity: 1,
      })),
    ];
  }
  return [{
    price_data: { currency: charge.currency, unit_amount: balance, product_data: { name: `Balance for ${charge.description}` } },
    quantity: 1,
  }];
}

const sourceTag = (charge) => (charge.source_type === 'request' ? 'schoolmule_request' : 'schoolmule_form');

async function accountForCharge(charge, client) {
  const { rows } = await db.query(accountQueries.selectAccount, [charge.school, client.livemode]);
  const account = rows[0];
  if (!account || account.status !== 'active') {
    throw new ChargeError('This school isn’t taking card payments right now. Please contact the school.', 409, 'PAYMENTS_UNAVAILABLE');
  }
  return account;
}

// Stripe's names for where its payment form shows: its own page, or inside ours.
const UI_MODES = { hosted: 'hosted_page', embedded: 'embedded_page' };

/** The host families pay on (schoolmule.ca), when it is a real https site. */
function siteDomain() {
  try {
    const url = new URL(appUrl());
    return url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

// Accounts whose domain is registered, so it's checked once per school per process.
const walletDomainsReady = new Set();

/**
 * Apple Pay, Google Pay and Link inside our own page need our domain
 * registered on the school's account (the charge is theirs). Best effort:
 * cards work without it, so a failure is logged, never thrown.
 */
async function ensureWalletDomain(client, stripeAccountId) {
  const domain = siteDomain();
  if (!domain || walletDomainsReady.has(`${stripeAccountId}:${domain}`)) return;
  try {
    const found = await client.listPaymentMethodDomains(stripeAccountId, domain);
    if (!(found.data || []).some((d) => d.domain_name === domain)) {
      await client.createPaymentMethodDomain(stripeAccountId, domain);
      logger.info({ stripeAccountId, domain }, 'Payments: registered our domain for wallets on a school’s account');
    }
    walletDomainsReady.add(`${stripeAccountId}:${domain}`);
  } catch (error) {
    logger.warn({ stripeAccountId, domain, err: error.message }, 'Payments: could not register our domain for wallets; cards still work');
  }
}

/**
 * A Stripe payment for what is still owed on a charge: Stripe's own page
 * (`hosted`, a url) or a form inside ours (`embedded`, a client secret for
 * Stripe.js, on the school's account). An open session of the same kind with
 * time left is reused; any other is closed first, so the family can't pay
 * the same charge twice by keeping two tabs.
 * @returns {Promise<{ url: string|null, clientSecret: string|null, stripeAccountId: string|null, charge }>}
 *   url and clientSecret are both null when the charge turned out to be paid already
 */
async function openCheckout(chargeId, { client = clientOrNull(), ui = 'hosted' } = {}) {
  if (!client) throw new ChargeError('Card payments aren’t set up on this server yet.', 503, 'PAYMENTS_UNAVAILABLE');
  return withCheckoutLock(chargeId, () => openCheckoutNow(chargeId, { client, ui }));
}

/**
 * One payment page opened at a time per charge. A double click, two tabs, or
 * a page asking twice would otherwise send Stripe the same request twice at
 * once (Stripe refuses the second: "idempotency_key_in_use"). The second
 * waits here, then finds and reuses what the first one opened.
 */
async function withCheckoutLock(chargeId, work) {
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`checkout:${chargeId}`]);
    const result = await work();
    await conn.query('COMMIT');
    return result;
  } catch (error) {
    await conn.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function openCheckoutNow(chargeId, { client, ui }) {
  const uiMode = UI_MODES[ui] || UI_MODES.hosted;
  const embedded = uiMode === UI_MODES.embedded;
  const { rows: [charge] } = await db.query(q.selectChargeForStripe, [chargeId, client.livemode]);
  if (!charge) throw new ChargeError('Payment not found', 404);
  const account = await accountForCharge(charge, client);
  const facts = { amountCents: charge.amount_cents, amountPaidCents: charge.amount_paid_cents, status: charge.status };
  if (!canPayOnline(facts)) throw new ChargeError('There is nothing left to pay on this.', 409, 'NOTHING_OWED');

  const answer = (session, current) => ({
    url: embedded ? null : session.url,
    clientSecret: embedded ? session.client_secret : null,
    stripeAccountId: account.stripe_account_id,
    charge: current,
  });

  if (charge.checkout_session_id) {
    const previous = await client.retrieveCheckoutSession(account.stripe_account_id, charge.checkout_session_id);
    if (previous.status === 'complete') {
      const done = await fulfillSession({ client, accountId: account.stripe_account_id, session: previous });
      return { url: null, clientSecret: null, stripeAccountId: account.stripe_account_id, charge: done.charge };
    }
    const timeLeft = (previous.expires_at || 0) * 1000 - Date.now();
    const sameKind = (previous.ui_mode || UI_MODES.hosted) === uiMode;
    if (previous.status === 'open' && sameKind && timeLeft > 5 * 60 * 1000) return answer(previous, charge);
    if (previous.status === 'open') {
      await client.expireCheckoutSession(account.stripe_account_id, previous.id).catch((error) => {
        logger.warn({ chargeId, err: error.message }, 'Payments: could not close an older payment page');
      });
    }
  }
  if (embedded) await ensureWalletDomain(client, account.stripe_account_id);

  const { rows: lines } = await db.query(q.selectLines, [chargeId]);
  const session = await client.createCheckoutSession(account.stripe_account_id, {
    mode: 'payment',
    // Cards, with Apple Pay and Google Pay. Bank debits wait for tuition.
    allowed_payment_method_types: ['card'],
    submit_type: 'pay',
    line_items: checkoutLines(charge, lines),
    customer_email: charge.payer_email || undefined,
    client_reference_id: charge.charge_id,
    metadata: { charge_id: charge.charge_id, source: sourceTag(charge) },
    payment_intent_data: {
      description: charge.description,
      metadata: { charge_id: charge.charge_id, source: sourceTag(charge) },
    },
    // Stripe's page links back to ours; inside ours, Stripe returns here once paid.
    ...(embedded
      ? { ui_mode: uiMode, return_url: `${payPageUrl(charge.public_token)}?session_id={CHECKOUT_SESSION_ID}` }
      : {
        success_url: `${payPageUrl(charge.public_token)}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${payPageUrl(charge.public_token)}?cancelled=1`,
      }),
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
  }, { idempotencyKey: `schoolmule-checkout-${charge.charge_id}-${charge.checkout_attempts + 1}` });

  const { rows: [updated] } = await db.query(q.setCheckout, [charge.charge_id, session.id, session.url || null, session.expires_at]);
  return answer(session, updated);
}

/** The card details worth keeping from Stripe's charge object. */
function cardFacts(paymentIntent) {
  const stripeCharge = paymentIntent && typeof paymentIntent.latest_charge === 'object' ? paymentIntent.latest_charge : null;
  const card = stripeCharge?.payment_method_details?.card || {};
  const balanceTx = stripeCharge && typeof stripeCharge.balance_transaction === 'object' ? stripeCharge.balance_transaction : null;
  return {
    stripeChargeId: stripeCharge?.id || null,
    brand: card.brand || null,
    last4: card.last4 || null,
    wallet: card.wallet?.type || null,
    feeCents: Number.isInteger(balanceTx?.fee) ? balanceTx.fee : null,
  };
}

/**
 * Records a completed Checkout session as a card payment, once. Safe to call
 * from the webhook, the family's return page and the safety-net check at the
 * same time.
 * @param session  Stripe's session (expanded), or pass sessionId to fetch it
 * @returns {{ charge, recorded: boolean }}
 */
async function fulfillSession({ client, accountId, session, sessionId }) {
  const s = session || await client.retrieveCheckoutSession(accountId, sessionId);
  const chargeId = s.client_reference_id || s.metadata?.charge_id;
  const { rows: [charge] } = await db.query(q.selectChargeForStripe, [chargeId, client.livemode]);
  if (!charge) {
    logger.warn({ sessionId: s.id, stripeAccountId: accountId }, 'Payments: a Checkout session names no charge of ours');
    return { charge: null, recorded: false };
  }
  const { rows: [account] } = await db.query(accountQueries.selectAccountByStripeId, [accountId, client.livemode]);
  if (!account || account.school !== charge.school) {
    logger.error({ sessionId: s.id, chargeId, stripeAccountId: accountId }, 'Payments: a Checkout session came from a different school’s account; ignored');
    return { charge: null, recorded: false };
  }

  if (s.status === 'expired') {
    await db.query(q.clearCheckout, [charge.charge_id, s.id]);
    await maybeSendReminder(charge.charge_id);
    return { charge, recorded: false };
  }
  if (s.status !== 'complete' || s.payment_status !== 'paid') return { charge, recorded: false };

  const intent = typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const card = cardFacts(intent);
  const result = await inTransaction(async (tx) => {
    const { rows: inserted } = await tx.query(q.insertCardPayment, [
      charge.charge_id, charge.school, s.amount_total, s.id, intent?.id || (typeof s.payment_intent === 'string' ? s.payment_intent : null),
      card.stripeChargeId, card.brand, card.last4, card.wallet, card.feeCents,
    ]);
    if (!inserted[0]) {
      await tx.query(q.fillCardDetails, [s.id, card.feeCents, card.stripeChargeId, card.brand, card.last4, card.wallet]);
    }
    // A request has no email of its own: whoever paid gets the receipt (Stripe's page asks for one).
    const stripeEmail = String(s.customer_details?.email || s.customer_email || '').trim().toLowerCase();
    if (inserted[0] && !charge.payer_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stripeEmail)) {
      await tx.query(q.setPayerEmailIfMissing, [charge.charge_id, stripeEmail.slice(0, 254)]);
    }
    const updated = await recompute(tx, charge.charge_id);
    if (inserted[0]) {
      await tx.query(q.clearCheckout, [charge.charge_id, s.id]);
      await emails.queueReceipt(tx, updated, inserted[0].payment_id);
    }
    return { charge: updated, recorded: Boolean(inserted[0]) };
  });
  if (result.recorded) {
    emails.kick();
    logger.info({ chargeId: charge.charge_id, school: charge.school, amountCents: s.amount_total }, 'Payments: card payment recorded');
  }
  return result;
}

/** The one automatic "finish paying" email after a family left Stripe's page unpaid. */
async function maybeSendReminder(chargeId) {
  const { rows: [charge] } = await db.query('SELECT * FROM charges WHERE charge_id = $1', [chargeId]);
  if (!charge || !charge.payer_email || charge.source_type === 'request') return false;
  const facts = { amountCents: charge.amount_cents, amountPaidCents: charge.amount_paid_cents, status: charge.status };
  if (!canPayOnline(facts) || charge.chosen_method !== 'card') return false;
  const { rows } = await db.query(q.claimReminder, [chargeId]);
  if (!rows[0]) return false;
  await emails.queuePaymentLink(db, charge, { automatic: true });
  emails.kick();
  return true;
}

/**
 * Fills in the Stripe fee on recent card payments that were recorded before
 * Stripe had worked it out (it comes a moment after the payment).
 * @returns how many were filled
 */
async function fillMissingFees({ client }) {
  const { rows } = await db.query(q.selectMissingFees, [client.livemode]);
  let filled = 0;
  for (const row of rows) {
    try {
      const intent = await client.retrievePaymentIntent(row.stripe_account_id, row.stripe_payment_intent_id);
      const card = cardFacts(intent);
      if (card.feeCents == null) continue;
      await db.query(q.setFee, [row.payment_id, card.feeCents, card.stripeChargeId]);
      filled += 1;
    } catch (error) {
      logger.warn({ paymentId: row.payment_id, err: error.message }, 'Payments: could not read a payment’s Stripe fee');
    }
  }
  return filled;
}

// ─── Refunds and disputes (Stripe's side) ─────────────────────────────

const REFUND_STATUS = { succeeded: 'succeeded', pending: 'pending', requires_action: 'pending', failed: 'failed', canceled: 'failed' };

/**
 * Brings a charge's refunds in line with Stripe's list for one card payment,
 * including refunds the school made in its own Stripe Dashboard.
 */
async function syncRefunds({ client, accountId, paymentIntentId }) {
  const { rows: [charge] } = await db.query(q.selectChargeByPaymentIntent, [paymentIntentId, client.livemode]);
  if (!charge) return null;
  const list = await client.listRefunds(accountId, paymentIntentId);
  const newly = [];
  const updated = await inTransaction(async (tx) => {
    for (const refund of list.data || []) {
      const status = REFUND_STATUS[refund.status] || 'pending';
      const { rows: [row] } = await tx.query(q.upsertRefund, [
        charge.charge_id, charge.school, refund.amount, status, refund.id, paymentIntentId,
        typeof refund.charge === 'string' ? refund.charge : refund.charge?.id || null, null, null,
      ]);
      if (row?.inserted && status !== 'failed') newly.push(row.payment_id);
    }
    const after = await recompute(tx, charge.charge_id);
    for (const paymentId of newly) await emails.queueRefund(tx, after, paymentId);
    return after;
  });
  if (newly.length > 0) emails.kick();
  return updated;
}

async function syncDispute({ client, accountId, disputeId }) {
  const dispute = await client.retrieveDispute(accountId, disputeId);
  const intentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!intentId) return null;
  const { rows: [charge] } = await db.query(q.selectChargeByPaymentIntent, [intentId, client.livemode]);
  if (!charge) return null;
  await db.query(q.setDispute, [charge.charge_id, dispute.status]);
  logger.warn({ chargeId: charge.charge_id, school: charge.school, disputeStatus: dispute.status }, 'Payments: a card payment is disputed');
  return charge;
}

// ─── The office's actions ─────────────────────────────────────────────

async function loadForStaff(tx, { school, livemode, chargeId }) {
  const { rows: [charge] } = await tx.query(
    `SELECT ${q.CHARGE_COLUMNS} FROM charges c WHERE c.charge_id = $1 AND c.school = $2 AND c.livemode = $3 FOR UPDATE`,
    [chargeId, school, livemode],
  );
  if (!charge) throw new ChargeError('Payment not found', 404);
  return charge;
}

const factsOf = (row) => ({ amountCents: row.amount_cents, amountPaidCents: row.amount_paid_cents, status: row.status });

/** Closes the family's open payment page once the office has settled the charge another way. */
async function closeOpenCheckout(charge, client) {
  if (!client || !charge.checkout_session_id) return;
  try {
    const account = await accountForCharge(charge, client);
    await client.expireCheckoutSession(account.stripe_account_id, charge.checkout_session_id);
    await db.query(q.clearCheckout, [charge.charge_id, charge.checkout_session_id]);
  } catch (error) {
    logger.warn({ chargeId: charge.charge_id, err: error.message }, 'Payments: could not close the family’s open payment page');
  }
}

const checkOfflineKind = (kind) => {
  if (!OFFLINE_KINDS.has(kind)) throw new ChargeError('Choose cash, cheque or other', 400);
};

/**
 * Records cash, a cheque or another office payment inside the caller's
 * transaction (amount defaults to all that is owed; part is fine) and queues
 * its receipt. The caller commits, then kicks the email outbox.
 * @returns {{ charge, before, paymentId }} the charge after, and as it was
 */
async function recordOfflineIn(tx, { school, livemode, chargeId, kind, amountCents, note, user, sendReceipt = true }) {
  checkOfflineKind(kind);
  const charge = await loadForStaff(tx, { school, livemode, chargeId });
  const owed = balanceCents(factsOf(charge));
  if (owed <= 0) throw new ChargeError('Nothing is owed on this.', 409, 'NOTHING_OWED');
  const amount = amountCents == null ? owed : Number(amountCents);
  if (!Number.isInteger(amount) || amount < 1 || amount > owed) {
    throw new ChargeError(`Enter an amount between $0.01 and ${formatCents(owed)}`, 400);
  }
  const { rows: [payment] } = await tx.query(q.insertOfflinePayment, [
    chargeId, school, kind, amount, note ? String(note).slice(0, 500) : null, user.userId,
  ]);
  const updated = await recompute(tx, chargeId);
  if (sendReceipt) await emails.queueReceipt(tx, updated, payment.payment_id);
  return { charge: updated, before: charge, paymentId: payment.payment_id };
}

/** Cash, cheque or another payment taken at the office. */
async function recordOffline({ school, livemode, chargeId, kind, amountCents, note, user, sendReceipt = true, client = clientOrNull() }) {
  checkOfflineKind(kind);
  const result = await inTransaction((tx) => recordOfflineIn(tx, { school, livemode, chargeId, kind, amountCents, note, user, sendReceipt }));
  if (sendReceipt) emails.kick();
  if (balanceCents(factsOf(result.charge)) === 0) await closeOpenCheckout(result.before, client);
  return result.charge;
}

/** The family doesn't have to pay what is left. The note stays with the office. */
async function waive({ school, livemode, chargeId, note, user, client = clientOrNull() }) {
  const result = await inTransaction(async (tx) => {
    const charge = await loadForStaff(tx, { school, livemode, chargeId });
    const owed = balanceCents(factsOf(charge));
    if (owed <= 0) throw new ChargeError('Nothing is owed on this.', 409, 'NOTHING_OWED');
    await tx.query(q.insertOfflinePayment, [chargeId, school, 'waiver', owed, note ? String(note).slice(0, 500) : null, user.userId]);
    return { charge: await recompute(tx, chargeId), before: charge };
  });
  await closeOpenCheckout(result.before, client);
  return result.charge;
}

/** Takes back a cash, cheque or other payment, or a waiver, recorded by mistake. Card payments are refunded instead. */
async function voidPayment({ school, livemode, chargeId, paymentId, user }) {
  return inTransaction(async (tx) => {
    await loadForStaff(tx, { school, livemode, chargeId });
    const { rows } = await tx.query(q.voidPayment, [paymentId, chargeId, user.userId]);
    if (!rows[0]) throw new ChargeError('Only a cash, cheque or other payment, or a waiver, can be removed. A card payment is refunded instead.', 409);
    return recompute(tx, chargeId);
  });
}

/** Refunds card money, all or part. Stripe keeps its fee; the school's balance pays the refund. */
async function refund({ school, livemode, chargeId, amountCents, note, user, client = clientOrNull() }) {
  if (!client) throw new ChargeError('Card payments aren’t set up on this server yet.', 503, 'PAYMENTS_UNAVAILABLE');
  const { rows: [charge] } = await db.query(q.selectChargeById, [chargeId, school, livemode]);
  if (!charge) throw new ChargeError('Payment not found', 404);
  const { rows: payments } = await db.query(q.selectPayments, [chargeId]);
  const refundable = refundableCents(payments.map(paymentFacts));
  if (refundable <= 0) throw new ChargeError('There is no card payment left to refund.', 409, 'NOTHING_TO_REFUND');
  const amount = amountCents == null ? refundable : Number(amountCents);
  if (!Number.isInteger(amount) || amount < 1 || amount > refundable) {
    throw new ChargeError(`Enter an amount between $0.01 and ${formatCents(refundable)}`, 400);
  }

  // The card payment with enough left on it; a refund can't span two payments.
  const intents = new Map();
  for (const p of payments) {
    if (!p.stripe_payment_intent_id) continue;
    const left = intents.get(p.stripe_payment_intent_id) || 0;
    if (p.kind === 'card' && p.status === 'succeeded') intents.set(p.stripe_payment_intent_id, left + p.amount_cents);
    if (p.kind === 'refund' && (p.status === 'succeeded' || p.status === 'pending')) intents.set(p.stripe_payment_intent_id, left - p.amount_cents);
  }
  const target = [...intents.entries()].find(([, left]) => left >= amount);
  if (!target) {
    const most = Math.max(0, ...intents.values());
    throw new ChargeError(`This was paid in more than one card payment. Refund up to ${formatCents(most)} at a time.`, 400);
  }

  const { rows: [account] } = await db.query(accountQueries.selectAccount, [school, livemode]);
  if (!account) throw new ChargeError('Stripe is not connected', 409);
  const refunds = payments.filter((p) => p.kind === 'refund').length;
  const created = await client.createRefund(account.stripe_account_id, {
    paymentIntentId: target[0], amount, metadata: { charge_id: chargeId },
  }, { idempotencyKey: `schoolmule-refund-${chargeId}-${refunds + 1}-${amount}` });

  const updated = await inTransaction(async (tx) => {
    await tx.query(q.upsertRefund, [
      chargeId, school, created.amount, REFUND_STATUS[created.status] || 'pending', created.id, target[0],
      typeof created.charge === 'string' ? created.charge : null, note ? String(note).slice(0, 500) : null, user.userId,
    ]);
    const after = await recompute(tx, chargeId);
    const { rows: [row] } = await tx.query('SELECT payment_id FROM charge_payments WHERE stripe_refund_id = $1', [created.id]);
    if (row) await emails.queueRefund(tx, after, row.payment_id);
    return after;
  });
  emails.kick();
  logger.info({ chargeId, school, amountCents: amount, refundId: created.id, userId: user.userId }, 'Payments: refund issued');
  return updated;
}

/** Emails the family a link to pay what is still owed. */
async function sendPaymentLink({ school, livemode, chargeId }) {
  const { rows: [charge] } = await db.query(q.selectChargeById, [chargeId, school, livemode]);
  if (!charge) throw new ChargeError('Payment not found', 404);
  if (!canPayOnline(factsOf(charge))) throw new ChargeError('There is nothing left to pay on this.', 409, 'NOTHING_OWED');
  const { online } = await availability(school);
  if (!online) throw new ChargeError('Your school can’t take card payments right now. Check Finance → Payments.', 409, 'PAYMENTS_UNAVAILABLE');
  // A request reminds the student's guardians; a form response emails whoever filled it in.
  const queued = charge.source_type === 'request'
    ? await emails.queueRequest(db, charge, { reminder: 'manual' })
    : await emails.queuePaymentLink(db, charge, { automatic: false });
  if (!queued) {
    throw new ChargeError(charge.source_type === 'request'
      ? 'This student has no guardian email on file. Add one to their record or parent account.'
      : 'This response has no email address to send the link to.', 409, 'NO_EMAIL');
  }
  await db.query(q.markLinkSent, [chargeId]);
  emails.kick();
  const { rows: [after] } = await db.query(q.selectChargeById, [chargeId, school, livemode]);
  return after;
}

/**
 * Says which child a charge is for (or none), and the same on its form
 * response. The student must be the school's.
 */
async function setStudent({ school, livemode, chargeId, studentId }) {
  return inTransaction(async (tx) => {
    const charge = await loadForStaff(tx, { school, livemode, chargeId });
    if (charge.source_type === 'request') throw new ChargeError('A payment request is sent to a student; add or remove students on the request instead.', 409);
    let id = null;
    if (studentId) {
      const { rows: [student] } = await tx.query('SELECT student_id FROM students WHERE student_id = $1 AND school = $2', [studentId, school]);
      if (!student) throw new ChargeError('Student not found', 404);
      id = student.student_id;
    }
    await tx.query(q.setStudent, [chargeId, id]);
    if (charge.submission_id) {
      await tx.query('UPDATE registration_form_submissions SET student_id = $2 WHERE submission_id = $1', [charge.submission_id, id]);
    }
    return { studentId: id };
  });
}

/** Students of the school matching a name, for linking a payment to a child. */
async function searchStudents({ school, schoolYearId, search }) {
  const term = String(search || '').trim().slice(0, 80);
  if (term.length < 2) return [];
  const { rows } = await db.query(
    `SELECT s.student_id, s.name, s.grade::text AS grade
       FROM students s
      WHERE s.school = $1 AND ($2::uuid IS NULL OR s.school_year_id = $2) AND s.name ILIKE '%' || $3 || '%'
      ORDER BY s.name LIMIT 20`,
    [school, schoolYearId, term],
  );
  return rows.map((r) => ({ studentId: r.student_id, name: r.name, grade: r.grade }));
}

// ─── Reads ────────────────────────────────────────────────────────────

async function detailForStaff({ school, livemode, chargeId, finance }) {
  const { rows: [row] } = await db.query(q.selectChargeById, [chargeId, school, livemode]);
  if (!row) return null;
  const [{ rows: lines }, { rows: payments }] = await Promise.all([
    db.query(q.selectLines, [chargeId]),
    db.query(q.selectPayments, [chargeId]),
  ]);
  return toCharge(row, { finance, lines, payments });
}

/** What the family's link shows. Never the office's notes, never "waived". */
async function publicView(token) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(token))) return null;
  const { rows: [row] } = await db.query(q.selectChargeByToken, [token]);
  if (!row) return null;
  const [{ rows: lines }, { rows: payments }, { online }] = await Promise.all([
    db.query(q.selectLines, [row.charge_id]),
    db.query(q.selectPayments, [row.charge_id]),
    availability(row.school),
  ]);
  const facts = factsOf(row);
  const lastCard = [...payments].reverse().find((p) => p.kind === 'card' && p.status === 'succeeded');
  const items = lines.map(toLine);
  return {
    row,
    view: {
      schoolName: row.school_name,
      sourceType: row.source_type,
      formTitle: row.form_title || row.request_title || row.description,
      formPath: row.school_slug && row.form_slug ? `/${row.school_slug}/${row.form_slug}` : null,
      // A request's own words, its due date, and the child it is for (the link goes to that child's guardians).
      requestDescription: row.request_description || null,
      dueDate: row.due_date || null,
      studentName: row.student_name || null,
      allowOffline: row.source_type === 'request' ? Boolean(row.request_allow_offline) : row.chosen_method === 'offline',
      currency: row.currency,
      lines: items,
      // What the family owes, and the prices before any tax added on top.
      amountCents: row.amount_cents,
      subtotalCents: row.amount_cents - tax.addedTaxCents(items),
      taxCents: row.tax_cents || 0,
      taxSummary: tax.summarize(items),
      // The school's, for receipts (a GST/HST number).
      taxNumber: row.tax_number || null,
      amountPaidCents: row.amount_paid_cents,
      amountRefundedCents: row.amount_refunded_cents,
      balanceCents: balanceCents(facts),
      status: visibleStatus(row.status, false),
      paidAt: row.paid_at,
      chosenMethod: row.chosen_method,
      canPayOnline: online && canPayOnline(facts),
      card: lastCard ? { brand: lastCard.card_brand, last4: lastCard.card_last4, wallet: lastCard.wallet } : null,
      reference: row.charge_id.slice(0, 8).toUpperCase(),
      testMode: !row.livemode,
    },
  };
}

module.exports = {
  ChargeError,
  CHECKOUT_MINUTES,
  availability,
  clientOrNull,
  createForSubmission,
  openCheckout,
  fulfillSession,
  maybeSendReminder,
  fillMissingFees,
  syncRefunds,
  syncDispute,
  recordOffline,
  recordOfflineIn,
  lineParams,
  waive,
  voidPayment,
  refund,
  sendPaymentLink,
  setStudent,
  searchStudents,
  recompute,
  inTransaction,
  detailForStaff,
  publicView,
  toCharge,
  visibleStatus,
  payPageUrl,
  checkoutLines,
  ensureWalletDomain,
  UI_MODES,
  cardFacts,
  OFFLINE_KINDS,
};
