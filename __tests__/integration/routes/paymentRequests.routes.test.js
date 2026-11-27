// Payment requests, the child link and the overview, against the real schema:
// a signed-in parent says which child a form is for, the office asks a grade
// or a class to pay, families pay by card or at the office, and the overview
// and the parent's page show where it all stands. Stripe is a fake client.
const mockClient = {
  mode: 'test',
  livemode: false,
  createCheckoutSession: jest.fn(),
  retrieveCheckoutSession: jest.fn(),
  expireCheckoutSession: jest.fn(),
  retrievePaymentIntent: jest.fn(),
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

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const requests = require('../../../services/payments/requests');
const emails = require('../../../services/payments/emails');

const SCHOOL = 'ALHAADIACADEMY';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440001', username: 'Teacher User', email: 'teacher@test.com', role: 'TEACHER' };
const PARENT_ID = '660e8400-e29b-41d4-a716-446655440009';
const OTHER_PARENT_ID = '660e8400-e29b-41d4-a716-446655440010';
const ACCT = 'acct_1MapleGrove';

const pool = () => getTestPool();
let ip = 0;
const publicReq = (method, url, token) => {
  const r = request(getApp())[method](url).set('X-Forwarded-For', `192.0.2.${(ip += 1) % 250}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
const parentToken = (over = {}) => {
  getApp();
  return jwt.sign({
    userId: PARENT_ID, email: 'parent@test.com', school: SCHOOL, role: 'PARENT', isVerified: true, isVerifiedSchool: true, ...over,
  }, process.env.JWT_SECRET, { expiresIn: '1h' });
};
const asParent = (method, url) => authenticatedRequest(method, url, { userId: PARENT_ID, email: 'parent@test.com', role: 'PARENT' });

const yearId = async () => (await pool().query(`SELECT school_year_id FROM school_years WHERE school = $1 AND is_active`, [SCHOOL])).rows[0].school_year_id;

async function seedUsers() {
  for (const [id, email, role] of [
    [ADMIN_ID, 'admin@test.com', 'ADMIN'],
    [PARENT_ID, 'parent@test.com', 'PARENT'],
    [OTHER_PARENT_ID, 'other@test.com', 'PARENT'],
  ]) {
    await pool().query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, 'x', 'Test', $4, $5, $6, true, true) ON CONFLICT (user_id) DO NOTHING`,
      [id, email, email, role, SCHOOL, role],
    );
  }
}

