// services/payments/chargeStatus.js
//
// Where a charge stands, worked out from what has happened to it. Pure: the
// charge's totals and status are always recomputed from its payments rather
// than nudged up and down, so a repeated webhook or an undo can never leave
// them out of step.

const MONEY_IN = new Set(['card', 'cash', 'cheque', 'other']);

/**
 * @param {number} amountCents  what was owed
 * @param {Array<{kind,status,amountCents,createdAt}>} payments
 * @returns {{ status, amountPaidCents, amountRefundedCents, paidAt }}
 */
function deriveCharge(amountCents, payments = []) {
  let paid = 0;
  let refunded = 0;
  let waived = false;
  let lastIn = null;

  for (const p of payments) {
    if (MONEY_IN.has(p.kind) && p.status === 'succeeded') {
      paid += p.amountCents;
      const at = p.createdAt ? new Date(p.createdAt) : null;
      if (at && (!lastIn || at > lastIn)) lastIn = at;
    } else if (p.kind === 'refund' && (p.status === 'succeeded' || p.status === 'pending')) {
      // A refund Stripe is still sending already counts, so it can't be sent twice.
      refunded += p.amountCents;
    } else if (p.kind === 'waiver' && p.status === 'succeeded') {
      waived = true;
    }
  }

  let status;
  if (refunded > 0) status = refunded >= paid ? 'refunded' : 'partially_refunded';
  else if (paid >= amountCents) status = 'paid';
  else if (waived) status = 'waived';
  else if (paid > 0) status = 'partially_paid';
  else status = 'unpaid';

  return {
    status,
    amountPaidCents: paid,
    amountRefundedCents: refunded,
    paidAt: status === 'paid' || status === 'partially_refunded' || status === 'refunded' ? lastIn : null,
  };
}

/** Still owed, after payments and refunds; nothing once waived. */
function balanceCents(charge) {
  if (charge.status === 'waived') return 0;
  return Math.max(0, charge.amountCents - charge.amountPaidCents);
}

/** What can still be refunded by card: card money in, less what was already refunded. */
function refundableCents(payments = []) {
  let card = 0;
  let refunded = 0;
  for (const p of payments) {
    if (p.kind === 'card' && p.status === 'succeeded') card += p.amountCents;
    if (p.kind === 'refund' && (p.status === 'succeeded' || p.status === 'pending')) refunded += p.amountCents;
  }
  return Math.max(0, card - refunded);
}

/** Whether the family may still pay online: something is owed and it hasn't been settled another way. */
const canPayOnline = (charge) => (charge.status === 'unpaid' || charge.status === 'partially_paid') && balanceCents(charge) >= 50;

module.exports = { deriveCharge, balanceCents, refundableCents, canPayOnline, MONEY_IN };
