const { deriveCharge, balanceCents, refundableCents, canPayOnline } = require('../../../../services/payments/chargeStatus');

const pay = (kind, amountCents, status = 'succeeded', createdAt = '2026-11-20T15:00:00Z') => ({ kind, amountCents, status, createdAt });

describe('deriveCharge', () => {
  it('is unpaid with nothing recorded', () => {
    expect(deriveCharge(2500, [])).toEqual({ status: 'unpaid', amountPaidCents: 0, amountRefundedCents: 0, paidAt: null });
  });

  it('is paid by card, cash or a mix that covers it, dated by the last payment', () => {
    expect(deriveCharge(2500, [pay('card', 2500)])).toMatchObject({ status: 'paid', amountPaidCents: 2500 });
    const mixed = deriveCharge(2500, [pay('cash', 1000, 'succeeded', '2026-11-20T10:00:00Z'), pay('cheque', 1500, 'succeeded', '2026-11-21T10:00:00Z')]);
    expect(mixed).toMatchObject({ status: 'paid', amountPaidCents: 2500 });
    expect(mixed.paidAt.toISOString()).toBe('2026-11-21T10:00:00.000Z');
  });

  it('is part paid below the amount', () => {
    expect(deriveCharge(2500, [pay('cash', 1000)])).toMatchObject({ status: 'partially_paid', amountPaidCents: 1000, paidAt: null });
  });

  it('ignores voided and failed payments', () => {
    expect(deriveCharge(2500, [pay('cash', 2500, 'voided'), pay('card', 2500, 'failed')]).status).toBe('unpaid');
  });

  it('is waived, unless it was in fact paid in full', () => {
    expect(deriveCharge(2500, [pay('waiver', 2500)]).status).toBe('waived');
    expect(deriveCharge(2500, [pay('cash', 1000), pay('waiver', 1500)]).status).toBe('waived');
    expect(deriveCharge(2500, [pay('waiver', 2500, 'voided')]).status).toBe('unpaid');
  });

  it('counts refunds, including ones Stripe is still sending', () => {
    expect(deriveCharge(2500, [pay('card', 2500), pay('refund', 1000)])).toMatchObject({ status: 'partially_refunded', amountRefundedCents: 1000 });
    expect(deriveCharge(2500, [pay('card', 2500), pay('refund', 2500, 'pending')])).toMatchObject({ status: 'refunded', amountRefundedCents: 2500 });
    expect(deriveCharge(2500, [pay('card', 2500), pay('refund', 2500, 'failed')]).status).toBe('paid');
  });

  it('records a second card payment for the same charge rather than losing it', () => {
    expect(deriveCharge(2500, [pay('card', 2500), pay('card', 2500)])).toMatchObject({ status: 'paid', amountPaidCents: 5000 });
  });
});

describe('balanceCents, refundableCents, canPayOnline', () => {
  it('is what is left, and nothing once waived', () => {
    expect(balanceCents({ amountCents: 2500, amountPaidCents: 1000, status: 'partially_paid' })).toBe(1500);
    expect(balanceCents({ amountCents: 2500, amountPaidCents: 0, status: 'waived' })).toBe(0);
    expect(balanceCents({ amountCents: 2500, amountPaidCents: 5000, status: 'paid' })).toBe(0);
  });

  it('only refunds card money, less what was refunded', () => {
    expect(refundableCents([pay('card', 2500), pay('cash', 500), pay('refund', 1000)])).toBe(1500);
    expect(refundableCents([pay('cash', 2500)])).toBe(0);
    expect(refundableCents([pay('card', 2500), pay('refund', 2500, 'pending')])).toBe(0);
  });

  it('lets a family pay online only while something real is owed', () => {
    expect(canPayOnline({ amountCents: 2500, amountPaidCents: 0, status: 'unpaid' })).toBe(true);
    expect(canPayOnline({ amountCents: 2500, amountPaidCents: 2470, status: 'partially_paid' })).toBe(false);
    expect(canPayOnline({ amountCents: 2500, amountPaidCents: 0, status: 'waived' })).toBe(false);
    expect(canPayOnline({ amountCents: 2500, amountPaidCents: 2500, status: 'paid' })).toBe(false);
  });
});
