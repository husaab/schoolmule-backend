// services/payments/emails.js
//
// The emails a family gets about a payment, sent through the email outbox in
// the school's voice:
//   payment_receipt  a payment was received (card, or recorded at the office)
//   payment_link     a link to pay what is still owed (once automatically
//                    after leaving Stripe's page unpaid, or when the office
//                    sends it)
//   payment_refund   money is on its way back
//
// Rows hold ids only; each email is built from the ledger when it is sent, so
// it always shows the charge as it stands. A payment receipt is not a tax
// receipt and says so.

const db = require('../../config/database');
const logger = require('../../logger');
const schoolQueries = require('../../queries/school.queries');
const q = require('../../queries/charges.queries');
const outbox = require('../email/outbox');
const { schoolSender } = require('../email/senderIdentity');
const { renderEmail, schoolBrand, paragraph, finePrint, button, facts, signOff, schoolContact, escapeHtml } = require('../../templates/emailLayout');
const { getSchoolName } = require('../../utils/schoolUtils');
const { formatCents } = require('./paymentField');
const { balanceCents, canPayOnline } = require('./chargeStatus');

const SUBJECT_TYPE = 'charge';
const KINDS = { receipt: 'payment_receipt', link: 'payment_link', refund: 'payment_refund' };

const payUrl = (token) => `${process.env.FRONTEND_URL || ''}/pay/${token}`;
const reference = (chargeId) => String(chargeId).slice(0, 8).toUpperCase();

const BRAND_NAMES = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', unionpay: 'UnionPay', diners: 'Diners Club', interac: 'Interac' };
const WALLETS = { apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link' };

/** "Visa ending 4242", "Apple Pay (Visa ending 4242)", "Cash", "Cheque". */
function paidWith(payment) {
  if (!payment) return null;
  if (payment.kind === 'cash') return 'Cash';
  if (payment.kind === 'cheque') return 'Cheque';
  if (payment.kind === 'other') return 'Paid at the office';
  const card = payment.card_last4 ? `${BRAND_NAMES[payment.card_brand] || 'Card'} ending ${payment.card_last4}` : 'Card';
  return payment.wallet && WALLETS[payment.wallet] ? `${WALLETS[payment.wallet]} (${card})` : card;
}

const dateOf = (value) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: 'long', day: 'numeric' });

// ─── Queueing ─────────────────────────────────────────────────────────

function row(kind, charge, { dedupeKey, payload = {} }) {
  return {
    kind,
    school: charge.school,
    recipientEmail: charge.payer_email,
    subjectType: SUBJECT_TYPE,
    subjectId: charge.charge_id,
    dedupeKey,
    payload,
    priority: 2,
  };
}

/** A receipt for one payment. Nothing without an address. */
async function queueReceipt(tx, charge, paymentId) {
  if (!charge?.payer_email || !paymentId) return 0;
  return outbox.enqueue(tx, [row(KINDS.receipt, charge, { dedupeKey: `receipt:${paymentId}`, payload: { paymentId } })]);
}

async function queueRefund(tx, charge, paymentId) {
  if (!charge?.payer_email || !paymentId) return 0;
  return outbox.enqueue(tx, [row(KINDS.refund, charge, { dedupeKey: `refund:${paymentId}`, payload: { paymentId } })]);
}

/** The automatic one goes once per charge; each one the office sends is its own. */
async function queuePaymentLink(tx, charge, { automatic }) {
  if (!charge?.payer_email) return 0;
  const dedupeKey = automatic ? `link:auto:${charge.charge_id}` : `link:manual:${charge.charge_id}:${Date.now()}`;
  return outbox.enqueue(tx, [row(KINDS.link, charge, { dedupeKey, payload: { automatic: Boolean(automatic) } })]);
}

const kick = () => outbox.kick();

// ─── Building (when sent) ─────────────────────────────────────────────

async function load(job) {
  const { rows: [charge] } = await db.query(
    `SELECT ${q.CHARGE_COLUMNS}, f.title AS form_title FROM charges c LEFT JOIN registration_forms f ON f.form_id = c.form_id WHERE c.charge_id = $1`,
    [job.subject_id],
  );
  if (!charge) return null;
  const [{ rows: lines }, { rows: payments }, schoolInfo] = await Promise.all([
    db.query(q.selectLines, [charge.charge_id]),
    db.query(q.selectPayments, [charge.charge_id]),
    db.query(schoolQueries.selectSchoolByCode, [charge.school]).then((r) => r.rows[0] || null).catch((error) => {
      logger.warn({ err: error, school: charge.school }, 'School lookup failed for a payment email');
      return null;
    }),
  ]);
  const schoolName = (schoolInfo && schoolInfo.name) || getSchoolName(charge.school);
  return { charge, lines, payments, schoolInfo, schoolName };
}

const linesHtml = (lines) => lines.map((l) => `${escapeHtml(l.label)} &nbsp;${escapeHtml(formatCents(l.amount_cents))}`).join('<br>');

