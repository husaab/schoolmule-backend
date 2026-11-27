// Paying through a form, against the real schema: the payment field in the
// builder, a family's submission and Stripe Checkout, the family's link, the
// webhook, and the office's actions. Stripe itself is a fake client.
const mockClient = {
  mode: 'test',
  livemode: false,
  createAccount: jest.fn(),
  retrieveAccount: jest.fn(),
  createAccountLink: jest.fn(),
  createCheckoutSession: jest.fn(),
  retrieveCheckoutSession: jest.fn(),
  expireCheckoutSession: jest.fn(),
  createRefund: jest.fn(),
  listRefunds: jest.fn(),
  retrieveDispute: jest.fn(),
  listPayouts: jest.fn(),
  retrieveBalance: jest.fn(),
  listPaymentMethodDomains: jest.fn(),
  createPaymentMethodDomain: jest.fn(),
  request: jest.fn(),
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
const worker = require('../../../services/payments/paymentsWorker');

const SCHOOL = 'ALHAADIACADEMY';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEACHER = { userId: TEACHER_ID, username: 'Teacher User', email: 'teacher@test.com', role: 'TEACHER' };
const ACCT = 'acct_1MapleGrove';
const SECRET = 'whsec_form_payments_test';

const pool = () => getTestPool();
let ip = 0;
const publicPost = (url, body) => request(getApp()).post(url).set('X-Forwarded-For', `203.0.113.${(ip += 1) % 250}`).send(body);
const publicGet = (url) => request(getApp()).get(url).set('X-Forwarded-For', `198.51.100.${(ip += 1) % 250}`);

const PAYMENT = {
  items: [
    { id: 'trip', label: 'Trip fee', amountCents: 2500, required: true },
    { id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false },
  ],
  allowOffline: true,
  accountingCode: '4210 Field trips',
};

async function seedUsers() {
  for (const [id, email, role] of [[ADMIN_ID, 'admin@test.com', 'ADMIN'], [TEACHER_ID, 'teacher@test.com', 'TEACHER']]) {
    await pool().query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Test', $4, $5, $6, true, true) ON CONFLICT (user_id) DO NOTHING`,
      [id, email, email, role, SCHOOL, role],
    );
  }
}

/** A published form: name, email, permission, and the payment field. Returns the ids. */
async function seedForm({ createdBy = ADMIN_ID, payment = PAYMENT, withEmail = true, status = 'published' } = {}) {
  await pool().query(`UPDATE schools SET slug = 'maple', email = 'office@maple.example' WHERE school_code = $1`, [SCHOOL]);
  await pool().query(
    `INSERT INTO registration_statuses (school, key, label, is_builtin, is_default) VALUES ($1, 'new', 'New', true, true)
     ON CONFLICT DO NOTHING`,
    [SCHOOL],
  );
  const { rows: [form] } = await pool().query(
    `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ($1, 'Grade 5 Field Trip', 'trip', $2, $3) RETURNING form_id`,
    [SCHOOL, status, createdBy],
  );
  const ids = { formId: form.form_id };
  const add = async (key, type, label, order, config = null, required = false) => {
    const { rows: [f] } = await pool().query(
      `INSERT INTO registration_form_fields (form_id, field_type, label, is_required, sort_order, payment_config)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING field_id`,
      [form.form_id, type, label, required, order, config ? JSON.stringify({ ...config, currency: 'cad' }) : null],
    );
    ids[key] = f.field_id;
  };
  await add('name', 'text', 'Student name', 0, null, true);
  if (withEmail) await add('email', 'email', 'Parent email', 1, null, true);
  if (payment) await add('payment', 'payment', 'Payment', 2, payment);
  return ids;
}

const connectSchool = (status = 'active') => pool().query(
  `INSERT INTO payment_accounts (school, livemode, stripe_account_id, status, card_payments_status) VALUES ($1, false, $2, $3, 'active') RETURNING payment_account_id`,
  [SCHOOL, ACCT, status],
);

const answers = (ids, over = {}) => ({ [ids.name]: 'Aisha K.', [ids.email]: 'Sara@Example.com', ...over });

