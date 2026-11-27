// Stripe's webhook and the worker behind it, against the real schema: the
// signature check, the events inbox, and what each event does to a school's
// connection. Stripe itself is replaced by a fake client.
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

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { sign } = require('../../../services/payments/webhookSignature');
const { StripeApiError } = require('../../../services/payments/errors');
const worker = require('../../../services/payments/paymentsWorker');

const SCHOOL = 'ALHAADIACADEMY';
const SECRET = 'whsec_integration_test_secret';
const URL = '/api/payments/stripe/webhook';
const ACCT = 'acct_1TestSchool';

const stripeAccount = ({ card = 'restricted', payouts = 'restricted', due = 2 } = {}) => ({
  id: ACCT,
  display_name: 'Al Haadi Academy',
  configuration: { merchant: { capabilities: { card_payments: { status: card }, stripe_balance: { payouts: { status: payouts } } } } },
  requirements: { entries: Array.from({ length: due }, () => ({ awaiting_action_from: 'user', minimum_deadline: { status: 'currently_due' } })) },
});

let seq = 0;
const event = (over = {}) => ({
  id: `evt_test_${Date.now()}_${seq += 1}`,
  object: 'event',
  type: 'account.updated',
  livemode: false,
  account: ACCT,
  created: 1795730000,
  data: { object: { id: ACCT, object: 'account' } },
  ...over,
});

/** Posts an event the way Stripe does: raw JSON bytes plus a signature over them. */
function deliver(evt, { secret = SECRET, header, body } = {}) {
  const raw = body ?? JSON.stringify(evt);
  return request(getApp())
    .post(URL)
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header ?? sign({ rawBody: raw, secret }))
    .send(raw);
}

const pool = () => getTestPool();
const events = async () => (await pool().query(`SELECT * FROM stripe_events ORDER BY received_at`)).rows;
const account = async () => (await pool().query(`SELECT * FROM payment_accounts WHERE stripe_account_id = $1`, [ACCT])).rows[0];
const connectSchool = (status = 'onboarding', livemode = false) => pool().query(
  `INSERT INTO payment_accounts (school, livemode, stripe_account_id, status, card_payments_status) VALUES ($1, $2, $3, $4, 'restricted')`,
  [SCHOOL, livemode, ACCT, status],
);