function message({ job, ctx, subject, heading, preheader, content }) {
  const html = renderEmail({
    brand: schoolBrand(ctx.schoolInfo, ctx.schoolName),
    heading,
    preheader,
    content: [...content, signOff(ctx.schoolName)].join(''),
    footer: schoolContact(ctx.schoolInfo, ctx.schoolName),
  });
  return {
    ...schoolSender({ school: ctx.charge.school, schoolInfo: ctx.schoolInfo, role: 'messages' }),
    to: [job.recipient_email],
    subject,
    html,
  };
}

const receiptHandler = {
  async build(job) {
    const ctx = await load(job);
    if (!ctx) return { skip: 'Charge removed' };
    const payment = ctx.payments.find((p) => p.payment_id === job.payload?.paymentId);
    if (!payment || payment.status !== 'succeeded' || payment.kind === 'waiver' || payment.kind === 'refund') return { skip: 'Payment no longer stands' };
    const title = ctx.charge.form_title || ctx.charge.description;
    const subject = `Payment received: ${title}`;
    const owed = balanceCents({ amountCents: ctx.charge.amount_cents, amountPaidCents: ctx.charge.amount_paid_cents, status: ctx.charge.status });
    return {
      message: message({
        job, ctx, subject,
        heading: `Payment received · ${formatCents(payment.amount_cents)}`,
        preheader: `${ctx.schoolName} received ${formatCents(payment.amount_cents)} for ${title}.`,
        content: [
          paragraph(`${escapeHtml(ctx.schoolName)} received your payment for <strong>${escapeHtml(title)}</strong>.`),
          facts([
            ['Items', linesHtml(ctx.lines)],
            ['Paid', escapeHtml(formatCents(payment.amount_cents))],
            ['Still owed', owed > 0 ? escapeHtml(formatCents(owed)) : null],
            ['Paid with', escapeHtml(paidWith(payment))],
            ['Date', escapeHtml(dateOf(payment.created_at))],
            ['Reference', escapeHtml(reference(ctx.charge.charge_id))],
          ]),
          button('View this payment', payUrl(ctx.charge.public_token)),
          finePrint('This is a payment receipt, not a tax receipt.'),
        ],
      }),
      sentContent: { subject, paymentId: payment.payment_id, amountCents: payment.amount_cents },
    };
  },
};

const refundHandler = {
  async build(job) {
    const ctx = await load(job);
    if (!ctx) return { skip: 'Charge removed' };
    const payment = ctx.payments.find((p) => p.payment_id === job.payload?.paymentId);
    if (!payment || payment.kind !== 'refund' || payment.status === 'failed') return { skip: 'Refund no longer stands' };
    const title = ctx.charge.form_title || ctx.charge.description;
    const subject = `Refund: ${title}`;
    return {
      message: message({
        job, ctx, subject,
        heading: `Refund of ${formatCents(payment.amount_cents)}`,
        preheader: `${ctx.schoolName} refunded ${formatCents(payment.amount_cents)} for ${title}.`,
        content: [
          paragraph(`${escapeHtml(ctx.schoolName)} refunded <strong>${escapeHtml(formatCents(payment.amount_cents))}</strong> for ${escapeHtml(title)}.`),
          paragraph('It goes back to the card you paid with. Banks usually take 5 to 10 business days to show it on your statement.'),
          facts([
            ['Refunded', escapeHtml(formatCents(payment.amount_cents))],
            ['Date', escapeHtml(dateOf(payment.created_at))],
            ['Reference', escapeHtml(reference(ctx.charge.charge_id))],
          ]),
          button('View this payment', payUrl(ctx.charge.public_token)),
        ],
      }),
      sentContent: { subject, paymentId: payment.payment_id, amountCents: payment.amount_cents },
    };
  },
};

const linkHandler = {
  async build(job) {
    const ctx = await load(job);
    if (!ctx) return { skip: 'Charge removed' };
    const facts_ = { amountCents: ctx.charge.amount_cents, amountPaidCents: ctx.charge.amount_paid_cents, status: ctx.charge.status };
    if (!canPayOnline(facts_)) return { skip: 'Nothing left to pay' };
    const owed = balanceCents(facts_);
    const title = ctx.charge.form_title || ctx.charge.description;
    const subject = `Finish paying: ${title}`;
    return {
      message: message({
        job, ctx, subject,
        heading: `${formatCents(owed)} still to pay`,
        preheader: `Your form for ${title} was received. ${formatCents(owed)} is still to pay.`,
        content: [
          paragraph(`Your form for <strong>${escapeHtml(title)}</strong> was received, but the payment wasn’t finished.`),
          facts([
            ['Items', linesHtml(ctx.lines)],
            ['To pay', escapeHtml(formatCents(owed))],
          ]),
          button(`Pay ${formatCents(owed)}`, payUrl(ctx.charge.public_token)),
          finePrint(`If you already paid, or arranged to pay ${escapeHtml(ctx.schoolName)} another way, you can ignore this email.`),
        ],
      }),
      sentContent: { subject, owedCents: owed, automatic: Boolean(job.payload?.automatic) },
    };
  },
};

module.exports = { KINDS, queueReceipt, queueRefund, queuePaymentLink, kick, paidWith, receiptHandler, refundHandler, linkHandler };
