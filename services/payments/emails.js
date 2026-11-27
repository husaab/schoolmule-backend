// services/payments/emails.js
//
// The emails a family gets about a payment, sent through the email outbox in
// the school's voice:
//   payment_receipt  a payment was received (card, or recorded at the office)
//   payment_link     a link to pay what is still owed (once automatically
//                    after leaving Stripe's page unpaid, or when the office
//                    sends it)
//   payment_refund   money is on its way back
//   payment_request  the office asks a family to pay (a payment request), and
//                    the office's reminders about it
//
// Rows hold ids only; each email is built from the ledger when it is sent, so
// it always shows the charge as it stands. A payment receipt is not a tax
// receipt and says so.
//
// Tax, when a charge has any: tax added on top is a row per rate between the
// items and the total ("HST (13%)  $3.25"); tax inside the prices is one line
// ("Includes $2.88 HST"). The receipt also shows the school's tax number.
// An untaxed charge's emails are exactly as they were.

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
const tax = require('./tax');
const { guardiansOf } = require('./guardians');

const SUBJECT_TYPE = 'charge';
const KINDS = { receipt: 'payment_receipt', link: 'payment_link', refund: 'payment_refund', request: 'payment_request' };

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
/** A DATE column ("2026-12-12"), shown as written: no time zone shift. */
const dayOf = (value) => {
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
};

// ─── Queueing ─────────────────────────────────────────────────────────

function row(kind, charge, recipient, { dedupeKey, payload = {} }) {
  return {
    kind,
    school: charge.school,
    recipientEmail: recipient.email,
    recipientUserId: recipient.userId || null,
    subjectType: SUBJECT_TYPE,
    subjectId: charge.charge_id,
    studentId: charge.student_id || null,
    dedupeKey,
    payload,
    priority: 2,
  };
}

/**
 * Who hears about a charge: the person who gave their email (on the form, or
 * at Stripe's page), otherwise the student's guardians.
 */
async function recipientsFor(tx, charge) {
  if (charge?.payer_email) return [{ email: charge.payer_email, userId: null }];
  if (charge?.student_id) return guardiansOf(tx, charge.student_id);
  return [];
}

async function queueTo(tx, kind, charge, recipients, options) {
  if (!charge || recipients.length === 0) return 0;
  return outbox.enqueue(tx, recipients.map((r) => row(kind, charge, r, options)));
}

/** A receipt for one payment. Nothing without an address. */
async function queueReceipt(tx, charge, paymentId) {
  if (!paymentId) return 0;
  return queueTo(tx, KINDS.receipt, charge, await recipientsFor(tx, charge), { dedupeKey: `receipt:${paymentId}`, payload: { paymentId } });
}

async function queueRefund(tx, charge, paymentId) {
  if (!paymentId) return 0;
  return queueTo(tx, KINDS.refund, charge, await recipientsFor(tx, charge), { dedupeKey: `refund:${paymentId}`, payload: { paymentId } });
}

/** The automatic one goes once per charge; each one the office sends is its own. */
async function queuePaymentLink(tx, charge, { automatic }) {
  if (!charge?.payer_email) return 0;
  const dedupeKey = automatic ? `link:auto:${charge.charge_id}` : `link:manual:${charge.charge_id}:${Date.now()}`;
  return queueTo(tx, KINDS.link, charge, await recipientsFor(tx, charge), { dedupeKey, payload: { automatic: Boolean(automatic) } });
}

/**
 * A payment request to a student's guardians: the first ask (once), or a
 * reminder (the office's, each its own; the automatic one before the due
 * date, once).
 * @param reminder  false | 'manual' | 'due_soon'
 * @returns how many emails were queued
 */
async function queueRequest(tx, charge, { reminder = false } = {}) {
  if (!charge?.student_id) return 0;
  const recipients = await guardiansOf(tx, charge.student_id);
  const dedupeKey = !reminder ? `request:${charge.charge_id}`
    : reminder === 'due_soon' ? `request:due:${charge.charge_id}`
      : `request:reminder:${charge.charge_id}:${Date.now()}`;
  return queueTo(tx, KINDS.request, charge, recipients, { dedupeKey, payload: { reminder: reminder || null } });
}

