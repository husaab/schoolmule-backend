// Cash for a student who never sent the form in, against the real schema: the
// office records a payment on a form for a student, which makes the response,
// its charge and the payment together (POST
// /api/registration/forms/:formId/office-payments). Stripe is a fake client.
const mockClient = {
  mode: 'test',
  livemode: false,
  createCheckoutSession: jest.fn(),
  retrieveCheckoutSession: jest.fn(),
  expireCheckoutSession: jest.fn(),
  request: jest.fn(),
};

jest.mock('../../../services/payments/stripeClient', () => {
  const actual = jest.requireActual('../../../services/payments/stripeClient');
  return { ...actual, clientFromEnv: jest.fn(() => mockClient) };
});

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const accessStore = require('../../../services/access/accessStore');
const emails = require('../../../services/payments/emails');

const SCHOOL = 'ALHAADIACADEMY';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440001', username: 'Teacher User', email: 'teacher@test.com', role: 'TEACHER' };
const PARENT_ID = '660e8400-e29b-41d4-a716-446655440009';
const ACCT = 'acct_1MapleGrove';

const pool = () => getTestPool();
let ip = 0;
const admin = (method, url) => authenticatedRequest(method, url);
const officePay = (formId, body, who) => authenticatedRequest('post', `/api/registration/forms/${formId}/office-payments`, who).send(body);

async function seedUsers() {
  for (const [id, email, role] of [[ADMIN_ID, 'admin@test.com', 'ADMIN'], [TEACHER.userId, 'teacher@test.com', 'TEACHER'], [PARENT_ID, 'parent@test.com', 'PARENT']]) {
    await pool().query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Test', $4, $5, $6, true, true) ON CONFLICT (user_id) DO NOTHING`,
      [id, email, email, role, SCHOOL, role],
    );
  }
}

/** Puts the teacher on a custom access role holding `permissions`. */
async function giveTeacher(permissions) {
  const { rows: [r] } = await pool().query(`INSERT INTO staff_roles (school, name, permissions) VALUES ($1, 'Office test role', $2) RETURNING role_id`, [SCHOOL, permissions]);
  await pool().query('UPDATE users SET staff_role_id = $1 WHERE user_id = $2', [r.role_id, TEACHER.userId]);
  accessStore.invalidateAll();
}

async function seedStudents() {
  const { rows: [{ school_year_id: year }] } = await pool().query('SELECT school_year_id FROM school_years WHERE school = $1 AND is_active', [SCHOOL]);
  const add = async (name, mother, school = SCHOOL) => (await pool().query(
    'INSERT INTO students (name, school, grade, mother_email, school_year_id) VALUES ($1, $2, $3, $4, $5) RETURNING student_id',
    [name, school, '5', mother, school === SCHOOL ? year : null],
  )).rows[0].student_id;
  const s = { aisha: await add('Aisha Khan', 'Mum.Khan@Example.com'), omar: await add('Omar Ali', null), far: await add('Far Away', 'far@example.com', 'PLAYGROUND') };
  await pool().query(`INSERT INTO parent_students (student_id, parent_id, parent_email, relation, school) VALUES ($1, $2, 'parent@test.com', 'Mother', $3)`, [s.aisha, PARENT_ID, SCHOOL]);
  return s;
}

async function addRate(name, percent) {
  const res = await admin('post', '/api/payments/tax-rates').send({ name, percent });
  return res.body.data.taxRates.find((r) => r.name === name).taxRateId;
}

/** A published form; `payment` null for one without a payment field. */
async function seedForm({ payment, createdBy = ADMIN_ID, slug = 'trip' } = {}) {
  await pool().query(`UPDATE schools SET slug = 'maple', email = 'office@maple.example' WHERE school_code = $1`, [SCHOOL]);
  await pool().query(
    `INSERT INTO registration_statuses (school, key, label, is_builtin, is_default) VALUES ($1, 'new', 'New', true, true) ON CONFLICT DO NOTHING`,
    [SCHOOL],
  );
  const { rows: [form] } = await pool().query(
    `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ($1, 'Grade 5 Field Trip', $2, 'published', $3) RETURNING form_id`,
    [SCHOOL, slug, createdBy],
  );
  const field = async (type, label, order, config = null) => (await pool().query(
    `INSERT INTO registration_form_fields (form_id, field_type, label, is_required, sort_order, payment_config) VALUES ($1, $2, $3, $4, $5, $6) RETURNING field_id`,
    [form.form_id, type, label, type === 'text', order, config ? JSON.stringify({ allowOffline: true, currency: 'cad', ...config }) : null],
  )).rows[0].field_id;
  const ids = { formId: form.form_id, name: await field('text', 'Student name', 0), email: await field('email', 'Parent email', 1) };
  if (payment !== null) ids.payment = await field('payment', 'Payment', 2, payment);
  return ids;
}