describe('Stripe webhook (integration)', () => {
  const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
  beforeEach(() => {
    mockConfigured = true;
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    mockClient.retrieveAccount.mockReset().mockResolvedValue(stripeAccount());
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
  });

  describe('what gets in', () => {
    it('keeps a signed event it has a handler for, without a session token', async () => {
      const evt = event();
      const res = await deliver(evt);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, kept: true });
      const stored = await events();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        event_id: evt.id, livemode: false, type: 'account.updated', stripe_account_id: ACCT, object_id: ACCT, state: 'queued', attempts: 0,
      });
      expect(stored[0].stripe_created_at.toISOString()).toBe(new Date(1795730000 * 1000).toISOString());
    });

    it('keeps a repeat delivery only once', async () => {
      const evt = event();
      await deliver(evt);
      const again = await deliver(evt);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ received: true, kept: false });
      expect(await events()).toHaveLength(1);
    });

    it('refuses a bad signature and keeps nothing', async () => {
      const evt = event();
      expect((await deliver(evt, { secret: 'whsec_wrong' })).status).toBe(400);
      expect((await deliver(evt, { header: 'nonsense' })).status).toBe(400);
      const res = await request(getApp()).post(URL).set('Content-Type', 'application/json').send(JSON.stringify(evt));
      expect(res.status).toBe(400);
      expect(await events()).toHaveLength(0);
    });

    it('refuses a body that differs from what was signed by a single space', async () => {
      const evt = event();
      const raw = JSON.stringify(evt);
      const res = await deliver(evt, { header: sign({ rawBody: raw, secret: SECRET }), body: `${raw} ` });
      expect(res.status).toBe(400);
      expect(await events()).toHaveLength(0);
    });

    it('refuses a signature older than five minutes', async () => {
      const evt = event();
      const raw = JSON.stringify(evt);
      const header = sign({ rawBody: raw, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) - 600 });
      expect((await deliver(evt, { header })).status).toBe(400);
    });

    it('accepts either of two endpoint secrets', async () => {
      process.env.STRIPE_WEBHOOK_SECRET = `whsec_platform_endpoint,${SECRET}`;
      expect((await deliver(event())).status).toBe(200);
      expect(await events()).toHaveLength(1);
    });

    it('answers but does not keep an event of the other Stripe mode', async () => {
      const res = await deliver(event({ livemode: true }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, kept: false, reason: 'other mode' });
      expect(await events()).toHaveLength(0);
    });

    it('answers but does not keep a type nothing handles', async () => {
      const res = await deliver(event({ type: 'customer.created' }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, kept: false, reason: 'not handled' });
      expect(await events()).toHaveLength(0);
    });

    it('refuses a signed body that is not an event', async () => {
      expect((await deliver(null, { body: 'not json' })).status).toBe(400);
      expect((await deliver({ id: 'evt_1' })).status).toBe(400);
      expect((await deliver({ id: 'not-an-event-id', type: 'account.updated', livemode: false })).status).toBe(400);
      expect(await events()).toHaveLength(0);
    });

    it('answers 503 so Stripe retries when the server has no key or no signing secret', async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      expect((await deliver(event())).status).toBe(503);
      process.env.STRIPE_WEBHOOK_SECRET = SECRET;
      mockConfigured = false;
      expect((await deliver(event())).status).toBe(503);
      expect(await events()).toHaveLength(0);
    });

    it('leaves every other route parsing JSON as before', async () => {
      const res = await authenticatedRequest('post', '/api/payments/account/sync').send({ any: 'body' });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Stripe is not connected');
    });
  });

  describe('what the worker does with it', () => {
    it('re-reads the school’s account from Stripe on account.updated', async () => {
      await connectSchool();
      await deliver(event());
      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'active', payouts: 'active', due: 0 }));

      expect(await worker.drainOnce({ client: mockClient })).toBe(1);
      expect(mockClient.retrieveAccount).toHaveBeenCalledWith(ACCT);
      expect(await account()).toMatchObject({ status: 'active', card_payments_status: 'active', payouts_status: 'active', requirements_due: 0 });
      const [done] = await events();
      expect(done).toMatchObject({ state: 'done', attempts: 1, last_error: null });
      expect(done.processed_at).toBeTruthy();

      // Nothing left to do.
      expect(await worker.drainOnce({ client: mockClient })).toBe(0);
    });

    it('takes account.updated from a "Your account" destination too, where the account is the object', async () => {
      await connectSchool();
      // Accounts v2 sends a platform's own accounts' events without event.account.
      await deliver(event({ account: undefined }));
      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'active', payouts: 'active', due: 0 }));
      expect(await worker.drainOnce({ client: mockClient })).toBe(1);
      expect(mockClient.retrieveAccount).toHaveBeenCalledWith(ACCT);
      expect(await account()).toMatchObject({ status: 'active' });
    });

    it('reports restricted when Stripe pauses a school that was active', async () => {
      await connectSchool('active');
      await pool().query(`UPDATE payment_accounts SET activated_at = now()`);
      await deliver(event());
      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'restricted', due: 1 }));
      await worker.drainOnce({ client: mockClient });
      expect(await account()).toMatchObject({ status: 'restricted', requirements_due: 1 });
    });

    it('finishes quietly for an account that is not one of our schools', async () => {
      await deliver(event({ account: 'acct_1SomeoneElse' }));
      expect(await worker.drainOnce({ client: mockClient })).toBe(1);
      expect(mockClient.retrieveAccount).not.toHaveBeenCalled();
      expect((await events())[0].state).toBe('done');
    });

    it('leaves a school that turned payments off alone', async () => {
      await connectSchool('disconnected');
      await deliver(event());
      await worker.drainOnce({ client: mockClient });
      expect(mockClient.retrieveAccount).not.toHaveBeenCalled();
      expect((await account()).status).toBe('disconnected');
    });

    it('turns the school off when it disconnects SchoolMule from Stripe’s side', async () => {
      await connectSchool('active');
      await deliver(event({ type: 'account.application.deauthorized', data: { object: { id: 'ca_app', object: 'application' } } }));
      await worker.drainOnce({ client: mockClient });
      const row = await account();
      expect(row.status).toBe('disconnected');
      expect(row.disconnected_at).toBeTruthy();
      expect(mockClient.retrieveAccount).not.toHaveBeenCalled();
    });

    it('puts a failed event back with a growing wait, and it succeeds on a later try', async () => {
      await connectSchool();
      await deliver(event());
      mockClient.retrieveAccount.mockRejectedValueOnce(new StripeApiError('Stripe HTTP 503', { status: 503, retryable: true }));

      expect(await worker.drainOnce({ client: mockClient })).toBe(1);
      let [row] = await events();
      expect(row).toMatchObject({ state: 'queued', attempts: 1, last_error: 'Stripe HTTP 503' });
      expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 2000);

      // Not due yet.
      expect(await worker.drainOnce({ client: mockClient })).toBe(0);

      await pool().query(`UPDATE stripe_events SET next_attempt_at = now()`);
      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'active', payouts: 'active', due: 0 }));
      expect(await worker.drainOnce({ client: mockClient })).toBe(1);
      [row] = await events();
      expect(row).toMatchObject({ state: 'done', attempts: 2, last_error: null });
      expect((await account()).status).toBe('active');
    });

    it('gives up after the last attempt', async () => {
      await connectSchool();
      await deliver(event());
      await pool().query(`UPDATE stripe_events SET attempts = $1`, [worker.MAX_ATTEMPTS - 1]);
      mockClient.retrieveAccount.mockRejectedValueOnce(new StripeApiError('Stripe HTTP 503', { status: 503, retryable: true }));
      await worker.drainOnce({ client: mockClient });
      expect((await events())[0]).toMatchObject({ state: 'failed', attempts: worker.MAX_ATTEMPTS });
      expect(await worker.drainOnce({ client: mockClient })).toBe(0);
    });

    it('does not retry what Stripe refuses outright', async () => {
      await connectSchool();
      await deliver(event());
      mockClient.retrieveAccount.mockRejectedValueOnce(new StripeApiError('No such account', { status: 404, code: 'not_found', retryable: false }));
      await worker.drainOnce({ client: mockClient });
      expect((await events())[0]).toMatchObject({ state: 'failed', attempts: 1, last_error: 'No such account' });
    });

    it('never claims an event of the other Stripe mode', async () => {
      await pool().query(`INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id) VALUES ('evt_live_1', true, 'account.updated', $1)`, [ACCT]);
      expect(await worker.drainOnce({ client: mockClient })).toBe(0);
      expect((await events())[0]).toMatchObject({ state: 'queued', attempts: 0 });
      expect(await worker.drainOnce({ client: { ...mockClient, mode: 'live', livemode: true } })).toBe(1);
    });

    it('picks up an event whose worker died part-way', async () => {
      await connectSchool();
      await deliver(event());
      await pool().query(`UPDATE stripe_events SET state = 'running', attempts = 1, claimed_at = now() - interval '1 minute'`);
      expect(await worker.drainOnce({ client: mockClient })).toBe(0);
      await pool().query(`UPDATE stripe_events SET claimed_at = now() - interval '6 minutes'`);
      expect(await worker.drainOnce({ client: mockClient })).toBe(1);
      expect((await events())[0]).toMatchObject({ state: 'done', attempts: 2 });
    });

    it('drains a burst in one go, oldest first', async () => {
      await connectSchool();
      await deliver(event());
      await deliver(event());
      await deliver(event());
      expect(await worker.drainAll({ client: mockClient })).toBe(3);
      expect((await events()).every((e) => e.state === 'done')).toBe(true);
    });
  });

  describe('the daily re-check', () => {
    beforeEach(() => worker._resetDaily());

    it('re-reads every connected school once a day and clears old handled events', async () => {
      await connectSchool();
      await pool().query(`INSERT INTO payment_accounts (school, livemode, stripe_account_id, status) VALUES ('PLAYGROUND', false, 'acct_1Playground', 'disconnected')`);
      await pool().query(`INSERT INTO payment_accounts (school, livemode, stripe_account_id, status) VALUES ('PLAYGROUND', true, 'acct_1PlaygroundLive', 'active')`);
      await pool().query(
        `INSERT INTO stripe_events (event_id, livemode, type, state, processed_at) VALUES
           ('evt_old_done', false, 'account.updated', 'done', now() - interval '31 days'),
           ('evt_recent_done', false, 'account.updated', 'done', now() - interval '2 days'),
           ('evt_old_failed', false, 'account.updated', 'failed', now() - interval '31 days'),
           ('evt_old_live', true, 'account.updated', 'done', now() - interval '31 days')`,
      );
      mockClient.retrieveAccount.mockResolvedValueOnce(stripeAccount({ card: 'active', payouts: 'active', due: 0 }));

      expect(await worker.runDailyIfDue({ client: mockClient, today: '2026-11-27' })).toBe(true);
      // Only the connected school of this mode.
      expect(mockClient.retrieveAccount).toHaveBeenCalledTimes(1);
      expect(mockClient.retrieveAccount).toHaveBeenCalledWith(ACCT);
      expect((await account()).status).toBe('active');
      expect((await events()).map((e) => e.event_id).sort()).toEqual(['evt_old_failed', 'evt_old_live', 'evt_recent_done']);

      // The same day again does nothing.
      expect(await worker.runDailyIfDue({ client: mockClient, today: '2026-11-27' })).toBe(false);
      expect(mockClient.retrieveAccount).toHaveBeenCalledTimes(1);
    });

    it('carries on past a school Stripe will not answer for', async () => {
      await connectSchool();
      await pool().query(`INSERT INTO payment_accounts (school, livemode, stripe_account_id, status, connected_at) VALUES ('PLAYGROUND', false, 'acct_1Playground', 'onboarding', now() + interval '1 second')`);
      mockClient.retrieveAccount
        .mockRejectedValueOnce(new StripeApiError('Stripe HTTP 503', { status: 503, retryable: true }))
        .mockResolvedValueOnce({ ...stripeAccount({ card: 'active', payouts: 'active', due: 0 }), id: 'acct_1Playground' });
      expect(await worker.refreshAllAccounts({ client: mockClient })).toBe(1);
      expect((await account()).last_error).toBe('Stripe HTTP 503');
      const { rows } = await pool().query(`SELECT status FROM payment_accounts WHERE school = 'PLAYGROUND'`);
      expect(rows[0].status).toBe('active');
    });
  });
});
