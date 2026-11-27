// Tax on payments, against the real schema: the school's rates and tax number
// (Finance → Payments → Settings), taxed items on a form (added on top or
// included in the price), Stripe's line items, the family's link, the emails,
// payment requests with tax, and the ledger's filter, export and tiles.
// Stripe itself is a fake client.
const mockClient = {
  mode: 'test',
  livemode: false,
  createCheckoutSession: jest.fn(),
  retrieveCheckoutSession: jest.fn(),
  expireCheckoutSession: jest.fn(),
  createRefund: jest.fn(),
  listRefunds: jest.fn(),
  listPaymentMethodDomains: jest.fn(),
  createPaymentMethodDomain: jest.fn(),
  request: jest.fn(),
};

jest.mock('../../../services/payments/stripeClient', () => {
  const actual = jest.requireActual('../../../services/payments/stripeClient');
  return { ...actual, clientFromEnv: jest.fn(() => mockClient) };
});

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const emails = require('../../../services/payments/emails');

const SCHOOL = 'ALHAADIACADEMY';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440001', username: 'Teacher User', email: 'teacher@test.com', role: 'TEACHER' };
const PARENT_ID = '660e8400-e29b-41d4-a716-446655440009';
const ACCT = 'acct_1MapleGrove';
const NO_RATE = 'Choose a tax rate from your school’s list';

const pool = () => getTestPool();
let ip = 0;
const publicPost = (url, body) => request(getApp()).post(url).set('X-Forwarded-For', `203.0.113.${(ip += 1) % 250}`).send(body);
const publicGet = (url) => request(getApp()).get(url).set('X-Forwarded-For', `198.51.100.${(ip += 1) % 250}`);
const admin = (method, url) => authenticatedRequest(method, url);

async function seedUsers() {
  for (const [id, email, role] of [[ADMIN_ID, 'admin@test.com', 'ADMIN'], [TEACHER.userId, 'teacher@test.com', 'TEACHER'], [PARENT_ID, 'parent@test.com', 'PARENT']]) {
    await pool().query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Test', $4, $5, $6, true, true) ON CONFLICT (user_id) DO NOTHING`,
      [id, email, email, role, SCHOOL, role],
    );
  }
}

const connectSchool = () => pool().query(
  `INSERT INTO payment_accounts (school, livemode, stripe_account_id, status, card_payments_status) VALUES ($1, false, $2, 'active', 'active')`,
  [SCHOOL, ACCT],
);

/** Adds a rate through the API; returns its id. */
async function addRate(name, percent) {
  const res = await admin('post', '/api/payments/tax-rates').send({ name, percent });
  expect(res.status).toBe(201);
  return res.body.data.taxRates.find((r) => r.name === name && !r.archived).taxRateId;
}

const items = (hst, { pinTax = null } = {}) => [
  { id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, taxRateId: hst },
  { id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false, taxRateId: hst },
  { id: 'pin', label: 'Pin', amountCents: 300, required: false, taxRateId: pinTax },
];

/** A published form with name, email and a payment field (stored as the builder saves it). */
async function seedForm(payment) {
  await pool().query(`UPDATE schools SET slug = 'maple', email = 'office@maple.example' WHERE school_code = $1`, [SCHOOL]);
  await pool().query(
    `INSERT INTO registration_statuses (school, key, label, is_builtin, is_default) VALUES ($1, 'new', 'New', true, true) ON CONFLICT DO NOTHING`,
    [SCHOOL],
  );
  const { rows: [form] } = await pool().query(
    `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ($1, 'Grade 5 Field Trip', 'trip', 'published', $2) RETURNING form_id`,
    [SCHOOL, ADMIN_ID],
  );
  const field = async (type, label, order, config = null) => (await pool().query(
    `INSERT INTO registration_form_fields (form_id, field_type, label, is_required, sort_order, payment_config) VALUES ($1, $2, $3, $4, $5, $6) RETURNING field_id`,
    [form.form_id, type, label, type !== 'payment', order, config ? JSON.stringify({ allowOffline: true, currency: 'cad', ...config }) : null],
  )).rows[0].field_id;
  return {
    formId: form.form_id,
    name: await field('text', 'Student name', 0),
    email: await field('email', 'Parent email', 1),
    payment: await field('payment', 'Payment', 2, payment),
  };
}

const answers = (ids) => ({ [ids.name]: 'Aisha K.', [ids.email]: 'sara@example.com' });
const submit = (ids, payment) => publicPost('/api/registration/public/maple/trip/submit', { answers: answers(ids), payment });
const lastCharge = async () => (await pool().query('SELECT * FROM charges ORDER BY created_at DESC LIMIT 1')).rows[0];
const linesOf = async (chargeId) => (await pool().query(
  'SELECT label, amount_cents, tax_cents, tax_name, tax_rate_milli, tax_included FROM charge_lines WHERE charge_id = $1 ORDER BY sort_order', [chargeId],
)).rows;
const job = async (kind) => (await pool().query('SELECT * FROM email_outbox WHERE kind = $1 ORDER BY created_at DESC LIMIT 1', [kind])).rows[0];
/** A row of an email's facts table: the label cell, then the value cell. */
const factRow = (label, value) => new RegExp(`${label.replace(/[()$.]/g, '\\$&')}</td>\\s*<td[^>]*>${value.replace(/[()$.]/g, '\\$&')}</td>`);

const session = (over = {}) => ({
  id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1', status: 'open', payment_status: 'unpaid',
  expires_at: Math.floor(Date.now() / 1000) + 3600, ...over,
});
const paidSession = (chargeId, amount, id = 'cs_test_1') => session({
  id, status: 'complete', payment_status: 'paid', amount_total: amount, client_reference_id: chargeId, metadata: { charge_id: chargeId },
  payment_intent: { id: `pi_${id}`, latest_charge: { id: `ch_${id}`, payment_method_details: { card: { brand: 'visa', last4: '4242' } }, balance_transaction: { fee: 120 } } },
});

