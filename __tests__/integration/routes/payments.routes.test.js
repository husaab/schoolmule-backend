// Finance → Payments against the real schema: connecting a school to Stripe,
// with Stripe itself replaced by a fake client.
const mockClient = {
  mode: 'test',
  livemode: false,
  createAccount: jest.fn(),
  retrieveAccount: jest.fn(),
  createAccountLink: jest.fn(),
};
let mockConfigured = true;

jest.mock('../../../services/payments/stripeClient', () => {
  const actual = jest.requireActual('../../../services/payments/stripeClient');
  return {
    ...actual,
    clientFromEnv: jest.fn(() => {
      if (!mockConfigured) throw new actual.StripeConfigError('STRIPE_SECRET_KEY is missing or is not a Stripe secret key');
      return mockClient;
    }),
  };
});

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { StripeApiError } = require('../../../services/payments/errors');

const SCHOOL = 'ALHAADIACADEMY';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';

// authenticatedRequest takes a token payload; the default is the school's admin.
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440001', username: 'Teacher User', email: 'teacher@test.com', role: 'TEACHER' };
const PARENT = { userId: '550e8400-e29b-41d4-a716-446655440002', username: 'Parent User', email: 'parent@test.com', role: 'PARENT' };

const stripeAccount = ({ card = 'restricted', payouts = 'restricted', due = 2 } = {}) => ({
  id: 'acct_1TestSchool',
  display_name: 'Al Haadi Academy',
  configuration: { merchant: { capabilities: { card_payments: { status: card }, stripe_balance: { payouts: { status: payouts } } } } },
  requirements: { entries: Array.from({ length: due }, () => ({ awaiting_action_from: 'user', minimum_deadline: { status: 'currently_due' } })) },
});

async function rows() {
  const { rows: r } = await getTestPool().query(`SELECT * FROM payment_accounts ORDER BY connected_at`);
  return r;
}