/** Three grade 5 students (Aisha is the parent's, with a mother's email too) and one in grade 6. */
async function seedStudents() {
  const year = await yearId();
  const add = async (name, grade, mother = null, school = SCHOOL, yr = year) => (await pool().query(
    `INSERT INTO students (name, school, grade, mother_email, school_year_id) VALUES ($1, $2, $3, $4, $5) RETURNING student_id`,
    [name, school, grade, mother, yr],
  )).rows[0].student_id;
  const s = {
    aisha: await add('Aisha Khan', '5', 'Mum.Khan@Example.com'),
    omar: await add('Omar Ali', '5', 'omar.mum@example.com'),
    noor: await add('Noor Haddad', '5'),
    yusuf: await add('Yusuf Rahman', '6', 'yusuf.mum@example.com'),
  };
  await pool().query(
    `INSERT INTO parent_students (student_id, parent_id, parent_email, relation, school) VALUES ($1, $2, 'PARENT@test.com', 'Mother', $3)`,
    [s.aisha, PARENT_ID, SCHOOL],
  );
  const { rows: [cls] } = await pool().query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id) VALUES ($1, '6', 'Science', 'Ms T', $2, $3) RETURNING class_id`,
    [SCHOOL, ADMIN_ID, year],
  );
  await pool().query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [cls.class_id, s.yusuf]);
  return { ...s, classId: cls.class_id };
}

async function seedForm() {
  await pool().query(`UPDATE schools SET slug = 'maple', email = 'office@maple.example' WHERE school_code = $1`, [SCHOOL]);
  await pool().query(
    `INSERT INTO registration_statuses (school, key, label, is_builtin, is_default) VALUES ($1, 'new', 'New', true, true) ON CONFLICT DO NOTHING`,
    [SCHOOL],
  );
  const { rows: [form] } = await pool().query(
    `INSERT INTO registration_forms (school, title, slug, status, created_by) VALUES ($1, 'Pizza day', 'pizza', 'published', $2) RETURNING form_id`,
    [SCHOOL, ADMIN_ID],
  );
  const field = async (type, label, order, config = null) => (await pool().query(
    `INSERT INTO registration_form_fields (form_id, field_type, label, is_required, sort_order, payment_config) VALUES ($1, $2, $3, false, $4, $5) RETURNING field_id`,
    [form.form_id, type, label, order, config ? JSON.stringify(config) : null],
  )).rows[0].field_id;
  return {
    formId: form.form_id,
    email: await field('email', 'Email', 0),
    payment: await field('payment', 'Payment', 1, { items: [{ id: 'slice', label: 'Two slices', amountCents: 800, required: true }], allowOffline: true, currency: 'cad' }),
  };
}

const connectSchool = () => pool().query(
  `INSERT INTO payment_accounts (school, livemode, stripe_account_id, status, card_payments_status) VALUES ($1, false, $2, 'active', 'active')`,
  [SCHOOL, ACCT],
);

const outbox = async (kind) => (await pool().query(
  `SELECT kind, recipient_email, dedupe_key, payload, student_id FROM email_outbox WHERE ($1::text IS NULL OR kind = $1) ORDER BY recipient_email, created_at`,
  [kind || null],
)).rows;

const session = (over = {}) => ({
  id: 'cs_req_1', url: 'https://checkout.stripe.com/c/pay/cs_req_1', status: 'open', payment_status: 'unpaid',
  expires_at: Math.floor(Date.now() / 1000) + 3600, ...over,
});

const createRequest = (body) => authenticatedRequest('post', '/api/payments/requests').send({
  title: 'Grade 5 museum trip', description: 'Bus and entry.', amountCents: 3500, dueDate: '2026-12-12', ...body,
});

beforeEach(async () => {
  mockConfigured = true;
  Object.values(mockClient).forEach((fn) => typeof fn === 'function' && fn.mockReset && fn.mockReset());
  mockClient.createCheckoutSession.mockResolvedValue(session());
  mockClient.expireCheckoutSession.mockResolvedValue({});
  delete process.env.PARENT_PAYMENTS_ENABLED;
  await seedUsers();
});

describe('the child link on a public form', () => {
  it('lists a signed-in parent’s children, and nobody’s for anyone else', async () => {
    const s = await seedStudents();
    await seedForm();
    let res = await publicReq('get', '/api/registration/public/maple/pizza/children');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ signedIn: false, children: [] });

    res = await publicReq('get', '/api/registration/public/maple/pizza/children', parentToken());
    expect(res.body.data).toEqual({ signedIn: true, children: [{ studentId: s.aisha, name: 'Aisha Khan', grade: '5' }] });

    // A preview ("view as") token, or a staff token, counts as nobody.
    res = await publicReq('get', '/api/registration/public/maple/pizza/children', parentToken({ impersonator: ADMIN_ID }));
    expect(res.body.data.signedIn).toBe(false);
    res = await publicReq('get', '/api/registration/public/maple/pizza/children', parentToken({ role: 'ADMIN' }));
    expect(res.body.data.signedIn).toBe(false);
  });

  it('keeps the child on the response and its charge, and refuses a child who isn’t theirs', async () => {
    const s = await seedStudents();
    const ids = await seedForm();
    await connectSchool();
    const body = (studentId) => ({ answers: { [ids.email]: 'parent@test.com' }, payment: { method: 'card' }, studentId });

    let res = await publicReq('post', '/api/registration/public/maple/pizza/submit').send(body(s.aisha));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SIGN_IN_AGAIN');

    res = await publicReq('post', '/api/registration/public/maple/pizza/submit', parentToken()).send(body(s.omar));
    expect(res.status).toBe(403);

    res = await publicReq('post', '/api/registration/public/maple/pizza/submit', parentToken()).send(body(s.aisha));
    expect(res.status).toBe(201);
    const { rows: [sub] } = await pool().query(`SELECT student_id, submitted_by FROM registration_form_submissions WHERE submission_id = $1`, [res.body.data.submissionId]);
    expect(sub).toEqual({ student_id: s.aisha, submitted_by: PARENT_ID });
    const { rows: [charge] } = await pool().query(`SELECT charge_id, student_id FROM charges WHERE submission_id = $1`, [res.body.data.submissionId]);
    expect(charge.student_id).toBe(s.aisha);

    // Staff see the child on the response and on the charge.
    const list = await authenticatedRequest('get', `/api/registration/forms/${ids.formId}/submissions`);
    expect(list.body.data[0]).toMatchObject({ studentId: s.aisha, studentName: 'Aisha Khan', studentGrade: '5' });
    const detail = await authenticatedRequest('get', `/api/payments/charges/${charge.charge_id}`);
    expect(detail.body.data).toMatchObject({ studentId: s.aisha, studentName: 'Aisha Khan', sourceType: 'form_submission' });
  });

  it('lets the office link a payment to a child, or unlink it', async () => {
    const s = await seedStudents();
    const ids = await seedForm();
    await connectSchool();
    const res = await publicReq('post', '/api/registration/public/maple/pizza/submit').send({ answers: { [ids.email]: 'dad@example.com' }, payment: { method: 'offline' } });
    const { rows: [charge] } = await pool().query(`SELECT charge_id, submission_id FROM charges WHERE submission_id = $1`, [res.body.data.submissionId]);

    const found = await authenticatedRequest('get', '/api/payments/students?q=omar');
    expect(found.body.data).toEqual([{ studentId: s.omar, name: 'Omar Ali', grade: '5' }]);

    let put = await authenticatedRequest('put', `/api/payments/charges/${charge.charge_id}/student`).send({ studentId: s.omar });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ studentId: s.omar, studentName: 'Omar Ali' });
    const { rows: [sub] } = await pool().query(`SELECT student_id FROM registration_form_submissions WHERE submission_id = $1`, [charge.submission_id]);
    expect(sub.student_id).toBe(s.omar);

    const { rows: [{ student_id: elsewhere }] } = await pool().query(
      `INSERT INTO students (name, school, grade) VALUES ('Far Away', 'PLAYGROUND', '5') RETURNING student_id`,
    );
    put = await authenticatedRequest('put', `/api/payments/charges/${charge.charge_id}/student`).send({ studentId: elsewhere });
    expect(put.status).toBe(404);

    put = await authenticatedRequest('put', `/api/payments/charges/${charge.charge_id}/student`).send({ studentId: null });
    expect(put.body.data.studentId).toBeNull();
  });
});

describe('payment requests', () => {
  it('needs finance', async () => {
    const res = await authenticatedRequest('get', '/api/payments/requests', TEACHER);
    expect(res.status).toBe(403);
  });

  it('gives the roster: students with their classes, and the classes', async () => {
    const s = await seedStudents();
    const res = await authenticatedRequest('get', '/api/payments/requests/roster');
    expect(res.status).toBe(200);
    expect(res.body.data.students.map((x) => x.name)).toEqual(['Aisha Khan', 'Noor Haddad', 'Omar Ali', 'Yusuf Rahman']);
    expect(res.body.data.students.find((x) => x.studentId === s.yusuf)).toMatchObject({ grade: '6', classIds: [s.classId], hasGuardianEmail: true });
    expect(res.body.data.students.find((x) => x.studentId === s.noor).hasGuardianEmail).toBe(false);
    expect(res.body.data.classes).toEqual([{ classId: s.classId, name: 'Science', grade: '6', teacherName: 'Ms T', studentCount: 1 }]);
  });

  it('asks a grade to pay: one charge per student, and an email to each guardian', async () => {
    const s = await seedStudents();
    await connectSchool();
    const res = await createRequest({ grades: ['5'] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Grade 5 museum trip', amountCents: 3500, dueDate: '2026-12-12', allowOffline: true,
      stats: { students: 3, settled: 0, open: 3, expectedCents: 10500, collectedCents: 0, outstandingCents: 10500 },
    });
    const aisha = res.body.data.charges.find((c) => c.studentId === s.aisha);
    expect(aisha).toMatchObject({ sourceType: 'request', requestTitle: 'Grade 5 museum trip', dueDate: '2026-12-12', status: 'unpaid', balanceCents: 3500 });
    // The parent account's email and the mother's, once each, lower-cased.
    expect(aisha.guardianEmails).toEqual(['parent@test.com', 'mum.khan@example.com']);
    expect(aisha.linkSentAt).not.toBeNull();

    const mail = await outbox('payment_request');
    expect(mail.map((m) => m.recipient_email)).toEqual(['mum.khan@example.com', 'omar.mum@example.com', 'parent@test.com']);
    expect(mail.every((m) => m.payload.reminder === null)).toBe(true);
    // The email itself, built as the outbox would send it.
    const { rows: [job] } = await pool().query(`SELECT * FROM email_outbox WHERE kind = 'payment_request' AND recipient_email = 'parent@test.com'`);
    const built = await emails.requestHandler.build(job);
    expect(built.message.subject).toBe('Payment requested: Grade 5 museum trip for Aisha Khan');
    expect(built.message.html).toMatch(/\$35\.00/);
    expect(built.message.html).toMatch(/December 12, 2026/);
    expect(built.message.html).toMatch(/Bus and entry\./);
    expect(built.message.html).toContain(`/pay/${(await pool().query('SELECT public_token FROM charges WHERE charge_id = $1', [aisha.chargeId])).rows[0].public_token}`);
    expect(built.message.html).toMatch(/at the office by cash or cheque/);

    // Noor has no guardian email: her charge is there, nobody was emailed.
    expect(res.body.data.charges.find((c) => c.studentId === s.noor).linkSentAt).toBeNull();

    // Sending to the grade and Yusuf's class again adds only Yusuf.
    const more = await authenticatedRequest('post', `/api/payments/requests/${res.body.data.requestId}/students`).send({ grades: ['5'], classIds: [s.classId] });
    expect(more.status).toBe(200);
    expect(more.body.data.result).toEqual({ added: 1 });
    expect(more.body.data.stats.students).toBe(4);
  });

  it('refuses card-only without Stripe, and takes office-only payment without it', async () => {
    await seedStudents();
    let res = await createRequest({ grades: ['5'], allowOffline: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAYMENTS_UNAVAILABLE');
    res = await createRequest({ grades: ['5'], allowOffline: true });
    expect(res.status).toBe(201);
    res = await createRequest({ grades: [], studentIds: [] });
    expect(res.status).toBe(400);
    res = await createRequest({ grades: ['5'], amountCents: 10 });
    expect(res.status).toBe(400);
  });

  it('shows the family its request, takes a card payment and sends the receipt to whoever paid', async () => {
    const s = await seedStudents();
    await connectSchool();
    const made = await createRequest({ studentIds: [s.aisha] });
    const { rows: [row] } = await pool().query(`SELECT charge_id, public_token FROM charges WHERE request_id = $1`, [made.body.data.requestId]);

    let view = await publicReq('get', `/api/registration/public/payments/${row.public_token}`);
    expect(view.body.data).toMatchObject({
      sourceType: 'request', formTitle: 'Grade 5 museum trip', requestDescription: 'Bus and entry.', dueDate: '2026-12-12',
      studentName: 'Aisha Khan', allowOffline: true, balanceCents: 3500, canPayOnline: true,
    });

    const start = await publicReq('post', `/api/registration/public/payments/${row.public_token}/checkout`);
    expect(start.body.data.url).toBe('https://checkout.stripe.com/c/pay/cs_req_1');
    const sent = mockClient.createCheckoutSession.mock.calls[0][1];
    expect(sent.metadata).toEqual({ charge_id: row.charge_id, source: 'schoolmule_request' });
    expect(sent.customer_email).toBeUndefined();

    mockClient.retrieveCheckoutSession.mockResolvedValue(session({
      status: 'complete', payment_status: 'paid', amount_total: 3500, client_reference_id: row.charge_id,
      customer_details: { email: 'Grandpa@Example.com' },
      payment_intent: { id: 'pi_req_1', latest_charge: { id: 'ch_req_1', payment_method_details: { card: { brand: 'visa', last4: '4242' } }, balance_transaction: { fee: 130 } } },
    }));
    view = await publicReq('get', `/api/registration/public/payments/${row.public_token}?session_id=cs_req_1`);
    expect(view.body.data.status).toBe('paid');
    const { rows: [after] } = await pool().query(`SELECT payer_email FROM charges WHERE charge_id = $1`, [row.charge_id]);
    expect(after.payer_email).toBe('grandpa@example.com');
    expect((await outbox('payment_receipt')).map((m) => m.recipient_email)).toEqual(['grandpa@example.com']);
  });

  it('sends an office receipt to the guardians when nobody gave an email', async () => {
    const s = await seedStudents();
    await connectSchool();
    const made = await createRequest({ studentIds: [s.aisha] });
    const chargeId = made.body.data.charges[0].chargeId;
    const res = await authenticatedRequest('post', `/api/payments/charges/${chargeId}/offline`).send({ kind: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('paid');
    expect((await outbox('payment_receipt')).map((m) => m.recipient_email)).toEqual(['mum.khan@example.com', 'parent@test.com']);
  });

  it('edits a request, but not its amount once a family has paid', async () => {
    const s = await seedStudents();
    await connectSchool();
    const made = await createRequest({ grades: ['5'] });
    const id = made.body.data.requestId;

    let res = await authenticatedRequest('patch', `/api/payments/requests/${id}`).send({ amountCents: 4000, title: 'Museum trip' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: 'Museum trip', amountCents: 4000, stats: { expectedCents: 12000 } });
    const { rows: lines } = await pool().query(`SELECT DISTINCT l.label, l.amount_cents FROM charge_lines l JOIN charges c ON c.charge_id = l.charge_id WHERE c.request_id = $1`, [id]);
    expect(lines).toEqual([{ label: 'Museum trip', amount_cents: 4000 }]);

    const aisha = res.body.data.charges.find((c) => c.studentId === s.aisha);
    await authenticatedRequest('post', `/api/payments/charges/${aisha.chargeId}/offline`).send({ kind: 'cheque', amountCents: 1000, sendReceipt: false });
    res = await authenticatedRequest('patch', `/api/payments/requests/${id}`).send({ amountCents: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_PAYMENTS');
    res = await authenticatedRequest('patch', `/api/payments/requests/${id}`).send({ dueDate: null, allowOffline: false });
    expect(res.body.data).toMatchObject({ dueDate: null, allowOffline: false, amountCents: 4000 });

    // A student with a payment can't be taken off; one without can.
    res = await authenticatedRequest('delete', `/api/payments/requests/${id}/charges/${aisha.chargeId}`);
    expect(res.status).toBe(409);
    const omar = (await authenticatedRequest('get', `/api/payments/requests/${id}`)).body.data.charges.find((c) => c.studentId === s.omar);
    res = await authenticatedRequest('delete', `/api/payments/requests/${id}/charges/${omar.chargeId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stats.students).toBe(2);

    // Nor can a request with a payment be deleted.
    res = await authenticatedRequest('delete', `/api/payments/requests/${id}`);
    expect(res.status).toBe(409);
    const fresh = await createRequest({ grades: ['6'], title: 'Grade 6 books' });
    res = await authenticatedRequest('delete', `/api/payments/requests/${fresh.body.data.requestId}`);
    expect(res.status).toBe(200);
    expect((await pool().query(`SELECT 1 FROM charges WHERE request_id = $1`, [fresh.body.data.requestId])).rowCount).toBe(0);
  });

  it('reminds the families that still owe, and sends one automatic reminder before the due date', async () => {
    const s = await seedStudents();
    await connectSchool();
    const made = await createRequest({ grades: ['5'], dueDate: '2026-12-12' });
    const id = made.body.data.requestId;
    const omar = made.body.data.charges.find((c) => c.studentId === s.omar);
    await authenticatedRequest('post', `/api/payments/charges/${omar.chargeId}/waive`).send({ note: 'Bursary' });

    const res = await authenticatedRequest('post', `/api/payments/requests/${id}/remind`);
    expect(res.status).toBe(200);
    // Aisha's family (two addresses) is reminded; Noor has no address; Omar is settled.
    expect(res.body.data.result).toEqual({ reminded: 1, open: 2 });
    const reminders = (await outbox('payment_request')).filter((m) => m.payload.reminder === 'manual');
    expect(reminders.map((m) => m.recipient_email)).toEqual(['mum.khan@example.com', 'parent@test.com']);

    // A week out nothing goes; three days out, once.
    expect(await requests.sendDueSoonReminders({ livemode: false, today: '2026-12-05' })).toBe(0);
    expect(await requests.sendDueSoonReminders({ livemode: false, today: '2026-12-09' })).toBe(1);
    expect(await requests.sendDueSoonReminders({ livemode: false, today: '2026-12-10' })).toBe(0);
    const due = (await outbox('payment_request')).filter((m) => m.payload.reminder === 'due_soon');
    expect(due).toHaveLength(2);
  });

  it('filters the ledger by request, source and student', async () => {
    const s = await seedStudents();
    await connectSchool();
    const made = await createRequest({ grades: ['5'] });
    let res = await authenticatedRequest('get', `/api/payments/charges?requestId=${made.body.data.requestId}`);
    expect(res.body.pagination.total).toBe(3);
    res = await authenticatedRequest('get', '/api/payments/charges?source=form');
    expect(res.body.pagination.total).toBe(0);
    res = await authenticatedRequest('get', `/api/payments/charges?studentId=${s.aisha}`);
    expect(res.body.data).toHaveLength(1);
    res = await authenticatedRequest('get', '/api/payments/charges?q=noor');
    expect(res.body.data.map((c) => c.studentName)).toEqual(['Noor Haddad']);
    const csv = await authenticatedRequest('get', '/api/payments/charges.csv?source=request');
    expect(csv.text.split('\n')[0]).toMatch(/^Date,For,Student,Grade,Email,Status/);
    expect(csv.text).toMatch(/Grade 5 museum trip,Aisha Khan,5,/);
  });
});