beforeEach(async () => {
  Object.values(mockClient).forEach((fn) => typeof fn === 'function' && fn.mockReset && fn.mockReset());
  mockClient.createCheckoutSession.mockResolvedValue(session());
  mockClient.expireCheckoutSession.mockResolvedValue({});
  await seedUsers();
});

describe('tax settings', () => {
  it('starts empty, and is for holders of finance only', async () => {
    let res = await admin('get', '/api/payments/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', data: { taxNumber: null, taxRates: [] } });
    for (const [method, url] of [['get', '/api/payments/settings'], ['put', '/api/payments/settings'], ['post', '/api/payments/tax-rates'], ['patch', `/api/payments/tax-rates/${ADMIN_ID}`], ['delete', `/api/payments/tax-rates/${ADMIN_ID}`]]) {
      res = await authenticatedRequest(method, url, TEACHER).send({ name: 'HST', percent: 13, taxNumber: 'x' });
      expect(res.status).toBe(403);
    }
    expect((await pool().query('SELECT 1 FROM tax_rates')).rowCount).toBe(0);
  });

  it('adds, edits and removes rates; removed ones are kept, after the live ones', async () => {
    let res = await admin('post', '/api/payments/tax-rates').send({ name: ' HST ', percent: '13' });
    expect(res.status).toBe(201);
    expect(res.body.data.taxRates).toEqual([{ taxRateId: expect.any(String), name: 'HST', rateMilli: 13000, archived: false }]);
    const hst = res.body.data.taxRates[0].taxRateId;

    res = await admin('post', '/api/payments/tax-rates').send({ name: 'QST', percent: 9.975 });
    expect(res.body.data.taxRates.map((r) => [r.name, r.rateMilli])).toEqual([['HST', 13000], ['QST', 9975]]);
    const qst = res.body.data.taxRates[1].taxRateId;
    res = await admin('post', '/api/payments/tax-rates').send({ name: 'GST', percent: '5%' });
    expect(res.body.data.taxRates.map((r) => r.name)).toEqual(['GST', 'HST', 'QST']);

    res = await admin('patch', `/api/payments/tax-rates/${qst}`).send({ percent: '9.5' });
    expect(res.status).toBe(200);
    expect(res.body.data.taxRates.find((r) => r.taxRateId === qst)).toEqual({ taxRateId: qst, name: 'QST', rateMilli: 9500, archived: false });
    res = await admin('patch', `/api/payments/tax-rates/${qst}`).send({ name: 'PST' });
    expect(res.body.data.taxRates.find((r) => r.taxRateId === qst)).toMatchObject({ name: 'PST', rateMilli: 9500 });

    res = await admin('delete', `/api/payments/tax-rates/${hst}`);
    expect(res.status).toBe(200);
    expect(res.body.data.taxRates).toEqual([
      expect.objectContaining({ name: 'GST', archived: false }),
      expect.objectContaining({ name: 'PST', archived: false }),
      { taxRateId: hst, name: 'HST', rateMilli: 13000, archived: true },
    ]);
    // Removing it again changes nothing; the row is never deleted.
    res = await admin('delete', `/api/payments/tax-rates/${hst}`);
    expect(res.status).toBe(200);
    expect((await pool().query('SELECT archived_at FROM tax_rates WHERE tax_rate_id = $1', [hst])).rows[0].archived_at).not.toBeNull();

    // With HST removed, a new HST is fine.
    res = await admin('post', '/api/payments/tax-rates').send({ name: 'hst', percent: 13 });
    expect(res.status).toBe(201);
    expect(res.body.data.taxRates.map((r) => `${r.name}${r.archived ? ' (removed)' : ''}`)).toEqual(['GST', 'hst', 'PST', 'HST (removed)']);
  });

  it('checks the percent, the name, a live name used twice, and the rate’s school', async () => {
    const hst = await addRate('HST', 13);
    for (const percent of [0, '0', -1, 100.5, '101', '9.9755', 'abc', '', null, undefined]) {
      const res = await admin('post', '/api/payments/tax-rates').send({ name: 'GST', percent });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'failed', message: 'Enter a rate between 0.001% and 100%' });
    }
    expect((await admin('post', '/api/payments/tax-rates').send({ name: 'Top', percent: 100 })).status).toBe(201);
    expect((await admin('post', '/api/payments/tax-rates').send({ name: 'Tiny', percent: '0.001' })).status).toBe(201);
    for (const name of ['', '   ', 'x'.repeat(31), null]) {
      expect((await admin('post', '/api/payments/tax-rates').send({ name, percent: 5 })).status).toBe(400);
    }
    expect((await admin('post', '/api/payments/tax-rates').send({ name: 'x'.repeat(30), percent: 5 })).status).toBe(201);

    let res = await admin('post', '/api/payments/tax-rates').send({ name: 'hst', percent: 5 });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('You already have a rate called HST');
    const gst = await addRate('GST', 5);
    res = await admin('patch', `/api/payments/tax-rates/${gst}`).send({ name: 'Hst' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('You already have a rate called HST');
    // Renaming a rate to its own name (another case) is fine.
    expect((await admin('patch', `/api/payments/tax-rates/${hst}`).send({ name: 'hst' })).status).toBe(200);
    expect((await admin('patch', `/api/payments/tax-rates/${hst}`).send({ percent: 0 })).status).toBe(400);

    const { rows: [other] } = await pool().query(`INSERT INTO tax_rates (school, name, rate_milli) VALUES ('PLAYGROUND', 'HST', 13000) RETURNING tax_rate_id`);
    for (const id of [other.tax_rate_id, '9b2c8a4e-1f3d-4c5b-8a6e-2d7f9e1c3b5a', 'not-an-id']) {
      expect((await admin('patch', `/api/payments/tax-rates/${id}`).send({ name: 'Mine' })).status).toBe(404);
      expect((await admin('delete', `/api/payments/tax-rates/${id}`)).status).toBe(404);
    }
    expect((await pool().query('SELECT name, archived_at FROM tax_rates WHERE tax_rate_id = $1', [other.tax_rate_id])).rows[0]).toEqual({ name: 'HST', archived_at: null });
  });

  it('keeps the tax number, trimmed, and clears it when emptied', async () => {
    let res = await admin('put', '/api/payments/settings').send({ taxNumber: '  12345 6789 RT0001 ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ taxNumber: '12345 6789 RT0001', taxRates: [] });
    expect((await admin('get', '/api/payments/settings')).body.data.taxNumber).toBe('12345 6789 RT0001');
    expect((await admin('put', '/api/payments/settings').send({ taxNumber: 'x'.repeat(61) })).status).toBe(400);
    expect((await admin('put', '/api/payments/settings').send({ taxNumber: 'x'.repeat(60) })).body.data.taxNumber).toHaveLength(60);
    res = await admin('put', '/api/payments/settings').send({ taxNumber: '   ' });
    expect(res.body.data.taxNumber).toBeNull();
  });
});

describe('a form with taxed items', () => {
  it('the builder saves a rate per item and the mode, and reads each item’s rate back', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: [{ id: 'old', label: 'Old', amountCents: 100, required: true }] });
    const save = (payment) => admin('put', `/api/registration/forms/${ids.formId}/fields`).send({
      fields: [
        { fieldId: ids.name, fieldType: 'text', label: 'Student name', isRequired: true },
        { fieldId: ids.email, fieldType: 'email', label: 'Parent email', isRequired: true },
        { fieldId: ids.payment, fieldType: 'payment', label: 'Payment', payment },
      ],
    });
    let res = await save({ items: items(hst), taxMode: 'included', allowOffline: true });
    expect(res.status).toBe(200);
    const pay = res.body.data.find((f) => f.fieldType === 'payment').payment;
    expect(pay.taxMode).toBe('included');
    expect(pay.items.map((i) => [i.id, i.taxRateId, i.tax])).toEqual([
      ['trip', hst, { name: 'HST', rateMilli: 13000, archived: false }],
      ['lunch', hst, { name: 'HST', rateMilli: 13000, archived: false }],
      ['pin', null, null],
    ]);
    const stored = (await pool().query('SELECT payment_config FROM registration_form_fields WHERE field_id = $1', [ids.payment])).rows[0].payment_config;
    expect(stored.items[0]).toEqual({ id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, taxRateId: hst });
    expect(stored.items[0].tax).toBeUndefined();

    // Any other mode reads as added.
    res = await save({ items: items(hst), taxMode: 'on top' });
    expect(res.body.data.find((f) => f.fieldType === 'payment').payment.taxMode).toBe('added');

    // The staff read of the form carries the same.
    const form = await admin('get', `/api/registration/forms/${ids.formId}`);
    expect(form.body.data.fields.find((f) => f.fieldType === 'payment').payment.items[0].tax).toEqual({ name: 'HST', rateMilli: 13000, archived: false });
  });

  it('refuses a rate that isn’t the school’s, or a removed one the field didn’t have; a removed one it had stays', async () => {
    const hst = await addRate('HST', 13);
    const gst = await addRate('GST', 5);
    const ids = await seedForm({ items: items(hst) });
    const save = (payment) => admin('put', `/api/registration/forms/${ids.formId}/fields`).send({
      fields: [
        { fieldId: ids.email, fieldType: 'email', label: 'Parent email', isRequired: true },
        { fieldId: ids.payment, fieldType: 'payment', label: 'Payment', payment },
      ],
    });
    const { rows: [other] } = await pool().query(`INSERT INTO tax_rates (school, name, rate_milli) VALUES ('PLAYGROUND', 'HST', 13000) RETURNING tax_rate_id`);
    for (const bad of [other.tax_rate_id, '9b2c8a4e-1f3d-4c5b-8a6e-2d7f9e1c3b5a', 'nonsense']) {
      const res = await save({ items: items(bad) });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(NO_RATE);
    }
    await admin('delete', `/api/payments/tax-rates/${hst}`);
    await admin('delete', `/api/payments/tax-rates/${gst}`);
    // HST was on this field before it was removed: it may stay, flagged for the builder.
    let res = await save({ items: items(hst) });
    expect(res.status).toBe(200);
    expect(res.body.data.find((f) => f.fieldType === 'payment').payment.items[0].tax).toEqual({ name: 'HST', rateMilli: 13000, archived: true });
    // GST was never on it.
    res = await save({ items: items(hst, { pinTax: gst }) });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(NO_RATE);
  });

  it('limits the typed price to $10,000 and the total with tax to $20,000', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(null) });
    const save = (payment) => admin('put', `/api/registration/forms/${ids.formId}/fields`).send({
      fields: [{ fieldId: ids.payment, fieldType: 'payment', label: 'Payment', payment }],
    });
    const big = [
      { id: 'a', label: 'Tuition A', amountCents: 900000, required: true, taxRateId: hst },
      { id: 'b', label: 'Tuition B', amountCents: 900000, required: false, taxRateId: hst },
    ];
    let res = await save({ items: big });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/with tax, can come to at most \$20,000\.00/);
    res = await save({ items: big, taxMode: 'included' });
    expect(res.status).toBe(200);
  });

  it('tells the builder the school’s live rates; anyone who builds forms may read them', async () => {
    const hst = await addRate('HST', 13);
    const gst = await addRate('GST', 5);
    await addRate('Old', 7);
    const old = (await admin('get', '/api/payments/settings')).body.data.taxRates.find((r) => r.name === 'Old').taxRateId;
    await admin('delete', `/api/payments/tax-rates/${old}`);
    const res = await authenticatedRequest('get', '/api/registration/payment-availability', TEACHER);
    expect(res.status).toBe(200);
    expect(res.body.data.taxRates).toEqual([{ taxRateId: gst, name: 'GST', rateMilli: 5000 }, { taxRateId: hst, name: 'HST', rateMilli: 13000 }]);
  });

  it('shows each item’s tax to the family, never a rate id', async () => {
    const hst = await addRate('HST', 13);
    await seedForm({ items: items(hst), taxMode: 'included', accountingCode: '4210' });
    const res = await publicGet('/api/registration/public/maple/trip');
    expect(res.status).toBe(200);
    const pay = res.body.data.fields.find((f) => f.fieldType === 'payment').payment;
    expect(pay.taxMode).toBe('included');
    expect(pay.items).toEqual([
      { id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, tax: { name: 'HST', rateMilli: 13000 } },
      { id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false, tax: { name: 'HST', rateMilli: 13000 } },
      { id: 'pin', label: 'Pin', amountCents: 300, required: false, tax: null },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(hst);
    expect(pay.accountingCode).toBeUndefined();
  });

  it('tax added on top: the totals, the lines, the stored answer, and its own line on Stripe’s page', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst) });
    await connectSchool();
    const res = await submit(ids, { itemIds: ['lunch', 'pin'], method: 'card' });
    expect(res.status).toBe(201);
    expect(res.body.data.payment).toMatchObject({ method: 'card', totalCents: 3803, taxCents: 403 });

    const c = await lastCharge();
    expect(c).toMatchObject({ amount_cents: 3803, tax_cents: 403 });
    expect(await linesOf(c.charge_id)).toEqual([
      { label: 'Trip fee', amount_cents: 2500, tax_cents: 325, tax_name: 'HST', tax_rate_milli: 13000, tax_included: false },
      { label: 'Pizza lunch', amount_cents: 600, tax_cents: 78, tax_name: 'HST', tax_rate_milli: 13000, tax_included: false },
      { label: 'Pin', amount_cents: 300, tax_cents: 0, tax_name: null, tax_rate_milli: null, tax_included: false },
    ]);
    const { rows: [sub] } = await pool().query('SELECT answers FROM registration_form_submissions WHERE submission_id = $1', [c.submission_id]);
    expect(sub.answers[ids.payment]).toBe('Trip fee $25.00, Pizza lunch $6.00, Pin $3.00 + HST $4.03 = $38.03 (paying online)');

    const params = mockClient.createCheckoutSession.mock.calls[0][1];
    expect(params.line_items).toEqual([
      { price_data: { currency: 'cad', unit_amount: 2500, product_data: { name: 'Trip fee' } }, quantity: 1 },
      { price_data: { currency: 'cad', unit_amount: 600, product_data: { name: 'Pizza lunch' } }, quantity: 1 },
      { price_data: { currency: 'cad', unit_amount: 300, product_data: { name: 'Pin' } }, quantity: 1 },
      { price_data: { currency: 'cad', unit_amount: 403, product_data: { name: 'HST (13%)' } }, quantity: 1 },
    ]);
    expect(params.line_items.reduce((s, l) => s + l.price_data.unit_amount, 0)).toBe(3803);
  });

  it('tax included in the price: the family pays the prices, and Stripe gets no tax line', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst), taxMode: 'included' });
    await connectSchool();
    const res = await submit(ids, { itemIds: ['lunch'], method: 'card' });
    expect(res.body.data.payment).toMatchObject({ totalCents: 3100, taxCents: 357 });
    const c = await lastCharge();
    expect(c).toMatchObject({ amount_cents: 3100, tax_cents: 357 });
    expect((await linesOf(c.charge_id)).map((l) => [l.amount_cents, l.tax_cents, l.tax_included])).toEqual([[2500, 288, true], [600, 69, true]]);
    const { rows: [sub] } = await pool().query('SELECT answers FROM registration_form_submissions WHERE submission_id = $1', [c.submission_id]);
    expect(sub.answers[ids.payment]).toBe('Trip fee $25.00, Pizza lunch $6.00 = $31.00, includes $3.57 HST (paying online)');
    expect(mockClient.createCheckoutSession.mock.calls[0][1].line_items).toEqual([
      { price_data: { currency: 'cad', unit_amount: 2500, product_data: { name: 'Trip fee' } }, quantity: 1 },
      { price_data: { currency: 'cad', unit_amount: 600, product_data: { name: 'Pizza lunch' } }, quantity: 1 },
    ]);
  });

  it('two rates on one form are a line each, largest first', async () => {
    const hst = await addRate('HST', 13);
    const gst = await addRate('GST', 5);
    const ids = await seedForm({ items: items(hst, { pinTax: gst }) });
    await connectSchool();
    await submit(ids, { itemIds: ['pin'], method: 'card' });
    const tail = mockClient.createCheckoutSession.mock.calls[0][1].line_items.slice(-2).map((l) => [l.price_data.product_data.name, l.price_data.unit_amount]);
    expect(tail).toEqual([['HST (13%)', 325], ['GST (5%)', 15]]);
    const c = await lastCharge();
    const detail = await admin('get', `/api/payments/charges/${c.charge_id}`);
    expect(detail.body.data.taxSummary).toEqual([
      { name: 'HST', rateMilli: 13000, cents: 325, included: false },
      { name: 'GST', rateMilli: 5000, cents: 15, included: false },
    ]);
  });

  it('a part-paid charge goes to Stripe as one balance line, tax and all', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst) });
    await connectSchool();
    await submit(ids, { itemIds: ['lunch'], method: 'card', ui: 'embedded' });
    const c = await lastCharge();
    await admin('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash', amountCents: 1000, sendReceipt: false });
    const res = await publicPost(`/api/registration/public/payments/${c.public_token}/checkout`, {});
    expect(res.status).toBe(200);
    expect(mockClient.createCheckoutSession.mock.calls[0][1].line_items).toEqual([
      { price_data: { currency: 'cad', unit_amount: 2503, product_data: { name: 'Balance for Grade 5 Field Trip' } }, quantity: 1 },
    ]);
  });

  it('the family’s link and the office’s panel show the tax, the subtotal and the school’s tax number', async () => {
    const hst = await addRate('HST', 13);
    await admin('put', '/api/payments/settings').send({ taxNumber: '12345 6789 RT0001' });
    const ids = await seedForm({ items: items(hst) });
    await connectSchool();
    await submit(ids, { itemIds: ['lunch'], method: 'card', ui: 'embedded' });
    const c = await lastCharge();

    const view = (await publicGet(`/api/registration/public/payments/${c.public_token}`)).body.data;
    expect(view).toMatchObject({ amountCents: 3503, subtotalCents: 3100, taxCents: 403, taxNumber: '12345 6789 RT0001', balanceCents: 3503 });
    expect(view.taxSummary).toEqual([{ name: 'HST', rateMilli: 13000, cents: 403, included: false }]);
    expect(view.lines[0]).toMatchObject({ label: 'Trip fee', amountCents: 2500, taxCents: 325, taxName: 'HST', taxRateMilli: 13000, taxIncluded: false });

    const detail = (await admin('get', `/api/payments/charges/${c.charge_id}`)).body.data;
    expect(detail).toMatchObject({ amountCents: 3503, taxCents: 403, taxSummary: [{ name: 'HST', rateMilli: 13000, cents: 403, included: false }] });
    expect(detail.lines[1]).toMatchObject({ label: 'Pizza lunch', taxCents: 78, taxName: 'HST', taxRateMilli: 13000, taxIncluded: false });
    const list = (await admin('get', '/api/payments/charges')).body.data;
    expect(list[0]).toMatchObject({ taxCents: 403 });
  });

  it('an untaxed charge reads as before, with an empty summary', async () => {
    await admin('put', '/api/payments/settings').send({ taxNumber: '12345 6789 RT0001' });
    const ids = await seedForm({ items: items(null) });
    await submit(ids, { method: 'offline' });
    const c = await lastCharge();
    const view = (await publicGet(`/api/registration/public/payments/${c.public_token}`)).body.data;
    expect(view).toMatchObject({ amountCents: 2500, subtotalCents: 2500, taxCents: 0, taxSummary: [], taxNumber: '12345 6789 RT0001' });
    const detail = (await admin('get', `/api/payments/charges/${c.charge_id}`)).body.data;
    expect(detail).toMatchObject({ taxCents: 0, taxSummary: [] });
    expect(detail.lines[0]).toMatchObject({ taxCents: 0, taxName: null, taxRateMilli: null, taxIncluded: false });
  });
});