describe('payments routes (integration)', () => {
  beforeEach(async () => {
    mockConfigured = true;
    mockClient.createAccount.mockReset().mockResolvedValue(stripeAccount());
    mockClient.retrieveAccount.mockReset().mockResolvedValue(stripeAccount());
    mockClient.createAccountLink.mockReset().mockResolvedValue({ url: 'https://connect.stripe.com/setup/s/test' });
    await getTestPool().query(`UPDATE schools SET email = 'office@alhaadi.example' WHERE school_code = $1`, [SCHOOL]);
  });

  describe('who may use it', () => {
    it('refuses a teacher without the finance permission', async () => {
      const res = await authenticatedRequest('get', '/api/payments/account', TEACHER);
      expect(res.status).toBe(403);
    });

    it('refuses a parent', async () => {
      const res = await authenticatedRequest('get', '/api/payments/account', PARENT);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/payments/account', () => {
    it('says the server is not configured when it has no Stripe key', async () => {
      mockConfigured = false;
      const res = await authenticatedRequest('get', '/api/payments/account');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ configured: false, mode: null, account: null });
    });

    it('has no account before the school connects, and does not call Stripe', async () => {
      const res = await authenticatedRequest('get', '/api/payments/account');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ configured: true, mode: 'test', account: null });
      expect(mockClient.retrieveAccount).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/payments/account/onboarding-link', () => {
    it('opens the Stripe account once, stores it, and returns the hosted link', async () => {
      const res = await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      expect(res.status).toBe(201);
      expect(res.body.data.url).toBe('https://connect.stripe.com/setup/s/test');
      expect(res.body.data.account).toMatchObject({
        connected: true, status: 'onboarding', canTakePayments: false, stripeAccountId: 'acct_1TestSchool',
        livemode: false, requirementsDue: 2, currency: 'cad',
      });

      expect(mockClient.createAccount).toHaveBeenCalledWith(
        { displayName: 'Al Haadi Academy', contactEmail: 'office@alhaadi.example', country: 'ca', currency: 'cad' },
        { idempotencyKey: 'schoolmule-account-ALHAADIACADEMY-test' },
      );
      expect(mockClient.createAccountLink).toHaveBeenCalledWith({
        accountId: 'acct_1TestSchool',
        returnUrl: 'http://localhost:3000/finance/payments?stripe=return',
        refreshUrl: 'http://localhost:3000/finance/payments?stripe=refresh',
      });

      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ school: SCHOOL, livemode: false, stripe_account_id: 'acct_1TestSchool', connected_by: ADMIN_ID });
    });

    it('reuses the account on a second click and only mints a new link', async () => {
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      const res = await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      expect(res.status).toBe(201);
      expect(mockClient.createAccount).toHaveBeenCalledTimes(1);
      expect(mockClient.createAccountLink).toHaveBeenCalledTimes(2);
      expect(await rows()).toHaveLength(1);
    });

    it('falls back to the admin email when the school has none', async () => {
      await getTestPool().query(`UPDATE schools SET email = NULL WHERE school_code = $1`, [SCHOOL]);
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      expect(mockClient.createAccount.mock.calls[0][0].contactEmail).toBe('admin@test.com');
    });

    it('answers 502 and stores nothing when Stripe refuses', async () => {
      mockClient.createAccount.mockRejectedValueOnce(new StripeApiError('Accounts v2 is not enabled', { status: 400, code: 'accounts_v2_access_blocked' }));
      const res = await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      expect(res.status).toBe(502);
      expect(res.body.message).not.toMatch(/Accounts v2/);
      expect(await rows()).toHaveLength(0);
    });

    it('answers 503 when the server has no Stripe key', async () => {
      mockConfigured = false;
      const res = await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      expect(res.status).toBe(503);
    });

    it('answers 503 before touching Stripe when there is nowhere to send the school back to', async () => {
      const saved = process.env.FRONTEND_URL;
      delete process.env.FRONTEND_URL;
      try {
        const res = await authenticatedRequest('post', '/api/payments/account/onboarding-link');
        expect(res.status).toBe(503);
        expect(mockClient.createAccount).not.toHaveBeenCalled();
        expect(await rows()).toHaveLength(0);
      } finally {
        process.env.FRONTEND_URL = saved;
      }
    });
  });

  describe('POST /api/payments/account/sync', () => {
    it('is a 404 before the school connects', async () => {
      const res = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(res.status).toBe(404);
    });

    it('moves the school through onboarding, pending and active as Stripe reports them', async () => {
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');

      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'pending', payouts: 'pending', due: 0 }));
      let res = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(res.body.data.account).toMatchObject({ status: 'pending', canTakePayments: false, requirementsDue: 0, activatedAt: null });

      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'active', payouts: 'active', due: 0 }));
      res = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(res.body.data.account).toMatchObject({ status: 'active', canTakePayments: true, cardPaymentsStatus: 'active', payoutsStatus: 'active' });
      expect(res.body.data.account.activatedAt).toBeTruthy();
      expect(res.body.data.account.lastSyncedAt).toBeTruthy();
    });

    it('reports restricted when a school that was active is stopped, and keeps when it first went active', async () => {
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'active', payouts: 'active', due: 0 }));
      const first = await authenticatedRequest('post', '/api/payments/account/sync');

      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'restricted', payouts: 'restricted', due: 1 }));
      const res = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(res.body.data.account).toMatchObject({ status: 'restricted', canTakePayments: false, requirementsDue: 1 });
      expect(res.body.data.account.activatedAt).toBe(first.body.data.account.activatedAt);
    });

    it('records the failure and answers 502 when Stripe is down', async () => {
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      mockClient.retrieveAccount.mockRejectedValueOnce(new StripeApiError('Stripe HTTP 503', { status: 503, retryable: true }));
      const res = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(res.status).toBe(502);
      expect((await rows())[0].last_error).toBe('Stripe HTTP 503');

      // Stripe's own words stay on the server: the school is only told the check failed.
      const after = await authenticatedRequest('get', '/api/payments/account');
      expect(after.body.data.account.syncFailed).toBe(true);
      expect(JSON.stringify(after.body)).not.toMatch(/Stripe HTTP 503/);
    });

    it('does not undo a disconnect that happened while Stripe was being asked', async () => {
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      mockClient.retrieveAccount.mockImplementationOnce(async () => {
        await getTestPool().query(`UPDATE payment_accounts SET status = 'disconnected', disconnected_at = now()`);
        return stripeAccount({ card: 'active', payouts: 'active', due: 0 });
      });
      const res = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(res.status).toBe(200);
      expect(res.body.data.account).toMatchObject({ connected: false, status: 'disconnected', canTakePayments: false });
      expect((await rows())[0]).toMatchObject({ status: 'disconnected', activated_at: null });
    });
  });

  describe('DELETE /api/payments/account', () => {
    it('is a 404 before the school connects', async () => {
      const res = await authenticatedRequest('delete', '/api/payments/account');
      expect(res.status).toBe(404);
    });

    it('turns payments off without touching Stripe, and reconnecting reuses the same account', async () => {
      await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      mockClient.retrieveAccount.mockClear();

      const off = await authenticatedRequest('delete', '/api/payments/account');
      expect(off.status).toBe(200);
      expect(off.body.data.account).toMatchObject({ connected: false, status: 'disconnected', canTakePayments: false });
      expect(off.body.data.account.disconnectedAt).toBeTruthy();

      // A sync while disconnected leaves it alone.
      const sync = await authenticatedRequest('post', '/api/payments/account/sync');
      expect(sync.body.data.account.status).toBe('disconnected');
      expect(mockClient.retrieveAccount).not.toHaveBeenCalled();

      const again = await authenticatedRequest('post', '/api/payments/account/onboarding-link');
      expect(again.status).toBe(201);
      expect(mockClient.createAccount).toHaveBeenCalledTimes(1);
      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ status: 'onboarding', disconnected_at: null, stripe_account_id: 'acct_1TestSchool' });
    });
  });

  it('never shows or changes another school\u2019s connection', async () => {
    await getTestPool().query(
      `INSERT INTO payment_accounts (school, livemode, stripe_account_id, status) VALUES ('PLAYGROUND', false, 'acct_1OtherSchool', 'active')`,
    );
    const res = await authenticatedRequest('get', '/api/payments/account');
    expect(res.body.data.account).toBeNull();

    expect((await authenticatedRequest('delete', '/api/payments/account')).status).toBe(404);
    expect((await authenticatedRequest('post', '/api/payments/account/sync')).status).toBe(404);
    const { rows: other } = await getTestPool().query(`SELECT status FROM payment_accounts WHERE school = 'PLAYGROUND'`);
    expect(other[0].status).toBe('active');
    expect(mockClient.retrieveAccount).not.toHaveBeenCalled();
  });

  it('keeps test and live rows apart', async () => {
    await getTestPool().query(
      `INSERT INTO payment_accounts (school, livemode, stripe_account_id, status) VALUES ($1, true, 'acct_1LiveSchool', 'active')`,
      [SCHOOL],
    );
    const res = await authenticatedRequest('get', '/api/payments/account');
    expect(res.body.data.account).toBeNull();

    await authenticatedRequest('delete', '/api/payments/account');
    const { rows: live } = await getTestPool().query(`SELECT status FROM payment_accounts WHERE livemode`);
    expect(live[0].status).toBe('active');
  });
});