describe('the overview', () => {
  it('shows six months, each form and request with its progress, and the latest activity', async () => {
    const s = await seedStudents();
    await connectSchool();
    const made = await createRequest({ grades: ['5'] });
    const aisha = made.body.data.charges.find((c) => c.studentId === s.aisha);
    await authenticatedRequest('post', `/api/payments/charges/${aisha.chargeId}/offline`).send({ kind: 'cash', sendReceipt: false });

    const res = await authenticatedRequest('get', '/api/payments/overview');
    expect(res.status).toBe(200);
    const { summary, months, collections, activity } = res.body.data;
    expect(summary).toMatchObject({ collectedThisMonthCents: 3500, outstandingCents: 7000, outstandingCount: 2 });
    expect(months).toHaveLength(6);
    expect(months[5]).toMatchObject({ officeCents: 3500, cardCents: 0 });
    expect(collections).toEqual([expect.objectContaining({
      source: 'request', title: 'Grade 5 museum trip',
      stats: expect.objectContaining({ count: 3, settled: 1, open: 2, collectedCents: 3500, outstandingCents: 7000 }),
    })]);
    expect(activity).toEqual([expect.objectContaining({ kind: 'cash', amountCents: 3500, title: 'Grade 5 museum trip', studentName: 'Aisha Khan', paidWith: 'Cash' })]);
  });

  it('works the months out in school time', () => {
    const { recentMonths } = require('../../../controllers/payments.controller');
    // 03:00 UTC on 1 December is still 30 November in Toronto.
    const { months, from } = recentMonths(new Date('2026-12-01T03:00:00Z'));
    expect(months).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(from.toISOString()).toBe('2026-06-01T04:00:00.000Z');
  });
});