const kick = () => outbox.kick();

// ─── Building (when sent) ─────────────────────────────────────────────

async function load(job) {
  const { rows: [charge] } = await db.query(
    `SELECT ${q.CHARGE_COLUMNS}, ${q.CHARGE_EXTRAS} FROM charges c ${q.CHARGE_JOINS} WHERE c.charge_id = $1`,
    [job.subject_id],
  );
  if (!charge) return null;
  const [{ rows: lines }, { rows: payments }, schoolInfo, taxNumber] = await Promise.all([
    db.query(q.selectLines, [charge.charge_id]),
    db.query(q.selectPayments, [charge.charge_id]),
    db.query(schoolQueries.selectSchoolByCode, [charge.school]).then((r) => r.rows[0] || null).catch((error) => {
      logger.warn({ err: error, school: charge.school }, 'School lookup failed for a payment email');
      return null;
    }),
    charge.tax_cents > 0
      ? db.query('SELECT tax_number FROM payment_settings WHERE school = $1', [charge.school]).then((r) => r.rows[0]?.tax_number || null)
      : null,
  ]);
  const schoolName = (schoolInfo && schoolInfo.name) || getSchoolName(charge.school);
  return { charge, lines, payments, schoolInfo, schoolName, taxNumber };
}

const linesHtml = (lines) => lines.map((l) => `${escapeHtml(l.label)} &nbsp;${escapeHtml(formatCents(l.amount_cents))}`).join('<br>');

/** The charge's tax, from its own lines: added (a row per rate) and included (one line each). */
function taxOf(ctx) {
  const entries = tax.summarize(ctx.lines.map((l) => ({
    taxCents: l.tax_cents, taxName: l.tax_name, taxRateMilli: l.tax_rate_milli, taxIncluded: l.tax_included,
  })));
  return {
    added: entries.filter((t) => !t.included).map((t) => [tax.taxLineName(t), escapeHtml(formatCents(t.cents))]),
    included: entries.filter((t) => t.included).map((t) => ['', escapeHtml(`Includes ${formatCents(t.cents)} ${t.name}`)]),
  };
}

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

/**
 * Added tax between the items and what is to pay, with the charge's total
 * when part of it was paid already (so "To pay" isn't read as items + tax).
 */
const taxRows = (taxes, charge, owed) => [
  ...taxes.added,
  ...(taxes.added.length && owed !== charge.amount_cents ? [['Total', escapeHtml(formatCents(charge.amount_cents))]] : []),
];