describe('the emails list the tax', () => {
  it('a receipt: a row per rate, the total, and the tax number', async () => {
    const hst = await addRate('HST', 13);
    await admin('put', '/api/payments/settings').send({ taxNumber: '12345 6789 RT0001' });
    const ids = await seedForm({ items: items(hst) });
    await submit(ids, { itemIds: ['lunch'], method: 'offline' });
    const c = await lastCharge();
    await admin('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash', amountCents: 1000 });
    const { message } = await emails.receiptHandler.build(await job('payment_receipt'));
    expect(message.html).toMatch(factRow('HST (13%)', '$4.03'));
    expect(message.html).toMatch(factRow('Total', '$35.03'));
    expect(message.html).toMatch(factRow('Paid', '$10.00'));
    expect(message.html).toMatch(factRow('Still owed', '$25.03'));
    expect(message.html).toMatch(factRow('Tax no.', '12345 6789 RT0001'));
    expect(message.html.indexOf('Pizza lunch')).toBeLessThan(message.html.indexOf('HST (13%)'));
    expect(message.html.indexOf('HST (13%)')).toBeLessThan(message.html.indexOf('>Total<'));
  });

  it('a receipt for tax included: one line, “Includes $3.57 HST”', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst), taxMode: 'included' });
    await submit(ids, { itemIds: ['lunch'], method: 'offline' });
    const c = await lastCharge();
    await admin('post', `/api/payments/charges/${c.charge_id}/offline`).send({ kind: 'cash' });
    const { message } = await emails.receiptHandler.build(await job('payment_receipt'));
    expect(message.html).toContain('Includes $3.57 HST');
    expect(message.html).not.toMatch(/HST \(13%\)/);
    expect(message.html).not.toMatch(/>Total</);
    // No tax number set: no row for it.
    expect(message.html).not.toMatch(/Tax no\./);
  });

  it('an untaxed receipt is as it was, tax number or not', async () => {
    await admin('put', '/api/payments/settings').send({ taxNumber: '12345 6789 RT0001' });
    const ids = await seedForm({ items: items(null) });
    await submit(ids, { method: 'offline' });
    await admin('post', `/api/payments/charges/${(await lastCharge()).charge_id}/offline`).send({ kind: 'cash' });
    const { message } = await emails.receiptHandler.build(await job('payment_receipt'));
    expect(message.html).toMatch(factRow('Paid', '$25.00'));
    expect(message.html).not.toMatch(/Tax no\.|>Total<|Includes|HST/);
  });

  it('a payment link email lists the tax before what is to pay', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst) });
    await connectSchool();
    await submit(ids, { itemIds: [], method: 'card', ui: 'embedded' });
    const c = await lastCharge();
    expect((await admin('post', `/api/payments/charges/${c.charge_id}/send-link`).send({})).status).toBe(200);
    const { message } = await emails.linkHandler.build(await job('payment_link'));
    expect(message.html).toMatch(factRow('HST (13%)', '$3.25'));
    expect(message.html).toMatch(factRow('To pay', '$28.25'));
    expect(message.html).not.toMatch(/>Total</);
  });
});