describe('the parent’s payments page', () => {
  it('is off unless switched on', async () => {
    const res = await asParent('get', '/api/parent-portal/payments');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_ENABLED');
  });

  it('lists what the family owes and what it paid, never a waiver as such', async () => {
    process.env.PARENT_PAYMENTS_ENABLED = 'true';
    const s = await seedStudents();
    await connectSchool();
    const trip = await createRequest({ studentIds: [s.aisha, s.omar] });
    const books = await createRequest({ studentIds: [s.aisha], title: 'Books', amountCents: 2000 });
    await authenticatedRequest('post', `/api/payments/charges/${books.body.data.charges[0].chargeId}/waive`).send({});

    const res = await asParent('get', '/api/parent-portal/payments');
    expect(res.status).toBe(200);
    expect(res.body.data.totalOwingCents).toBe(3500);
    expect(res.body.data.owing).toEqual([expect.objectContaining({
      title: 'Grade 5 museum trip', studentName: 'Aisha Khan', balanceCents: 3500, dueDate: '2026-12-12', canPayOnline: true,
    })]);
    expect(res.body.data.owing[0].payPath).toMatch(/^\/pay\/[0-9a-f-]{36}$/);
    expect(res.body.data.history).toEqual([expect.objectContaining({ title: 'Books', status: 'settled' })]);
    // Omar isn't theirs.
    expect(JSON.stringify(res.body.data)).not.toMatch(/Omar/);
    expect(trip.status).toBe(201);
  });
});
