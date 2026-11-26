jest.mock('../../../../config/database', () => ({ query: jest.fn() }));

const { summarizeAccount, deriveStatus } = require('../../../../services/payments/connect');

const account = ({ card, payouts, entries = [] } = {}) => ({
  id: 'acct_1',
  display_name: 'Al Haadi Academy',
  configuration: { merchant: { capabilities: {
    ...(card ? { card_payments: { status: card } } : {}),
    ...(payouts ? { stripe_balance: { payouts: { status: payouts } } } : {}),
  } } },
  requirements: { entries },
});

const entry = (status, from = 'user') => ({ awaiting_action_from: from, minimum_deadline: { status } });

describe('summarizeAccount', () => {
  it('reads the two capabilities and the name', () => {
    expect(summarizeAccount(account({ card: 'active', payouts: 'pending' }))).toEqual({
      cardPaymentsStatus: 'active', payoutsStatus: 'pending', requirementsDue: 0, requirementsPastDue: false, displayName: 'Al Haadi Academy',
    });
  });

  it('counts only what the school must act on now', () => {
    const summary = summarizeAccount(account({
      card: 'restricted',
      entries: [entry('currently_due'), entry('past_due'), entry('eventually_due'), entry('currently_due', 'stripe')],
    }));
    expect(summary.requirementsDue).toBe(2);
    expect(summary.requirementsPastDue).toBe(true);
  });

  it('copes with an account that has nothing filled in', () => {
    expect(summarizeAccount({ id: 'acct_1' })).toEqual({
      cardPaymentsStatus: null, payoutsStatus: null, requirementsDue: 0, requirementsPastDue: false, displayName: null,
    });
    expect(summarizeAccount(null).cardPaymentsStatus).toBeNull();
  });
});

describe('deriveStatus', () => {
  it('is active whenever card payments are active', () => {
    expect(deriveStatus({ cardPaymentsStatus: 'active', requirementsDue: 3, wasActive: false })).toBe('active');
  });

  it('is onboarding while the school still owes Stripe information', () => {
    expect(deriveStatus({ cardPaymentsStatus: 'restricted', requirementsDue: 2, wasActive: false })).toBe('onboarding');
    expect(deriveStatus({ cardPaymentsStatus: null, requirementsDue: 0, wasActive: false })).toBe('onboarding');
  });

  it('is pending when everything is in and Stripe is checking it', () => {
    expect(deriveStatus({ cardPaymentsStatus: 'pending', requirementsDue: 0, wasActive: false })).toBe('pending');
  });

  it('is restricted when a school that was taking payments no longer can', () => {
    expect(deriveStatus({ cardPaymentsStatus: 'restricted', requirementsDue: 1, wasActive: true })).toBe('restricted');
    expect(deriveStatus({ cardPaymentsStatus: 'pending', requirementsDue: 0, wasActive: true })).toBe('restricted');
  });
});
