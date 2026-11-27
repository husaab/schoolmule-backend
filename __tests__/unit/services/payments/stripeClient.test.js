const { createClient, keyMode, DEFAULT_API_VERSION, StripeApiError, StripeConfigError } = require('../../../../services/payments/stripeClient');

const TEST_KEY = 'sk_test_unit';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function makeClient(over = {}) {
  const fetchImpl = jest.fn();
  const sleep = jest.fn().mockResolvedValue();
  const client = createClient({ secretKey: TEST_KEY, fetchImpl, sleep, ...over });
  return { client, fetchImpl, sleep };
}

describe('stripeClient keys', () => {
  it('reads the mode from the key prefix', () => {
    expect(keyMode('sk_test_abc')).toBe('test');
    expect(keyMode('rk_test_abc')).toBe('test');
    expect(keyMode('sk_live_abc')).toBe('live');
    expect(keyMode('pk_test_abc')).toBeNull();
    expect(keyMode(undefined)).toBeNull();
  });

  it('refuses a missing or publishable key', () => {
    expect(() => createClient({ secretKey: undefined })).toThrow(StripeConfigError);
    expect(() => createClient({ secretKey: 'pk_test_abc' })).toThrow(StripeConfigError);
  });

  it('refuses a live key unless this process is allowed to use one', () => {
    expect(() => createClient({ secretKey: 'sk_live_abc' })).toThrow(/STRIPE_LIVE_ENABLED/);
    const client = createClient({ secretKey: 'sk_live_abc', liveEnabled: true });
    expect(client.mode).toBe('live');
    expect(client.livemode).toBe(true);
  });

  it('a test key is test mode', () => {
    const { client } = makeClient();
    expect(client.mode).toBe('test');
    expect(client.livemode).toBe(false);
  });
});

describe('stripeClient.request', () => {
  it('sends the bearer key, the pinned version and a JSON body', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ id: 'acct_1' }));
    await client.request('POST', '/v2/core/accounts', { body: { a: 1 }, idempotencyKey: 'k1' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(init.headers['Stripe-Version']).toBe(DEFAULT_API_VERSION);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Idempotency-Key']).toBe('k1');
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });

  it('turns a Stripe error body into a StripeApiError', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ error: { code: 'accounts_v2_access_blocked', message: 'Accounts v2 is not enabled', type: 'invalid_request_error' } }, 400));
    await expect(client.request('GET', '/v2/core/accounts/acct_1')).rejects.toMatchObject({
      name: 'StripeApiError', status: 400, code: 'accounts_v2_access_blocked', retryable: false, message: 'Accounts v2 is not enabled',
    });
  });

  it('retries a read on 5xx and on a network failure', async () => {
    const { client, fetchImpl, sleep } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({}, 503));
    fetchImpl.mockRejectedValueOnce(new Error('socket hang up'));
    fetchImpl.mockResolvedValueOnce(json({ id: 'acct_1' }));
    await expect(client.request('GET', '/v2/core/accounts/acct_1')).resolves.toEqual({ id: 'acct_1' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('never repeats a write that has no idempotency key', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ error: { message: 'boom' } }, 500));
    await expect(client.request('POST', '/v2/core/account_links', { body: {} })).rejects.toMatchObject({ status: 500, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('repeats a write that has an idempotency key, then gives up', async () => {
    const { client, fetchImpl } = makeClient({ maxRetries: 2 });
    fetchImpl.mockResolvedValue(json({ error: { message: 'slow down' } }, 429));
    await expect(client.request('POST', '/v2/core/accounts', { body: {}, idempotencyKey: 'k' })).rejects.toBeInstanceOf(StripeApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('stripeClient accounts', () => {
  it('creates the school as the merchant, with Stripe billing it and carrying its losses', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ id: 'acct_1' }));
    await client.createAccount(
      { displayName: 'Al Haadi Academy', contactEmail: 'office@example.com', country: 'ca', currency: 'cad' },
      { idempotencyKey: 'schoolmule-account-ALHAADIACADEMY-test' },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(init.headers['Idempotency-Key']).toBe('schoolmule-account-ALHAADIACADEMY-test');
    expect(JSON.parse(init.body)).toEqual({
      display_name: 'Al Haadi Academy',
      contact_email: 'office@example.com',
      dashboard: 'full',
      identity: { country: 'ca' },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { currency: 'cad', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      include: ['configuration.merchant', 'requirements'],
    });
  });

  it('reads an account back with its capabilities and requirements', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ id: 'acct_1' }));
    await client.retrieveAccount('acct_1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v2/core/accounts/acct_1?include%5B0%5D=configuration.merchant&include%5B1%5D=requirements');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('refuses an account id that is not one', () => {
    const { client } = makeClient();
    expect(() => client.retrieveAccount('../v1/charges')).toThrow(/Invalid Stripe account id/);
  });

  it('asks for a hosted onboarding link that collects everything up front', async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValueOnce(json({ url: 'https://connect.stripe.com/setup/x' }));
    const link = await client.createAccountLink({ accountId: 'acct_1', returnUrl: 'https://app/ret', refreshUrl: 'https://app/ref' });
    expect(link.url).toBe('https://connect.stripe.com/setup/x');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      account: 'acct_1',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: { collection_options: { fields: 'eventually_due' }, return_url: 'https://app/ret', refresh_url: 'https://app/ref' },
      },
    });
  });
});