const priceList = (hst = null) => ({
  items: [
    { id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, taxRateId: hst },
    { id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false, taxRateId: hst },
  ],
});

const counts = async () => (await pool().query(
  `SELECT (SELECT COUNT(*) FROM registration_form_submissions)::int AS submissions, (SELECT COUNT(*) FROM charges)::int AS charges,
          (SELECT COUNT(*) FROM charge_payments)::int AS payments`,
)).rows[0];
const receipts = async () => (await pool().query(`SELECT recipient_email FROM email_outbox WHERE kind = 'payment_receipt' ORDER BY recipient_email`)).rows.map((r) => r.recipient_email);

beforeEach(async () => {
  Object.values(mockClient).forEach((fn) => typeof fn === 'function' && fn.mockReset && fn.mockReset());
  await seedUsers();
});

describe('recording a payment for a student with no response', () => {
  it('makes the response, its charge and the payment, and emails the guardians a receipt', async () => {
    const s = await seedStudents();
    const ids = await seedForm({ payment: priceList() });
    const res = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash', note: 'Envelope 4' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    const charge = res.body.data;
    expect(charge).toMatchObject({
      sourceType: 'form_submission', formId: ids.formId, formTitle: 'Grade 5 Field Trip', studentId: s.aisha, studentName: 'Aisha Khan',
      payerEmail: null, chosenMethod: 'offline', amountCents: 2500, taxCents: 0, taxSummary: [], amountPaidCents: 2500, balanceCents: 0, status: 'paid',
    });
    expect(charge.lines).toEqual([expect.objectContaining({ itemId: 'trip', label: 'Trip fee', amountCents: 2500, taxCents: 0 })]);
    expect(charge.payments).toEqual([expect.objectContaining({ kind: 'cash', amountCents: 2500, note: 'Envelope 4', recordedByName: 'Test ADMIN' })]);

    const { rows: [sub] } = await pool().query('SELECT * FROM registration_form_submissions WHERE submission_id = $1', [charge.submissionId]);
    expect(sub).toMatchObject({ form_id: ids.formId, school: SCHOOL, student_id: s.aisha, entered_by: ADMIN_ID, status: 'new', submitted_by: null, ip_address: null });
    expect(sub.answers).toEqual({ [ids.payment]: 'Trip fee $25.00 · Total $25.00 · Paying at the office' });

    // Nobody gave an email: the student's guardians get the receipt.
    expect(await receipts()).toEqual(['mum.khan@example.com', 'parent@test.com']);
    expect(mockClient.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('charges the optional items ticked, with tax, and takes part of it', async () => {
    const s = await seedStudents();
    const hst = await addRate('HST', 13);
    const ids = await seedForm({ payment: priceList(hst) });
    const res = await officePay(ids.formId, { studentId: s.aisha, itemIds: ['lunch'], kind: 'cheque', amountCents: 1000, sendReceipt: false });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      amountCents: 3503, taxCents: 403, amountPaidCents: 1000, balanceCents: 2503, status: 'partially_paid',
      taxSummary: [{ name: 'HST', rateMilli: 13000, cents: 403, included: false }],
    });
    expect(res.body.data.lines.map((l) => [l.label, l.amountCents, l.taxCents])).toEqual([['Trip fee', 2500, 325], ['Pizza lunch', 600, 78]]);
    const { rows: [sub] } = await pool().query('SELECT answers FROM registration_form_submissions WHERE submission_id = $1', [res.body.data.submissionId]);
    expect(sub.answers[ids.payment]).toBe('Trip fee $25.00, Pizza lunch $6.00 + HST $4.03 = $35.03 (paying at the office)');
    expect(await receipts()).toEqual([]);

    // The rest, later, the usual way; the receipt goes to the guardians and shows the tax.
    const rest = await admin('post', `/api/payments/charges/${res.body.data.chargeId}/offline`).send({ kind: 'cash' });
    expect(rest.body.data).toMatchObject({ status: 'paid', balanceCents: 0 });
    expect(await receipts()).toEqual(['mum.khan@example.com', 'parent@test.com']);
    const { rows: [job] } = await pool().query(`SELECT * FROM email_outbox WHERE kind = 'payment_receipt' LIMIT 1`);
    const { message } = await emails.receiptHandler.build(job);
    expect(message.html).toMatch(/HST \(13%\)<\/td>\s*<td[^>]*>\$4\.03<\/td>/);
  });

  it('refuses an amount over what is owed, a bad kind, an unknown item or nothing to pay, and leaves nothing behind', async () => {
    const s = await seedStudents();
    const ids = await seedForm({ payment: priceList() });
    let res = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash', amountCents: 2501 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Enter an amount between $0.01 and $25.00');
    res = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash', amountCents: 0 });
    expect(res.status).toBe(400);
    res = await officePay(ids.formId, { studentId: s.aisha, kind: 'waiver' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Choose cash, cheque or other');
    res = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash', itemIds: ['ipad'] });
    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ submissions: 0, charges: 0, payments: 0 });

    const optional = await seedForm({ slug: 'optional', payment: { items: [{ id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false }] } });
    res = await officePay(optional.formId, { studentId: s.aisha, kind: 'cash', itemIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOTHING_TO_PAY');
    res = await officePay(optional.formId, { studentId: s.aisha, kind: 'other', itemIds: ['lunch'] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ amountCents: 600, status: 'paid' });
  });

  it('a student already on the form: 409 with the charge to open, whoever made it', async () => {
    const s = await seedStudents();
    const ids = await seedForm({ payment: priceList() });
    const first = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash', amountCents: 500, sendReceipt: false });
    expect(first.status).toBe(201);
    const again = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash' });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      status: 'failed',
      code: 'ALREADY_ON_FORM',
      message: 'This student already has a payment on this form. Open it to record the payment.',
      data: { chargeId: first.body.data.chargeId },
    });
    expect(await counts()).toEqual({ submissions: 1, charges: 1, payments: 1 });

    // The family's own response for the child counts too.
    getApp();
    const token = jwt.sign({ userId: PARENT_ID, email: 'parent@test.com', school: SCHOOL, role: 'PARENT', isVerified: true, isVerifiedSchool: true }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const other = await seedForm({ slug: 'second', payment: priceList() });
    const sent = await request(getApp()).post('/api/registration/public/maple/second/submit').set('X-Forwarded-For', `192.0.2.${(ip += 1)}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answers: { [other.name]: 'Aisha', [other.email]: 'parent@test.com' }, payment: { method: 'offline' }, studentId: s.aisha });
    expect(sent.status).toBe(201);
    const { rows: [familyCharge] } = await pool().query('SELECT charge_id FROM charges WHERE submission_id = $1', [sent.body.data.submissionId]);
    const res = await officePay(other.formId, { studentId: s.aisha, kind: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.data).toEqual({ chargeId: familyCharge.charge_id });

    // Another student on the same form is fine.
    expect((await officePay(ids.formId, { studentId: s.omar, kind: 'cash', sendReceipt: false })).status).toBe(201);
  });

  it('two clicks at once make one response', async () => {
    const s = await seedStudents();
    const ids = await seedForm({ payment: priceList() });
    const [a, b] = await Promise.all([
      officePay(ids.formId, { studentId: s.aisha, kind: 'cash', sendReceipt: false }),
      officePay(ids.formId, { studentId: s.aisha, kind: 'cash', sendReceipt: false }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await counts()).toEqual({ submissions: 1, charges: 1, payments: 1 });
  });

  it('a form without a payment field is a 400; another school’s student, or no student, a 404', async () => {
    const s = await seedStudents();
    const noPayment = await seedForm({ payment: null });
    let res = await officePay(noPayment.formId, { studentId: s.aisha, kind: 'cash' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_PAYMENT_FIELD');

    const ids = await seedForm({ slug: 'paid', payment: priceList() });
    for (const studentId of [s.far, '9b2c8a4e-1f3d-4c5b-8a6e-2d7f9e1c3b5a', 'not-an-id', undefined]) {
      res = await officePay(ids.formId, { studentId, kind: 'cash' });
      expect(res.status).toBe(404);
    }
    // A deleted student is no longer one of the school's.
    await pool().query('UPDATE students_all SET deleted_at = now() WHERE student_id = $1', [s.omar]);
    expect((await officePay(ids.formId, { studentId: s.omar, kind: 'cash' })).status).toBe(404);

    // Another school's form.
    const { rows: [elsewhere] } = await pool().query(
      `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ('PLAYGROUND', 'Theirs', 'theirs', 'published', $1) RETURNING form_id`,
      [ADMIN_ID],
    );
    expect((await officePay(elsewhere.form_id, { studentId: s.aisha, kind: 'cash' })).status).toBe(404);
    expect(await counts()).toEqual({ submissions: 0, charges: 0, payments: 0 });
  });
});

describe('who may record one', () => {
  it('needs finance and access to the form', async () => {
    const s = await seedStudents();
    const adminForm = await seedForm({ payment: priceList() });
    const teacherForm = await seedForm({ slug: 'teachers', createdBy: TEACHER.userId, payment: priceList() });

    // A teacher with neither.
    let res = await officePay(teacherForm.formId, { studentId: s.aisha, kind: 'cash' }, TEACHER);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    // Finance, but not this form (someone else's, and no `forms`).
    await giveTeacher(['finance']);
    res = await officePay(adminForm.formId, { studentId: s.aisha, kind: 'cash' }, TEACHER);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/forms you created/);
    expect(await counts()).toEqual({ submissions: 0, charges: 0, payments: 0 });

    // Finance and their own form.
    res = await officePay(teacherForm.formId, { studentId: s.aisha, kind: 'cash', sendReceipt: false }, TEACHER);
    expect(res.status).toBe(201);
    const { rows: [sub] } = await pool().query('SELECT entered_by FROM registration_form_submissions WHERE submission_id = $1', [res.body.data.submissionId]);
    expect(sub.entered_by).toBe(TEACHER.userId);
  });

  it('form access without finance is refused', async () => {
    const s = await seedStudents();
    const ids = await seedForm({ payment: priceList() });
    await giveTeacher(['forms']);
    const res = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash' }, TEACHER);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(await counts()).toEqual({ submissions: 0, charges: 0, payments: 0 });
  });
});

describe('a response the office entered', () => {
  it('says who entered it in the list and the response, and “Entered by the office” in the export', async () => {
    const s = await seedStudents();
    const ids = await seedForm({ payment: priceList() });
    await pool().query(`UPDATE schools SET slug = 'maple' WHERE school_code = $1`, [SCHOOL]);
    const family = await request(getApp()).post('/api/registration/public/maple/trip/submit').set('X-Forwarded-For', '192.0.2.200')
      .send({ answers: { [ids.name]: 'Omar', [ids.email]: 'dad@example.com' }, payment: { method: 'offline' } });
    expect(family.status).toBe(201);
    const office = await officePay(ids.formId, { studentId: s.aisha, kind: 'cash', sendReceipt: false });

    const list = await admin('get', `/api/registration/forms/${ids.formId}/submissions`);
    const byId = new Map(list.body.data.map((sub) => [sub.submissionId, sub]));
    expect(byId.get(office.body.data.submissionId)).toMatchObject({ enteredByName: 'Test ADMIN', studentId: s.aisha, studentName: 'Aisha Khan', payment: { status: 'paid' } });
    expect(byId.get(family.body.data.submissionId).enteredByName).toBeNull();

    const one = await admin('get', `/api/registration/forms/${ids.formId}/submissions/${office.body.data.submissionId}`);
    expect(one.body.data.enteredByName).toBe('Test ADMIN');

    const csv = (await admin('get', `/api/registration/forms/${ids.formId}/submissions/export`)).text.split('\n');
    expect(csv[0]).toMatch(/Payment,Amount,Paid,Refunded,Paid with,Entered by$/);
    expect(csv.filter((l) => /,Entered by the office$/.test(l))).toHaveLength(1);
    expect(csv.find((l) => l.includes('dad@example.com'))).toMatch(/,$/);
  });
});