describe('a rate edited or removed after a payment', () => {
  it('leaves the old charge, its link and its receipt as they were; new responses use the rate as it is now', async () => {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst) });
    await submit(ids, { itemIds: ['lunch'], method: 'offline' });
    const first = await lastCharge();
    await admin('post', `/api/payments/charges/${first.charge_id}/offline`).send({ kind: 'cash' });

    await admin('patch', `/api/payments/tax-rates/${hst}`).send({ name: 'Sales tax', percent: 15 });
    let after = (await admin('get', `/api/payments/charges/${first.charge_id}`)).body.data;
    expect(after).toMatchObject({ amountCents: 3503, taxCents: 403, status: 'paid', taxSummary: [{ name: 'HST', rateMilli: 13000, cents: 403, included: false }] });
    const { message } = await emails.receiptHandler.build(await job('payment_receipt'));
    expect(message.html).toMatch(factRow('HST (13%)', '$4.03'));

    // A new response on the same form is priced at the rate as it stands now.
    await submit(ids, { itemIds: [], method: 'offline' });
    const second = await lastCharge();
    expect(second).toMatchObject({ amount_cents: 2875, tax_cents: 375 });
    expect((await linesOf(second.charge_id))[0]).toMatchObject({ tax_name: 'Sales tax', tax_rate_milli: 15000 });

    // Removed: the form keeps it, and the first charge still doesn't change.
    await admin('delete', `/api/payments/tax-rates/${hst}`);
    after = (await admin('get', `/api/payments/charges/${first.charge_id}`)).body.data;
    expect(after.taxSummary).toEqual([{ name: 'HST', rateMilli: 13000, cents: 403, included: false }]);
    const view = (await publicGet(`/api/registration/public/payments/${first.public_token}`)).body.data;
    expect(view).toMatchObject({ amountCents: 3503, taxCents: 403 });
    await submit(ids, { itemIds: [], method: 'offline' });
    expect(await lastCharge()).toMatchObject({ amount_cents: 2875, tax_cents: 375 });
  });
});