const session = (over = {}) => ({
  id: 'cs_test_1',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  status: 'open',
  payment_status: 'unpaid',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

/** Stripe's copy of a finished session for a charge, with the payment expanded. */
const paidSession = (chargeId, { id = 'cs_test_1', amount = 3100 } = {}) => session({
  id,
  status: 'complete',
  payment_status: 'paid',
  amount_total: amount,
  client_reference_id: chargeId,
  metadata: { charge_id: chargeId },
  payment_intent: {
    id: `pi_${id}`,
    latest_charge: {
      id: `ch_${id}`,
      payment_method_details: { card: { brand: 'visa', last4: '4242', wallet: null } },
      balance_transaction: { fee: 120 },
    },
  },
});

const charge = async () => (await pool().query(`SELECT * FROM charges ORDER BY created_at DESC LIMIT 1`)).rows[0];
const payments = async (chargeId) => (await pool().query(`SELECT * FROM charge_payments WHERE charge_id = $1 ORDER BY created_at`, [chargeId])).rows;
const outbox = async () => (await pool().query(`SELECT kind, recipient_email, dedupe_key, payload FROM email_outbox ORDER BY created_at`)).rows;

async function submitCard(ids, extra = {}) {
  return publicPost('/api/registration/public/maple/trip/submit', {
    answers: answers(ids), payment: { itemIds: ['lunch'], method: 'card' }, ...extra,
  });
}

beforeEach(async () => {
  mockConfigured = true;
  Object.values(mockClient).forEach((fn) => typeof fn === 'function' && fn.mockReset && fn.mockReset());
  mockClient.createCheckoutSession.mockResolvedValue(session());
  mockClient.expireCheckoutSession.mockResolvedValue({});
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  await seedUsers();
});

describe('the payment field in the builder', () => {
  it('saves a payment field and gives it back tidied', async () => {
    const { formId } = await seedForm({ payment: null, status: 'draft' });
    const res = await authenticatedRequest('put', `/api/registration/forms/${formId}/fields`).send({
      fields: [
        { fieldType: 'email', label: 'Parent email', isRequired: true },
        { fieldType: 'payment', label: 'Payment', isRequired: true, options: ['x'], payment: { ...PAYMENT, accountingCode: ' 4210 ' } },
      ],
    });
    expect(res.status).toBe(200);
    const pay = res.body.data.find((f) => f.fieldType === 'payment');
    expect(pay).toMatchObject({ isRequired: false, options: null });
    expect(pay.payment).toEqual({ ...PAYMENT, accountingCode: '4210', currency: 'cad' });
  });

  it('refuses a second payment field, and a price under 50 cents', async () => {
    const { formId } = await seedForm({ payment: null, status: 'draft' });
    const two = await authenticatedRequest('put', `/api/registration/forms/${formId}/fields`).send({
      fields: [{ fieldType: 'payment', label: 'A', payment: PAYMENT }, { fieldType: 'payment', label: 'B', payment: PAYMENT }],
    });
    expect(two.status).toBe(400);
    expect(two.body.message).toMatch(/one payment field/);
    const cheap = await authenticatedRequest('put', `/api/registration/forms/${formId}/fields`).send({
      fields: [{ fieldType: 'payment', label: 'A', payment: { items: [{ id: 'a', label: 'Sticker', amountCents: 25, required: true }] } }],
    });
    expect(cheap.status).toBe(400);
    expect(cheap.body.message).toMatch(/\$0\.50/);
  });

  it('won’t publish without an email field, or card-only without Stripe connected', async () => {
    const noEmail = await seedForm({ withEmail: false, status: 'draft' });
    let res = await authenticatedRequest('patch', `/api/registration/forms/${noEmail.formId}/status`).send({ status: 'published' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Add an Email field/);

    await pool().query('DELETE FROM registration_form_fields; DELETE FROM registration_forms');
    const cardOnly = await seedForm({ payment: { ...PAYMENT, allowOffline: false }, status: 'draft' });
    res = await authenticatedRequest('patch', `/api/registration/forms/${cardOnly.formId}/status`).send({ status: 'published' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYMENT_NOT_READY');

    await connectSchool();
    res = await authenticatedRequest('patch', `/api/registration/forms/${cardOnly.formId}/status`).send({ status: 'published' });
    expect(res.status).toBe(200);
  });

  it('tells the builder whether card payments are on', async () => {
    let res = await authenticatedRequest('get', '/api/registration/payment-availability');
    expect(res.body.data).toMatchObject({ configured: true, online: false, accountStatus: null });
    await connectSchool();
    res = await authenticatedRequest('get', '/api/registration/payment-availability', TEACHER);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ online: true, accountStatus: 'active', mode: 'test' });
  });
});

describe('a family paying through the form', () => {
  it('shows the price list without the accounting code, and whether cards work', async () => {
    await seedForm();
    let res = await publicGet('/api/registration/public/maple/trip');
    expect(res.status).toBe(200);
    const field = res.body.data.fields.find((f) => f.fieldType === 'payment');
    expect(field.payment.items).toHaveLength(2);
    expect(field.payment.accountingCode).toBeUndefined();
    expect(res.body.data.payments).toEqual({ online: false, currency: 'cad', testMode: true });
    await connectSchool();
    res = await publicGet('/api/registration/public/maple/trip');
    expect(res.body.data.payments.online).toBe(true);
  });

  it('keeps the response and a charge, then sends the family to Stripe on the school’s account', async () => {
    const ids = await seedForm();
    await connectSchool();
    const res = await submitCard(ids, { answers: answers(ids, { [`${'x'}`]: 'ignored' }) });
    expect(res.status).toBe(201);
    const pay = res.body.data.payment;
    expect(pay).toMatchObject({ method: 'card', totalCents: 3100, checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    const c = await charge();
    expect(c).toMatchObject({
      school: SCHOOL, livemode: false, amount_cents: 3100, status: 'unpaid', chosen_method: 'card',
      payer_email: 'sara@example.com', description: 'Grade 5 Field Trip', accounting_code: '4210 Field trips',
      checkout_session_id: 'cs_test_1', checkout_attempts: 1,
    });
    expect(pay.token).toBe(c.public_token);
    const { rows: lines } = await pool().query('SELECT label, amount_cents FROM charge_lines WHERE charge_id = $1 ORDER BY sort_order', [c.charge_id]);
    expect(lines).toEqual([{ label: 'Trip fee', amount_cents: 2500 }, { label: 'Pizza lunch', amount_cents: 600 }]);

    const [accountId, params, opts] = mockClient.createCheckoutSession.mock.calls[0];
    expect(accountId).toBe(ACCT);
    expect(params).toMatchObject({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      customer_email: 'sara@example.com',
      client_reference_id: c.charge_id,
      metadata: { charge_id: c.charge_id, source: 'schoolmule_form' },
      payment_intent_data: { description: 'Grade 5 Field Trip', metadata: { charge_id: c.charge_id, source: 'schoolmule_form' } },
      success_url: `http://localhost:3000/pay/${c.public_token}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:3000/pay/${c.public_token}?cancelled=1`,
    });
    expect(params.line_items).toEqual([
      { price_data: { currency: 'cad', unit_amount: 2500, product_data: { name: 'Trip fee' } }, quantity: 1 },
      { price_data: { currency: 'cad', unit_amount: 600, product_data: { name: 'Pizza lunch' } }, quantity: 1 },
    ]);
    // Nothing about the student goes to Stripe.
    expect(JSON.stringify(params)).not.toMatch(/Aisha/);
    expect(opts.idempotencyKey).toBe(`schoolmule-checkout-${c.charge_id}-1`);

    const { rows: [sub] } = await pool().query('SELECT answers FROM registration_form_submissions');
    expect(sub.answers[ids.payment]).toBe('Trip fee $25.00, Pizza lunch $6.00 · Total $31.00 · Paying online');
  });

  it('prices from the form, not from the browser, and refuses an unknown item', async () => {
    const ids = await seedForm();
    await connectSchool();
    const forged = await publicPost('/api/registration/public/maple/trip/submit', {
      answers: answers(ids, { [ids.payment]: 'Total $0.01' }), payment: { itemIds: [], method: 'card', totalCents: 1 },
    });
    expect(forged.status).toBe(201);
    expect((await charge()).amount_cents).toBe(2500);
    const bad = await publicPost('/api/registration/public/maple/trip/submit', { answers: answers(ids), payment: { itemIds: ['ipad'] } });
    expect(bad.status).toBe(400);
  });

  it('needs an email for the receipt', async () => {
    const ids = await seedForm();
    await connectSchool();
    const res = await publicPost('/api/registration/public/maple/trip/submit', { answers: { [ids.name]: 'Aisha', [ids.email]: 'not-an-email' }, payment: {} });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/email address/);
  });

  it('takes a pay-at-the-office answer without Stripe, and refuses cards while Stripe is off', async () => {
    const ids = await seedForm();
    const card = await submitCard(ids);
    expect(card.status).toBe(409);
    expect(card.body.code).toBe('PAYMENTS_UNAVAILABLE');
    const office = await publicPost('/api/registration/public/maple/trip/submit', { answers: answers(ids), payment: { method: 'offline' } });
    expect(office.status).toBe(201);
    expect(office.body.data.payment).toMatchObject({ method: 'offline', totalCents: 2500, checkoutUrl: null });
    expect(mockClient.createCheckoutSession).not.toHaveBeenCalled();
    expect((await charge()).chosen_method).toBe('offline');
  });

  it('makes no charge when nothing is owed', async () => {
    const ids = await seedForm({ payment: { items: [{ id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false }] } });
    const res = await publicPost('/api/registration/public/maple/trip/submit', { answers: answers(ids), payment: { itemIds: [] } });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toBeNull();
    expect(await charge()).toBeUndefined();
  });

  it('keeps the response when Stripe can’t open a page, and the family can try again from their link', async () => {
    const ids = await seedForm();
    await connectSchool();
    mockClient.createCheckoutSession.mockRejectedValueOnce(Object.assign(new Error('Stripe HTTP 500'), { name: 'StripeApiError', status: 500 }));
    const res = await submitCard(ids);
    expect(res.status).toBe(201);
    expect(res.body.data.payment.checkoutUrl).toBeNull();
    const c = await charge();

    mockClient.createCheckoutSession.mockResolvedValueOnce(session({ id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' }));
    const again = await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, {});
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_2', clientSecret: null, stripeAccountId: null, paid: false });
  });

  it('reuses an open page with time left rather than opening a second one', async () => {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids);
    const c = await charge();
    mockClient.retrieveCheckoutSession.mockResolvedValueOnce(session());
    const res = await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, {});
    expect(res.body.data.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(mockClient.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('closes a page about to expire before opening a new one', async () => {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids);
    const c = await charge();
    mockClient.retrieveCheckoutSession.mockResolvedValueOnce(session({ expires_at: Math.floor(Date.now() / 1000) + 60 }));
    mockClient.createCheckoutSession.mockResolvedValueOnce(session({ id: 'cs_test_2' }));
    await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, {});
    expect(mockClient.expireCheckoutSession).toHaveBeenCalledWith(ACCT, 'cs_test_1');
    expect((await charge()).checkout_session_id).toBe('cs_test_2');
  });
});

describe('paying inside our own page (embedded Checkout)', () => {
  const embeddedSession = (over = {}) => session({ id: 'cs_emb_1', url: null, client_secret: 'cs_emb_1_secret_abc', ui_mode: 'embedded_page', ...over });
  let frontend;
  beforeAll(() => { frontend = process.env.FRONTEND_URL; process.env.FRONTEND_URL = 'https://schoolmule.ca'; });
  afterAll(() => { process.env.FRONTEND_URL = frontend; });

  it('closes Stripe’s own page when the family switches to ours, and cards work even if wallets can’t be set up', async () => {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids);
    const c = await charge();
    // Stripe's page (cs_test_1) is open with time left, but it isn't the kind asked for.
    mockClient.retrieveCheckoutSession.mockResolvedValueOnce(session());
    mockClient.listPaymentMethodDomains.mockRejectedValueOnce(new Error('Stripe HTTP 500'));
    mockClient.createCheckoutSession.mockResolvedValueOnce(embeddedSession());
    const res = await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, { ui: 'embedded' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: null, clientSecret: 'cs_emb_1_secret_abc', stripeAccountId: ACCT, paid: false });
    expect(mockClient.expireCheckoutSession).toHaveBeenCalledWith(ACCT, 'cs_test_1');
    expect((await charge()).checkout_session_id).toBe('cs_emb_1');
  });

  it('a form sent from the web opens no Stripe page; the family’s form inside ours returns to their link', async () => {
    const ids = await seedForm();
    await connectSchool();
    const sent = await submitCard(ids, { payment: { itemIds: ['lunch'], method: 'card', ui: 'embedded' } });
    expect(sent.status).toBe(201);
    expect(sent.body.data.payment).toMatchObject({ method: 'card', checkoutUrl: null, totalCents: 3100 });
    expect(mockClient.createCheckoutSession).not.toHaveBeenCalled();
    const c = await charge();

    mockClient.listPaymentMethodDomains.mockResolvedValueOnce({ data: [] });
    mockClient.createPaymentMethodDomain.mockResolvedValueOnce({ id: 'pmd_1', domain_name: 'schoolmule.ca' });
    mockClient.createCheckoutSession.mockResolvedValueOnce(embeddedSession());
    const res = await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, { ui: 'embedded' });
    expect(res.body.data).toEqual({ url: null, clientSecret: 'cs_emb_1_secret_abc', stripeAccountId: ACCT, paid: false });

    const [account, params] = mockClient.createCheckoutSession.mock.calls[0];
    expect(account).toBe(ACCT);
    expect(params).toMatchObject({ ui_mode: 'embedded_page', return_url: `https://schoolmule.ca/pay/${c.public_token}?session_id={CHECKOUT_SESSION_ID}` });
    expect(params.success_url).toBeUndefined();
    expect(params.cancel_url).toBeUndefined();
    // Wallets inside our page need our domain on the school's own account.
    expect(mockClient.createPaymentMethodDomain).toHaveBeenCalledWith(ACCT, 'schoolmule.ca');

    // Opening it again reuses the open form, and doesn't check the domain twice.
    mockClient.retrieveCheckoutSession.mockResolvedValueOnce(embeddedSession());
    const again = await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, { ui: 'embedded' });
    expect(again.body.data.clientSecret).toBe('cs_emb_1_secret_abc');
    expect(mockClient.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(mockClient.listPaymentMethodDomains).toHaveBeenCalledTimes(1);
  });

  it('two requests at once (a double click, two tabs) open one form and both get it', async () => {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids, { payment: { itemIds: ['lunch'], method: 'card', ui: 'embedded' } });
    const c = await charge();
    mockClient.listPaymentMethodDomains.mockResolvedValue({ data: [{ domain_name: 'schoolmule.ca' }] });
    // Stripe takes a moment; the second request must wait for it rather than send the same request again.
    mockClient.createCheckoutSession.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(embeddedSession()), 150)));
    mockClient.retrieveCheckoutSession.mockResolvedValue(embeddedSession());
    const [a, b] = await Promise.all([
      publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, { ui: 'embedded' }),
      publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, { ui: 'embedded' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.clientSecret).toBe('cs_emb_1_secret_abc');
    expect(b.body.data.clientSecret).toBe('cs_emb_1_secret_abc');
    expect(mockClient.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('Stripe returns the family to their link, which records the payment as before', async () => {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids, { payment: { itemIds: ['lunch'], method: 'card', ui: 'embedded' } });
    const c = await charge();
    mockClient.retrieveCheckoutSession.mockResolvedValue(paidSession(c.charge_id, { id: 'cs_emb_1' }));
    const res = await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_emb_1`);
    expect(res.body.data.status).toBe('paid');
    expect(await payments(c.charge_id)).toHaveLength(1);
  });
});

describe('coming back from Stripe, and the webhook', () => {
  async function paidByCard() {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids);
    const c = await charge();
    mockClient.retrieveCheckoutSession.mockResolvedValue(paidSession(c.charge_id));
    return { ids, c };
  }

  it('the return page records the payment at once, with the card and the fee, and a receipt is queued', async () => {
    const { c } = await paidByCard();
    const res = await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      formTitle: 'Grade 5 Field Trip', amountCents: 3100, amountPaidCents: 3100, balanceCents: 0, status: 'paid',
      card: { brand: 'visa', last4: '4242', wallet: null }, canPayOnline: false, testMode: true,
    });
    expect(res.body.data.lines.map((l) => l.label)).toEqual(['Trip fee', 'Pizza lunch']);
    const [p] = await payments(c.charge_id);
    expect(p).toMatchObject({ kind: 'card', amount_cents: 3100, status: 'succeeded', stripe_payment_intent_id: 'pi_cs_test_1', stripe_charge_id: 'ch_cs_test_1', card_last4: '4242', stripe_fee_cents: 120 });
    expect((await charge()).checkout_session_id).toBeNull();
    expect(await outbox()).toEqual([expect.objectContaining({ kind: 'payment_receipt', recipient_email: 'sara@example.com', dedupe_key: `receipt:${p.payment_id}` })]);
  });

  it('records it once however many times Stripe and the family report it', async () => {
    const { c } = await paidByCard();
    await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    const evt = { id: 'evt_done_1', type: 'checkout.session.completed', livemode: false, account: ACCT, created: 1795730000, data: { object: { id: 'cs_test_1' } } };
    const raw = JSON.stringify(evt);
    for (let i = 0; i < 2; i += 1) {
      await request(getApp()).post('/api/payments/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', sign({ rawBody: raw, secret: SECRET })).send(raw);
    }
    await worker.drainAll({ client: mockClient });
    await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    expect(await payments(c.charge_id)).toHaveLength(1);
    expect((await outbox()).filter((e) => e.kind === 'payment_receipt')).toHaveLength(1);
  });

  it('the webhook alone records a payment whose family closed the tab', async () => {
    const { c } = await paidByCard();
    const evt = { id: 'evt_done_2', type: 'checkout.session.completed', livemode: false, account: ACCT, created: 1795730000, data: { object: { id: 'cs_test_1' } } };
    const raw = JSON.stringify(evt);
    const res = await request(getApp()).post('/api/payments/stripe/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', sign({ rawBody: raw, secret: SECRET })).send(raw);
    expect(res.body).toEqual({ received: true, kept: true });
    await worker.drainAll({ client: mockClient });
    expect((await charge()).status).toBe('paid');
  });

  it('ignores a session from another school’s Stripe account', async () => {
    const { c } = await paidByCard();
    await pool().query(`INSERT INTO payment_accounts (school, livemode, stripe_account_id, status) VALUES ('PLAYGROUND', false, 'acct_1Other', 'active')`);
    const evt = { id: 'evt_other', type: 'checkout.session.completed', livemode: false, account: 'acct_1Other', created: 1795730000, data: { object: { id: 'cs_test_1' } } };
    await pool().query(`INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id, object_id) VALUES ($1, false, $2, $3, 'cs_test_1')`, [evt.id, evt.type, evt.account]);
    await worker.drainAll({ client: mockClient });
    expect((await charge()).status).toBe('unpaid');
    expect(await payments(c.charge_id)).toHaveLength(0);
  });

  it('an abandoned page that expires sends the family one email with a link to finish', async () => {
    const ids = await seedForm();
    await connectSchool();
    await submitCard(ids);
    const c = await charge();
    mockClient.retrieveCheckoutSession.mockResolvedValue(session({ status: 'expired', client_reference_id: c.charge_id }));
    for (const id of ['evt_exp_1', 'evt_exp_2']) {
      await pool().query(`INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id, object_id) VALUES ($1, false, 'checkout.session.expired', $2, 'cs_test_1')`, [id, ACCT]);
    }
    await worker.drainAll({ client: mockClient });
    expect((await charge()).checkout_session_id).toBeNull();
    const links = (await outbox()).filter((e) => e.kind === 'payment_link');
    expect(links).toEqual([expect.objectContaining({ recipient_email: 'sara@example.com', dedupe_key: `link:auto:${c.charge_id}` })]);
  });

  it('a refund made in the school’s Stripe Dashboard shows up here', async () => {
    const { c } = await paidByCard();
    await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    mockClient.listRefunds.mockResolvedValueOnce({ data: [{ id: 're_dash_1', amount: 600, status: 'succeeded', charge: 'ch_cs_test_1' }] });
    await pool().query(`INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id, object_id) VALUES ('evt_ref_1', false, 'charge.refunded', $1, 'ch_cs_test_1')`, [ACCT]);
    await worker.drainAll({ client: mockClient });
    expect(mockClient.listRefunds).toHaveBeenCalledWith(ACCT, 'pi_cs_test_1');
    expect(await charge()).toMatchObject({ status: 'partially_refunded', amount_refunded_cents: 600 });
    expect((await outbox()).map((e) => e.kind)).toEqual(['payment_receipt', 'payment_refund']);
  });

  it('a dispute is flagged on the charge', async () => {
    const { c } = await paidByCard();
    await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    mockClient.retrieveDispute.mockResolvedValueOnce({ id: 'du_1', status: 'needs_response', payment_intent: 'pi_cs_test_1' });
    await pool().query(`INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id, object_id) VALUES ('evt_du_1', false, 'charge.dispute.created', $1, 'du_1')`, [ACCT]);
    await worker.drainAll({ client: mockClient });
    expect((await charge()).dispute_status).toBe('needs_response');
  });

  it('fills in the Stripe fee once Stripe has worked it out', async () => {
    const { c } = await paidByCard();
    const noFee = paidSession(c.charge_id);
    noFee.payment_intent.latest_charge.balance_transaction = 'txn_not_ready';
    mockClient.retrieveCheckoutSession.mockResolvedValueOnce(noFee);
    await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    expect((await payments(c.charge_id))[0].stripe_fee_cents).toBeNull();

    mockClient.retrievePaymentIntent = jest.fn().mockResolvedValueOnce(paidSession(c.charge_id).payment_intent);
    const charges = require('../../../services/payments/charges');
    expect(await charges.fillMissingFees({ client: mockClient })).toBe(1);
    expect((await payments(c.charge_id))[0].stripe_fee_cents).toBe(120);
  });

  it('the safety net finds a payment whose webhook never came', async () => {
    await paidByCard();
    await pool().query(`UPDATE charges SET updated_at = now() - interval '20 minutes'`);
    expect(await worker.checkStaleCheckouts({ client: mockClient })).toBe(1);
    expect((await charge()).status).toBe('paid');
  });

  it('an unknown link is a 404 and never reaches Stripe', async () => {
    expect((await publicGet('/api/registration/public/payments/not-a-token')).status).toBe(404);
    expect((await publicGet('/api/registration/public/payments/9b2c8a4e-1f3d-4c5b-8a6e-2d7f9e1c3b5a')).status).toBe(404);
    expect(mockClient.retrieveCheckoutSession).not.toHaveBeenCalled();
  });
});

describe('the office', () => {
  async function unpaidCharge({ createdBy = ADMIN_ID } = {}) {
    const ids = await seedForm({ createdBy });
    await connectSchool();
    await submitCard(ids);
    return { ids, c: await charge() };
  }

  it('sees the payment on each response, and can filter by it', async () => {
    const { ids, c } = await unpaidCharge();
    let res = await authenticatedRequest('get', `/api/registration/forms/${ids.formId}/submissions`);
    expect(res.body.data[0].payment).toMatchObject({ chargeId: c.charge_id, status: 'unpaid', amountCents: 3100, chosenMethod: 'card' });
    res = await authenticatedRequest('get', `/api/registration/forms/${ids.formId}/submissions?payment=paid`);
    expect(res.body.data).toHaveLength(0);
    res = await authenticatedRequest('get', `/api/registration/forms/${ids.formId}/submissions?payment=open`);
    expect(res.body.data).toHaveLength(1);
  });

  it('records cash in parts, then the rest, with a receipt each time', async () => {
    const { c } = await unpaidCharge();
    let res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash', amountCents: 1000, note: 'Envelope 12' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'partially_paid', amountPaidCents: 1000, balanceCents: 2100 });
    expect(res.body.data.payments[0]).toMatchObject({ kind: 'cash', amountCents: 1000, note: 'Envelope 12', recordedByName: 'Test ADMIN' });

    res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cheque', amountCents: 9999 });
    expect(res.status).toBe(400);
    res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cheque' });
    expect(res.body.data).toMatchObject({ status: 'paid', balanceCents: 0 });
    // Settled at the office: the family's open Stripe page is closed.
    expect(mockClient.expireCheckoutSession).toHaveBeenCalledWith(ACCT, 'cs_test_1');
    expect((await outbox()).filter((e) => e.kind === 'payment_receipt')).toHaveLength(2);

    res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash' });
    expect(res.status).toBe(409);
  });

  it('waives a fee privately, and can undo it', async () => {
    const { c } = await unpaidCharge({ createdBy: TEACHER_ID });
    let res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/waive`).send({ note: 'Bursary' });
    expect(res.body.data.status).toBe('waived');

    // The teacher who owns the form sees it as settled, with no note.
    const list = await authenticatedRequest('get', `/api/registration/forms/${c.form_id}/submissions`, TEACHER);
    expect(list.status).toBe(200);
    expect(list.body.data[0].payment.status).toBe('settled');
    expect(JSON.stringify(list.body)).not.toMatch(/Bursary|waive/i);

    const waiver = res.body.data.payments.find((p) => p.kind === 'waiver');
    res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/payments/${waiver.paymentId}/void`).send({});
    expect(res.body.data.status).toBe('unpaid');
  });

  it('keeps the money actions to holders of finance', async () => {
    const { c } = await unpaidCharge({ createdBy: TEACHER_ID });
    const res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`, TEACHER).send({ kind: 'cash' });
    expect(res.status).toBe(403);
  });

  it('refunds part of a card payment on the school’s account', async () => {
    const { c } = await unpaidCharge();
    mockClient.retrieveCheckoutSession.mockResolvedValue(paidSession(c.charge_id));
    await publicGet(`/api/registration/public/payments/${c.public_token}?session_id=cs_test_1`);
    mockClient.createRefund.mockResolvedValueOnce({ id: 're_1', amount: 600, status: 'succeeded', charge: 'ch_cs_test_1' });

    let res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/refund`).send({ amountCents: 99999 });
    expect(res.status).toBe(400);
    res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/refund`).send({ amountCents: 600, note: 'No lunch' });
    expect(res.status).toBe(200);
    expect(mockClient.createRefund).toHaveBeenCalledWith(ACCT, { paymentIntentId: 'pi_cs_test_1', amount: 600, metadata: { charge_id: c.charge_id } }, { idempotencyKey: `schoolmule-refund-${c.charge_id}-1-600` });
    expect(res.body.data).toMatchObject({ status: 'partially_refunded', amountRefundedCents: 600, refundableCents: 2500 });

    // Stripe's webhook about the same refund changes nothing.
    mockClient.listRefunds.mockResolvedValueOnce({ data: [{ id: 're_1', amount: 600, status: 'succeeded', charge: 'ch_cs_test_1' }] });
    await pool().query(`INSERT INTO stripe_events (event_id, livemode, type, stripe_account_id, object_id) VALUES ('evt_ref_2', false, 'charge.refunded', $1, 'ch_cs_test_1')`, [ACCT]);
    await worker.drainAll({ client: mockClient });
    expect((await payments(c.charge_id)).filter((p) => p.kind === 'refund')).toHaveLength(1);
    expect((await outbox()).filter((e) => e.kind === 'payment_refund')).toHaveLength(1);

    // Cash can't be refunded through Stripe.
    const cashOnly = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/payments/${res.body.data.payments[0].paymentId}/void`).send({});
    expect(cashOnly.status).toBe(409);
  });

  it('emails the family a link to pay', async () => {
    const { c } = await unpaidCharge();
    const res = await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/send-link`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.linkSentAt).toBeTruthy();
    expect((await outbox()).map((e) => e.kind)).toEqual(['payment_link']);
  });

  it('keeps a response with a payment from being deleted, but lets an untouched one go', async () => {
    const { c } = await unpaidCharge();
    await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash' });
    let res = await authenticatedRequest('delete', `/api/registration/submissions/${c.submission_id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUBMISSION_HAS_PAYMENT');

    await submitCard({ ...(await pool().query('SELECT field_id, field_type FROM registration_form_fields')).rows.reduce((m, f) => ({ ...m, [f.field_type === 'text' ? 'name' : f.field_type]: f.field_id }), {}) });
    const fresh = await charge();
    res = await authenticatedRequest('delete', `/api/registration/submissions/${fresh.submission_id}`);
    expect(res.status).toBe(200);
    expect((await pool().query('SELECT 1 FROM charges WHERE charge_id = $1', [fresh.charge_id])).rows).toHaveLength(0);
  });

  it('won’t delete a form that took payments', async () => {
    const { ids } = await unpaidCharge();
    await pool().query(`UPDATE registration_forms SET status = 'draft'`);
    const res = await authenticatedRequest('delete', `/api/registration/forms/${ids.formId}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FORM_HAS_PAYMENTS');
  });

  it('keeps the payment summary when someone edits a response’s answers', async () => {
    const { ids, c } = await unpaidCharge();
    const res = await authenticatedRequest('patch', `/api/registration/submissions/${c.submission_id}/answers`).send({
      answers: { [ids.name]: 'Aisha Khan', [ids.email]: 'sara@example.com', [ids.payment]: 'Total $0.00' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.answers[ids.payment]).toMatch(/Total \$31\.00/);
    expect(res.body.data.payment.status).toBe('unpaid');
  });

  it('exports the payment columns', async () => {
    const { ids, c } = await unpaidCharge();
    await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash' });
    const res = await authenticatedRequest('get', `/api/registration/forms/${ids.formId}/submissions/export`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Payment,Amount,Paid,Refunded,Paid with/);
    expect(res.text).toMatch(/Paid,\$31\.00,\$31\.00,,Cash/);
  });

  it('lists the school’s payments with a summary, and exports them', async () => {
    const { c } = await unpaidCharge();
    let res = await authenticatedRequest('get', '/api/payments/summary');
    expect(res.body.data).toMatchObject({ outstandingCents: 3100, outstandingCount: 1, collectedThisMonthCents: 0 });
    await authenticatedRequest('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash' });
    res = await authenticatedRequest('get', '/api/payments/summary');
    expect(res.body.data).toMatchObject({ outstandingCents: 0, collectedThisMonthCents: 3100 });

    res = await authenticatedRequest('get', '/api/payments/charges?status=paid');
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ formTitle: 'Grade 5 Field Trip', status: 'paid', lastPayment: { kind: 'cash' } });
    res = await authenticatedRequest('get', '/api/payments/charges?status=open');
    expect(res.body.data).toHaveLength(0);
    res = await authenticatedRequest('get', '/api/payments/charges?q=sara');
    expect(res.body.data).toHaveLength(1);

    res = await authenticatedRequest('get', '/api/payments/charges.csv');
    expect(res.text).toMatch(/Grade 5 Field Trip,,,sara@example\.com,Paid,\$31\.00/);
  });

  it('shows the school’s payouts and balance from Stripe', async () => {
    await connectSchool();
    mockClient.listPayouts.mockResolvedValueOnce({ data: [{ id: 'po_1', amount: 2980, currency: 'cad', status: 'paid', arrival_date: 1795800000, created: 1795700000, automatic: true }] });
    mockClient.retrieveBalance.mockResolvedValueOnce({ available: [{ amount: 500, currency: 'cad' }], pending: [{ amount: 2400, currency: 'cad' }] });
    const res = await authenticatedRequest('get', '/api/payments/payouts');
    expect(res.body.data.payouts[0]).toMatchObject({ payoutId: 'po_1', amountCents: 2980, status: 'paid' });
    expect(res.body.data.balance).toEqual({ availableCents: 500, pendingCents: 2400 });
  });
});