const receiptHandler = {
  async build(job) {
    const ctx = await load(job);
    if (!ctx) return { skip: 'Charge removed' };
    const payment = ctx.payments.find((p) => p.payment_id === job.payload?.paymentId);
    if (!payment || payment.status !== 'succeeded' || payment.kind === 'waiver' || payment.kind === 'refund') return { skip: 'Payment no longer stands' };
    const title = ctx.charge.form_title || ctx.charge.description;
    const subject = `Payment received: ${title}`;
    const owed = balanceCents({ amountCents: ctx.charge.amount_cents, amountPaidCents: ctx.charge.amount_paid_cents, status: ctx.charge.status });
    const taxes = taxOf(ctx);
    return {
      message: message({
        job, ctx, subject,
        heading: `Payment received · ${formatCents(payment.amount_cents)}`,
        preheader: `${ctx.schoolName} received ${formatCents(payment.amount_cents)} for ${title}.`,
        content: [
          paragraph(`${escapeHtml(ctx.schoolName)} received your payment for <strong>${escapeHtml(title)}</strong>.`),
          facts([
            ['Items', linesHtml(ctx.lines)],
            ...taxes.added,
            ...(taxes.added.length ? [['Total', escapeHtml(formatCents(ctx.charge.amount_cents))]] : []),
            ...taxes.included,
            ['Paid', escapeHtml(formatCents(payment.amount_cents))],
            ['Still owed', owed > 0 ? escapeHtml(formatCents(owed)) : null],
            ['Paid with', escapeHtml(paidWith(payment))],
            ['Date', escapeHtml(dateOf(payment.created_at))],
            ['Reference', escapeHtml(reference(ctx.charge.charge_id))],
            ['Tax no.', ctx.taxNumber ? escapeHtml(ctx.taxNumber) : null],
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
    const taxes = taxOf(ctx);
    return {
      message: message({
        job, ctx, subject,
        heading: `${formatCents(owed)} still to pay`,
        preheader: `Your form for ${title} was received. ${formatCents(owed)} is still to pay.`,
        content: [
          paragraph(`Your form for <strong>${escapeHtml(title)}</strong> was received, but the payment wasn’t finished.`),
          facts([
            ['Items', linesHtml(ctx.lines)],
            ...taxRows(taxes, ctx.charge, owed),
            ['To pay', escapeHtml(formatCents(owed))],
            ...taxes.included,
          ]),
          button(`Pay ${formatCents(owed)}`, payUrl(ctx.charge.public_token)),
          finePrint(`If you already paid, or arranged to pay ${escapeHtml(ctx.schoolName)} another way, you can ignore this email.`),
        ],
      }),
      sentContent: { subject, owedCents: owed, automatic: Boolean(job.payload?.automatic) },
    };
  },
};

const requestHandler = {
  async build(job) {
    const ctx = await load(job);
    if (!ctx) return { skip: 'Charge removed' };
    const facts_ = { amountCents: ctx.charge.amount_cents, amountPaidCents: ctx.charge.amount_paid_cents, status: ctx.charge.status };
    const owed = balanceCents(facts_);
    if (owed <= 0) return { skip: 'Nothing left to pay' };
    const reminder = job.payload?.reminder || null;
    const title = ctx.charge.description;
    const due = ctx.charge.due_date ? dayOf(ctx.charge.due_date) : null;
    const child = ctx.charge.student_name ? ` for ${ctx.charge.student_name}` : '';
    const subject = reminder ? `Reminder: ${title}${child}` : `Payment requested: ${title}${child}`;
    const pay = canPayOnline(facts_);
    const taxes = taxOf(ctx);
    return {
      message: message({
        job, ctx, subject,
        heading: reminder ? `${formatCents(owed)} still to pay` : `${formatCents(owed)} for ${title}`,
        preheader: `${ctx.schoolName} asks for ${formatCents(owed)}${child}${due ? `, due ${due}` : ''}.`,
        content: [
          paragraph(reminder
            ? `A reminder from ${escapeHtml(ctx.schoolName)}: <strong>${escapeHtml(title)}</strong>${escapeHtml(child)} is still to pay.`
            : `${escapeHtml(ctx.schoolName)} asks you to pay for <strong>${escapeHtml(title)}</strong>${escapeHtml(child)}.`),
          ctx.charge.request_description ? paragraph(escapeHtml(ctx.charge.request_description)) : '',
          facts([
            ['Student', ctx.charge.student_name ? escapeHtml(ctx.charge.student_name) : null],
            ...(taxes.added.length ? [['Items', linesHtml(ctx.lines)], ...taxRows(taxes, ctx.charge, owed)] : []),
            ['To pay', escapeHtml(formatCents(owed))],
            ...taxes.included,
            ['Due', due ? escapeHtml(due) : null],
            ['Reference', escapeHtml(reference(ctx.charge.charge_id))],
          ]),
          pay ? button(`Pay ${formatCents(owed)}`, payUrl(ctx.charge.public_token)) : '',
          ctx.charge.request_allow_offline ? finePrint(`You can also pay ${escapeHtml(ctx.schoolName)} at the office by cash or cheque.`) : '',
          finePrint(`If you already paid, or arranged to pay ${escapeHtml(ctx.schoolName)} another way, you can ignore this email.`),
        ].filter(Boolean),
      }),
      sentContent: { subject, owedCents: owed, reminder },
    };
  },
};

module.exports = {
  KINDS, queueReceipt, queueRefund, queuePaymentLink, queueRequest, recipientsFor, kick, paidWith,
  receiptHandler, refundHandler, linkHandler, requestHandler,
};