describe('payment requests with tax', () => {
  const yearId = async () => (await pool().query('SELECT school_year_id FROM school_years WHERE school = $1 AND is_active', [SCHOOL])).rows[0].school_year_id;
  async function seedStudents() {
    const year = await yearId();
    const add = async (name, grade, mother) => (await pool().query(
      'INSERT INTO students (name, school, grade, mother_email, school_year_id) VALUES ($1, $2, $3, $4, $5) RETURNING student_id',
      [name, SCHOOL, grade, mother, year],
    )).rows[0].student_id;
    return { aisha: await add('Aisha Khan', '5', 'mum.khan@example.com'), omar: await add('Omar Ali', '5', 'omar.mum@example.com'), yusuf: await add('Yusuf Rahman', '6', null) };
  }
  const create = (body) => admin('post', '/api/payments/requests').send({ title: 'Grade 5 museum trip', amountCents: 3500, grades: ['5'], ...body });
  const requestLines = async (requestId) => (await pool().query(
    `SELECT DISTINCT c.amount_cents AS owed, c.tax_cents AS charge_tax, l.amount_cents, l.tax_cents, l.tax_name, l.tax_rate_milli, l.tax_included
       FROM charges c JOIN charge_lines l ON l.charge_id = c.charge_id WHERE c.request_id = $1`, [requestId],
  )).rows;

  it('tax added on top: per student, each charge, the stats, Stripe’s lines and the email', async () => {
    const s = await seedStudents();
    const hst = await addRate('HST', 13);
    await connectSchool();
    const res = await create({ taxRateId: hst, taxMode: 'added' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      amountCents: 3500, taxRateId: hst, taxName: 'HST', taxRateMilli: 13000, taxArchived: false, taxMode: 'added',
      taxPerStudentCents: 455, totalPerStudentCents: 3955,
      stats: { students: 2, expectedCents: 7910, outstandingCents: 7910 },
    });
    expect(res.body.data.charges[0]).toMatchObject({ amountCents: 3955, taxCents: 455, balanceCents: 3955 });
    expect(await requestLines(res.body.data.requestId)).toEqual([
      { owed: 3955, charge_tax: 455, amount_cents: 3500, tax_cents: 455, tax_name: 'HST', tax_rate_milli: 13000, tax_included: false },
    ]);
    const list = (await admin('get', '/api/payments/requests')).body.data[0];
    expect(list).toMatchObject({ taxName: 'HST', totalPerStudentCents: 3955, stats: { expectedCents: 7910 } });

    const { rows: [mail] } = await pool().query(`SELECT * FROM email_outbox WHERE kind = 'payment_request' AND student_id = $1`, [s.aisha]);
    const { message } = await emails.requestHandler.build(mail);
    expect(message.html).toMatch(factRow('HST (13%)', '$4.55'));
    expect(message.html).toMatch(factRow('To pay', '$39.55'));

    const aisha = res.body.data.charges.find((c) => c.studentId === s.aisha);
    const { rows: [row] } = await pool().query('SELECT public_token FROM charges WHERE charge_id = $1', [aisha.chargeId]);
    await publicPost(`/api/registration/public/payments/${row.public_token}/checkout`, {});
    expect(mockClient.createCheckoutSession.mock.calls[0][1].line_items).toEqual([
      { price_data: { currency: 'cad', unit_amount: 3500, product_data: { name: 'Grade 5 museum trip' } }, quantity: 1 },
      { price_data: { currency: 'cad', unit_amount: 455, product_data: { name: 'HST (13%)' } }, quantity: 1 },
    ]);
    const view = (await publicGet(`/api/registration/public/payments/${row.public_token}`)).body.data;
    expect(view).toMatchObject({ amountCents: 3955, subtotalCents: 3500, taxCents: 455, taxSummary: [{ name: 'HST', rateMilli: 13000, cents: 455, included: false }] });
  });

  it('tax included: the families pay the amount, the email says what tax is in it', async () => {
    const s = await seedStudents();
    const hst = await addRate('HST', 13);
    const res = await create({ taxRateId: hst, taxMode: 'included', allowOffline: true });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ amountCents: 3500, taxPerStudentCents: 403, totalPerStudentCents: 3500, taxMode: 'included', stats: { expectedCents: 7000 } });
    expect(await requestLines(res.body.data.requestId)).toEqual([
      { owed: 3500, charge_tax: 403, amount_cents: 3500, tax_cents: 403, tax_name: 'HST', tax_rate_milli: 13000, tax_included: true },
    ]);
    const { rows: [mail] } = await pool().query(`SELECT * FROM email_outbox WHERE kind = 'payment_request' AND student_id = $1`, [s.aisha]);
    const { message } = await emails.requestHandler.build(mail);
    expect(message.html).toContain('Includes $4.03 HST');
    expect(message.html).not.toMatch(/HST \(13%\)/);
  });

  it('an untaxed request answers with no tax, and its email is as it was', async () => {
    const s = await seedStudents();
    const res = await create({ allowOffline: true });
    expect(res.body.data).toMatchObject({
      amountCents: 3500, taxRateId: null, taxName: null, taxRateMilli: null, taxArchived: false, taxMode: 'added', taxPerStudentCents: 0, totalPerStudentCents: 3500,
    });
    const { rows: [mail] } = await pool().query(`SELECT * FROM email_outbox WHERE kind = 'payment_request' AND student_id = $1`, [s.aisha]);
    const { message } = await emails.requestHandler.build(mail);
    expect(message.html).not.toMatch(/HST|Includes|>Items</);
  });

  it('changing the tax rewrites every charge until someone pays; then it is refused', async () => {
    const s = await seedStudents();
    const hst = await addRate('HST', 13);
    const gst = await addRate('GST', 5);
    const res = await create({ allowOffline: true });
    const id = res.body.data.requestId;

    let edit = await admin('patch', `/api/payments/requests/${id}`).send({ taxRateId: hst });
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ taxName: 'HST', taxMode: 'added', totalPerStudentCents: 3955, stats: { expectedCents: 7910 } });
    expect((await requestLines(id))[0]).toMatchObject({ owed: 3955, tax_cents: 455, tax_included: false });

    edit = await admin('patch', `/api/payments/requests/${id}`).send({ taxMode: 'included' });
    expect(edit.body.data).toMatchObject({ taxMode: 'included', totalPerStudentCents: 3500, stats: { expectedCents: 7000 } });
    expect((await requestLines(id))[0]).toMatchObject({ owed: 3500, tax_cents: 403, tax_included: true });

    edit = await admin('patch', `/api/payments/requests/${id}`).send({ taxRateId: gst, amountCents: 4000, taxMode: 'added' });
    expect(edit.body.data).toMatchObject({ amountCents: 4000, taxName: 'GST', totalPerStudentCents: 4200 });
    expect(await requestLines(id)).toEqual([{ owed: 4200, charge_tax: 200, amount_cents: 4000, tax_cents: 200, tax_name: 'GST', tax_rate_milli: 5000, tax_included: false }]);

    // A rate that isn't the school's, or isn't a rate at all.
    const { rows: [other] } = await pool().query(`INSERT INTO tax_rates (school, name, rate_milli) VALUES ('PLAYGROUND', 'HST', 13000) RETURNING tax_rate_id`);
    for (const bad of [other.tax_rate_id, '9b2c8a4e-1f3d-4c5b-8a6e-2d7f9e1c3b5a', 'nope']) {
      const r = await admin('patch', `/api/payments/requests/${id}`).send({ taxRateId: bad });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(NO_RATE);
    }

    const aisha = edit.body.data.charges.find((c) => c.studentId === s.aisha);
    await admin('post', `/api/payments/charges/${aisha.chargeId}/offline`).send({ kind: 'cash', amountCents: 1000, sendReceipt: false });
    for (const body of [{ taxRateId: hst }, { taxRateId: null }, { taxMode: 'included' }]) {
      const r = await admin('patch', `/api/payments/requests/${id}`).send(body);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('HAS_PAYMENTS');
    }
    // Other edits still work, and leave what families owe alone.
    edit = await admin('patch', `/api/payments/requests/${id}`).send({ title: 'Museum trip', taxRateId: gst, taxMode: 'added' });
    expect(edit.status).toBe(200);
    expect(await requestLines(id)).toEqual([{ owed: 4200, charge_tax: 200, amount_cents: 4000, tax_cents: 200, tax_name: 'GST', tax_rate_milli: 5000, tax_included: false }]);
  });

  it('a request keeps a rate removed after it was chosen, and new students get it too; no other removed rate can be picked', async () => {
    const s = await seedStudents();
    const hst = await addRate('HST', 13);
    const old = await addRate('Old', 7);
    await admin('delete', `/api/payments/tax-rates/${old}`);
    let res = await create({ taxRateId: old, allowOffline: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(NO_RATE);

    res = await create({ taxRateId: hst, allowOffline: true });
    const id = res.body.data.requestId;
    await admin('delete', `/api/payments/tax-rates/${hst}`);
    let detail = (await admin('get', `/api/payments/requests/${id}`)).body.data;
    expect(detail).toMatchObject({ taxRateId: hst, taxName: 'HST', taxArchived: true, totalPerStudentCents: 3955 });
    expect((await admin('patch', `/api/payments/requests/${id}`).send({ title: 'Still HST', taxRateId: hst })).status).toBe(200);
    expect((await admin('patch', `/api/payments/requests/${id}`).send({ taxRateId: old })).status).toBe(400);

    const added = await admin('post', `/api/payments/requests/${id}/students`).send({ studentIds: [s.yusuf] });
    expect(added.body.data.result).toEqual({ added: 1 });
    detail = added.body.data;
    expect(detail.charges.find((c) => c.studentId === s.yusuf)).toMatchObject({ amountCents: 3955, taxCents: 455 });
    expect(detail.stats.expectedCents).toBe(3 * 3955);
  });
});

describe('the ledger: taxed or untaxed, the export, and the tax collected this month', () => {
  async function seedLedger() {
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ items: items(hst) });
    await connectSchool();
    // A taxed form charge ($35.03, $4.03 tax) and an untaxed one ($25.00).
    await submit(ids, { itemIds: ['lunch'], method: 'card', ui: 'embedded' });
    const taxed = await lastCharge();
    const ids2 = await seedForm2();
    await publicPost('/api/registration/public/maple/plain/submit', { answers: { [ids2.email]: 'dad@example.com' }, payment: { method: 'offline' } });
    const untaxed = await lastCharge();
    return { ids, taxed, untaxed };
  }
  async function seedForm2() {
    const { rows: [form] } = await pool().query(
      `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ($1, 'Book fee', 'plain', 'published', $2) RETURNING form_id`, [SCHOOL, ADMIN_ID],
    );
    const field = async (type, order, config = null) => (await pool().query(
      `INSERT INTO registration_form_fields (form_id, field_type, label, is_required, sort_order, payment_config) VALUES ($1, $2, $3, false, $4, $5) RETURNING field_id`,
      [form.form_id, type, type, order, config ? JSON.stringify(config) : null],
    )).rows[0].field_id;
    return { email: await field('email', 0), payment: await field('payment', 1, { items: [{ id: 'books', label: 'Books', amountCents: 2500, required: true }], allowOffline: true, currency: 'cad' }) };
  }

  it('filters by tax', async () => {
    const { taxed, untaxed } = await seedLedger();
    let res = await admin('get', '/api/payments/charges?tax=taxed');
    expect(res.body.data.map((c) => c.chargeId)).toEqual([taxed.charge_id]);
    expect(res.body.pagination.total).toBe(1);
    res = await admin('get', '/api/payments/charges?tax=untaxed');
    expect(res.body.data.map((c) => c.chargeId)).toEqual([untaxed.charge_id]);
    res = await admin('get', '/api/payments/charges?tax=whatever');
    expect(res.body.pagination.total).toBe(2);
  });

  it('exports a Tax column after Amount, and passes the filter', async () => {
    await seedLedger();
    let csv = (await admin('get', '/api/payments/charges.csv')).text.split('\n');
    expect(csv[0]).toMatch(/^Date,For,Student,Grade,Email,Status,Amount,Tax,Paid,Refunded,Still owed,Stripe fee,Paid with,Due,Accounting code,Reference/);
    expect(csv.find((l) => l.includes('Grade 5 Field Trip'))).toMatch(/,Unpaid,\$35\.03,\$4\.03,\$0\.00,,\$35\.03,/);
    expect(csv.find((l) => l.includes('Book fee'))).toMatch(/,Unpaid,\$25\.00,,\$0\.00,,\$25\.00,/);
    csv = (await admin('get', '/api/payments/charges.csv?tax=untaxed')).text;
    expect(csv).toMatch(/Book fee/);
    expect(csv).not.toMatch(/Grade 5 Field Trip/);
  });

  it('counts each payment’s share of its charge’s tax, less refunds, in the summary and the overview', async () => {
    const { taxed, untaxed } = await seedLedger();
    let res = await admin('get', '/api/payments/summary');
    expect(res.body.data.taxCollectedThisMonthCents).toBe(0);

    // Untaxed money carries no tax.
    await admin('post', `/api/payments/charges/${untaxed.charge_id}/offline`).send({ kind: 'cash', sendReceipt: false });
    // A part payment of $10.00 on $35.03 carries 1000 × 403 / 3503 = 115.04.
    await admin('post', `/api/payments/charges/${taxed.charge_id}/offline`).send({ kind: 'cash', amountCents: 1000, sendReceipt: false });
    res = await admin('get', '/api/payments/summary');
    expect(res.body.data).toMatchObject({ taxCollectedThisMonthCents: 115, collectedThisMonthCents: 3500 });

    // The rest by card ($25.03 → 287.96), then $6.00 refunded (→ 69.03 back).
    mockClient.retrieveCheckoutSession.mockResolvedValue(paidSession(taxed.charge_id, 2503));
    await publicGet(`/api/registration/public/payments/${taxed.public_token}?session_id=cs_test_1`);
    expect((await lastChargeById(taxed.charge_id)).status).toBe('paid');
    mockClient.createRefund.mockResolvedValueOnce({ id: 're_1', amount: 600, status: 'succeeded', charge: 'ch_cs_test_1' });
    expect((await admin('post', `/api/payments/charges/${taxed.charge_id}/refund`).send({ amountCents: 600 })).status).toBe(200);
    // 115.04 + 287.96 - 69.03 = 333.97
    res = await admin('get', '/api/payments/summary');
    expect(res.body.data.taxCollectedThisMonthCents).toBe(334);
    const overview = await admin('get', '/api/payments/overview');
    expect(overview.body.data.summary.taxCollectedThisMonthCents).toBe(334);
  });

  it('never goes below nothing when a month’s refunds outweigh its payments', async () => {
    const { taxed } = await seedLedger();
    mockClient.retrieveCheckoutSession.mockResolvedValue(paidSession(taxed.charge_id, 3503));
    await publicGet(`/api/registration/public/payments/${taxed.public_token}?session_id=cs_test_1`);
    await pool().query(`UPDATE charge_payments SET created_at = now() - interval '45 days' WHERE kind = 'card'`);
    mockClient.createRefund.mockResolvedValueOnce({ id: 're_2', amount: 3503, status: 'succeeded', charge: 'ch_cs_test_1' });
    await admin('post', `/api/payments/charges/${taxed.charge_id}/refund`).send({});
    const res = await admin('get', '/api/payments/summary');
    expect(res.body.data.taxCollectedThisMonthCents).toBe(0);
  });

  const lastChargeById = async (id) => (await pool().query('SELECT * FROM charges WHERE charge_id = $1', [id])).rows[0];
});
