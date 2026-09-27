// Finance → Tuition against the real schema: the migration DDL, the grid SQL
// and the family detail SQL, exercised end to end with rows inserted directly.
jest.mock('../../../services/finance/qboAuth', () => {
  const actual = jest.requireActual('../../../services/finance/qboAuth');
  return { ...actual, disconnect: jest.fn().mockResolvedValue({ connection_id: 'x' }) };
});

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

process.env.QBO_TOKEN_ENC_KEY = process.env.QBO_TOKEN_ENC_KEY || Buffer.alloc(32, 5).toString('base64');

const SCHOOL = 'ALHAADIACADEMY';
const REALM = '9130351374400296';

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';

// The JWT's user must exist: finance_sync_jobs.requested_by is a real FK.
async function seedAdminUser(pool) {
  await pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, 'admin@test.com', 'admin', 'x', 'Test', 'Admin', $2, 'ADMIN', true, true) ON CONFLICT (user_id) DO NOTHING`,
    [ADMIN_ID, SCHOOL],
  );
}

async function seedConnection(pool) {
  await pool.query(
    `INSERT INTO finance_qbo_connections (school, realm_id, company_name, refresh_token, status, backfill_completed_at, last_success_at, cdc_cursor)
     VALUES ($1, $2, 'Al Haadi Academy', 'enc', 'active', now(), now(), now())`,
    [SCHOOL, REALM],
  );
}

async function activeYear(pool) {
  const { rows } = await pool.query(`SELECT school_year_id, start_date FROM school_years WHERE school = $1 AND is_active`, [SCHOOL]);
  return rows[0];
}

async function seedFamily(pool, yearId, { name = 'Rania Saleh', customer = '670', students = [] } = {}) {
  const { rows: fam } = await pool.query(
    `INSERT INTO families (school, school_year_id, name, is_subsidy, expected_monthly_parent, roster_family_no)
     VALUES ($1, $2, $3, true, 500, 25) RETURNING family_id`,
    [SCHOOL, yearId, name],
  );
  const familyId = fam[0].family_id;
  await pool.query(`INSERT INTO family_customer_links (school, family_id, school_year_id, qbo_customer_id, effective_from) VALUES ($1, $2, $3, $4, '2025-08-01')`, [SCHOOL, familyId, yearId, customer]);
  for (const s of students) {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade, school_year_id) VALUES ($1, $2, $3, $4) RETURNING student_id`,
      [s.name, SCHOOL, s.grade, yearId],
    );
    await pool.query(`INSERT INTO family_students (family_id, student_id) VALUES ($1, $2)`, [familyId, rows[0].student_id]);
  }
  await pool.query(
    `INSERT INTO family_contacts (family_id, name, email, relation, is_primary, source) VALUES ($1, 'Rania Saleh', 'rania@example.com', 'mother', true, 'roster')`,
    [familyId],
  );
  return familyId;
}

async function seedCustomer(pool, id, name) {
  await pool.query(
    `INSERT INTO qbo_customers (school, realm_id, qbo_id, display_name, emails, last_updated_time, raw)
     VALUES ($1, $2, $3, $4, '{}', now(), '{}'::jsonb)`,
    [SCHOOL, REALM, id, name],
  );
}

async function seedInvoice(pool, { id, customer, docNumber = null, txnDate, dueDate, total, balance, kind = 'parent', privateNote = null }) {
  await pool.query(
    `INSERT INTO qbo_invoices (school, realm_id, qbo_id, doc_number, customer_qbo_id, txn_date, due_date, total_amt, balance, email_status, private_note, last_updated_time, kind_auto, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'EmailSent', $10, now(), $11, '{}'::jsonb)`,
    [SCHOOL, REALM, id, docNumber, customer, txnDate, dueDate, total, balance, privateNote, kind],
  );
  await pool.query(
    `INSERT INTO qbo_invoice_lines (school, invoice_qbo_id, line_num, detail_type, description, amount, item_ref) VALUES ($1, $2, 1, 'SalesItemLineDetail', 'Tuition', $3, '4')`,
    [SCHOOL, id, total],
  );
}

async function seedPayment(pool, { id, customer, txnDate, amount, invoiceId }) {
  await pool.query(
    `INSERT INTO qbo_payments (school, realm_id, qbo_id, customer_qbo_id, txn_date, total_amt, unapplied_amt, last_updated_time, raw)
     VALUES ($1, $2, $3, $4, $5, $6, 0, now(), '{}'::jsonb)`,
    [SCHOOL, REALM, id, customer, txnDate, amount],
  );
  await pool.query(`INSERT INTO qbo_payment_applications (school, payment_qbo_id, invoice_qbo_id, amount) VALUES ($1, $2, $3, $4)`, [SCHOOL, id, invoiceId, amount]);
}

describe('finance routes (integration)', () => {
  it('rejects teachers', async () => {
    const res = await authenticatedRequest('get', '/api/finance/tuition/grid', { role: 'TEACHER' });
    expect(res.status).toBe(403);
  });

  it('reports not connected on a fresh school', async () => {
    const res = await authenticatedRequest('get', '/api/finance/qbo/connection', {});
    expect(res.status).toBe(200);
    expect(res.body.data.connected).toBe(false);
  });

  it('builds the grid from cached invoices joined through the family links', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    await seedConnection(pool);
    await seedCustomer(pool, '670', 'Rania Saleh');
    await seedCustomer(pool, '999', 'Unknown Donor');
    const familyId = await seedFamily(pool, year.school_year_id, { students: [{ name: 'Omar Saleh', grade: '4' }, { name: 'Dana Saleh', grade: '7' }] });
    // Extra student with no family → counted.
    await pool.query(`INSERT INTO students (name, school, grade, school_year_id) VALUES ('Lonely Student', $1, '3', $2)`, [SCHOOL, year.school_year_id]);

    await seedInvoice(pool, { id: '1', customer: '670', docNumber: '9506', txnDate: '2025-09-01', dueDate: '2025-10-01', total: 900, balance: 0 });
    await seedInvoice(pool, { id: '2', customer: '670', docNumber: '9507', txnDate: '2025-09-01', dueDate: '2025-10-01', total: 500, balance: 500, kind: 'subsidy_grant', privateNote: "Al-Ma'arif subsidy portion" });
    await seedInvoice(pool, { id: '3', customer: '670', txnDate: '2025-10-01', dueDate: '2025-10-31', total: 500, balance: 500 });
    await seedInvoice(pool, { id: '4', customer: '999', docNumber: '9600', txnDate: '2025-11-01', dueDate: '2025-12-01', total: 75, balance: 75 });
    await seedPayment(pool, { id: '22001', customer: '670', txnDate: '2025-09-20', amount: 900, invoiceId: '1' });

    const res = await authenticatedRequest('get', '/api/finance/tuition/grid', {});
    expect(res.status).toBe(200);
    const g = res.body.data;
    expect(g.months[0]).toBe('2025-09');
    expect(g.months).toHaveLength(10);
    expect(g.sync).toMatchObject({ connected: true, status: 'active' });

    const fam = g.families.find((f) => f.familyId === familyId);
    expect(fam.students.map((s) => s.name).sort()).toEqual(['Dana Saleh', 'Omar Saleh']);
    expect(fam.contacts[0]).toMatchObject({ email: 'rania@example.com', isPrimary: true });
    expect(fam.customer).toMatchObject({ qboId: '670', displayName: 'Rania Saleh' });
    expect(fam.parent.cells['2025-09']).toMatchObject({ status: 'paid', invoiced: 900, paid: 900, balance: 0 });
    expect(fam.parent.cells['2025-09'].payments[0]).toMatchObject({ paymentId: '22001', amount: 900, date: '2025-09-20' });
    expect(fam.parent.cells['2025-10'].invoices[0].docNumber).toBeNull();
    expect(fam.parent.totals).toMatchObject({ invoiced: 1400, paid: 900, balance: 500 });
    expect(g.grant.cells['2025-09']).toMatchObject({ invoiced: 500, balance: 500 });
    expect(g.grant.byFamily[0].familyId).toBe(familyId);
    expect(g.summary).toMatchObject({ familiesTotal: 1, subsidyReceivable: 500, unlinkedCustomersWithInvoices: 1, unlinkedInvoiceTotal: 75, studentsWithoutFamily: 1 });
    expect(g.unlinked.customers[0]).toMatchObject({ qboId: '999', displayName: 'Unknown Donor' });
  });

  it('returns the family detail with invoices, lines, payments and links', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    await seedConnection(pool);
    await seedCustomer(pool, '670', 'Rania Saleh');
    const familyId = await seedFamily(pool, year.school_year_id, { students: [{ name: 'Omar Saleh', grade: '4' }] });
    await seedInvoice(pool, { id: '1', customer: '670', docNumber: '9506', txnDate: '2025-09-01', dueDate: '2025-10-01', total: 500, balance: 200 });
    await seedPayment(pool, { id: '22001', customer: '670', txnDate: '2025-09-20', amount: 300, invoiceId: '1' });
    await pool.query(
      `INSERT INTO family_link_audit (school, school_year_id, family_id, family_name, action, new_qbo_customer_id) VALUES ($1, $2, $3, 'Rania Saleh', 'seed', '670')`,
      [SCHOOL, year.school_year_id, familyId],
    );

    const res = await authenticatedRequest('get', `/api/finance/families/${familyId}`, {});
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.family).toMatchObject({ familyId, name: 'Rania Saleh', isSubsidy: true, expectedMonthlyParent: 500 });
    expect(d.customerLinks[0]).toMatchObject({ qboCustomerId: '670', customerName: 'Rania Saleh', current: true, effectiveFrom: '2025-08-01' });
    expect(d.invoices[0]).toMatchObject({ qboId: '1', docNumber: '9506', month: '2025-09', total: 500, balance: 200, kind: 'parent' });
    expect(d.invoices[0].lines[0]).toMatchObject({ description: 'Tuition', amount: 500 });
    expect(d.invoices[0].payments[0]).toMatchObject({ paymentId: '22001', amount: 300 });
    expect(d.ledger.parent.cells['2025-09']).toMatchObject({ invoiced: 500, paid: 300, balance: 200 });
    expect(d.audit[0].action).toBe('seed');
  });

  it('404s a family from another school', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT (school_code) DO NOTHING`);
    const { rows: py } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'PLAYGROUND' AND is_active`);
    const { rows } = await pool.query(
      `INSERT INTO families (school, school_year_id, name) VALUES ('PLAYGROUND', $1, 'Other') RETURNING family_id`, [py[0].school_year_id],
    );
    const res = await authenticatedRequest('get', `/api/finance/families/${rows[0].family_id}`, {});
    expect(res.status).toBe(404);
  });

  it('enforces one open link per customer and same-year students', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    const a = await seedFamily(pool, year.school_year_id, { name: 'A', customer: '670' });
    const { rows: b } = await pool.query(`INSERT INTO families (school, school_year_id, name) VALUES ($1, $2, 'B') RETURNING family_id`, [SCHOOL, year.school_year_id]);
    await expect(pool.query(`INSERT INTO family_customer_links (school, family_id, school_year_id, qbo_customer_id, effective_from) VALUES ($1, $2, $3, '670', '2025-08-01')`, [SCHOOL, b[0].family_id, year.school_year_id]))
      .rejects.toMatchObject({ code: '23505' });
    // Closing A's link frees the customer.
    await pool.query(`UPDATE family_customer_links SET effective_to = '2025-12-31' WHERE family_id = $1`, [a]);
    await pool.query(`INSERT INTO family_customer_links (school, family_id, school_year_id, qbo_customer_id, effective_from) VALUES ($1, $2, $3, '670', '2026-01-01')`, [SCHOOL, b[0].family_id, year.school_year_id]);

    // A student from a different year cannot join.
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT (school_code) DO NOTHING`);
    const { rows: py } = await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'PLAYGROUND' AND is_active`);
    const { rows: s } = await pool.query(`INSERT INTO students (name, school, grade, school_year_id) VALUES ('Elsewhere', 'PLAYGROUND', '2', $1) RETURNING student_id`, [py[0].school_year_id]);
    await expect(pool.query(`INSERT INTO family_students (family_id, student_id) VALUES ($1, $2)`, [a, s[0].student_id])).rejects.toMatchObject({ code: '23514' });
  });

  it('queues a manual sync and reports it in the status', async () => {
    const pool = getTestPool();
    await seedAdminUser(pool);
    await seedConnection(pool);
    const first = await authenticatedRequest('post', '/api/finance/sync', {});
    expect(first.status).toBe(202);
    expect(first.body.data.alreadyQueued).toBe(false);
    const second = await authenticatedRequest('post', '/api/finance/sync', {});
    expect(second.status).toBe(202);
    expect(second.body.data).toMatchObject({ jobId: first.body.data.jobId, alreadyQueued: true });
    const status = await authenticatedRequest('get', '/api/finance/sync/status', {});
    expect(status.body.data.job).toMatchObject({ kind: 'manual', state: 'pending' });
    expect(status.body.data.pendingSync).toBe(true);
  });
});

describe('finance families CRUD (integration)', () => {
  const create = (body) => authenticatedRequest('post', '/api/finance/families', {}).send(body);

  it('creates, links, relinks, unlinks and deletes a family, auditing each step', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    await seedAdminUser(pool);
    await seedConnection(pool);
    await seedCustomer(pool, '670', 'Rania Saleh');
    await seedCustomer(pool, '671', 'Rania S.');
    const { rows: st } = await pool.query(`INSERT INTO students (name, school, grade, school_year_id) VALUES ('Omar Saleh', $1, '4', $2) RETURNING student_id`, [SCHOOL, year.school_year_id]);
    const studentId = st[0].student_id;

    const created = await create({ name: 'Rania Saleh', studentIds: [studentId], qboCustomerId: '670', isSubsidy: true, expectedMonthlyParent: 500,
      contacts: [{ name: 'Rania Saleh', email: 'Rania@Example.com', relation: 'mother', isPrimary: true }, { name: 'Second Parent', email: 'second@example.com' }] });
    expect(created.status).toBe(201);
    const fid = created.body.data.familyId;
    expect(created.body.data).toMatchObject({ customer: { qboId: '670' }, students: [{ studentId }] });
    expect(created.body.data.contacts.find((c) => c.isPrimary).email).toBe('rania@example.com');

    // The same customer cannot bill a second family.
    const dup = await create({ name: 'Dup', qboCustomerId: '670' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CUSTOMER_LINKED');
    // Nor can a student join a second family.
    const dupStudent = await create({ name: 'Dup2', studentIds: [studentId] });
    expect(dupStudent.status).toBe(409);
    expect(dupStudent.body.code).toBe('STUDENT_IN_FAMILY');
    const { rows: leftover } = await pool.query(`SELECT count(*)::int AS n FROM families WHERE name IN ('Dup', 'Dup2')`);
    expect(leftover[0].n).toBe(0); // rolled back

    // The first link starts at the connection's backfill date (default 2026-08-01); a
    // replacement dated before that is refused, one after it closes the old link the day before.
    const tooEarly = await authenticatedRequest('put', `/api/finance/families/${fid}/customer`, {}).send({ qboCustomerId: '671', effectiveFrom: '2025-11-01' });
    expect(tooEarly.status).toBe(400);
    const relinked = await authenticatedRequest('put', `/api/finance/families/${fid}/customer`, {}).send({ qboCustomerId: '671', effectiveFrom: '2026-11-01' });
    expect(relinked.status).toBe(200);
    expect(relinked.body.data.customer.qboId).toBe('671');
    const { rows: links } = await pool.query(`SELECT qbo_customer_id, effective_from::text, effective_to::text FROM family_customer_links WHERE family_id = $1 ORDER BY effective_from`, [fid]);
    expect(links).toEqual([
      { qbo_customer_id: '670', effective_from: '2026-08-01', effective_to: '2026-10-31' },
      { qbo_customer_id: '671', effective_from: '2026-11-01', effective_to: null },
    ]);

    const unlinked = await authenticatedRequest('delete', `/api/finance/families/${fid}/customer`, {});
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data.customer).toBeNull();

    const patched = await authenticatedRequest('patch', `/api/finance/families/${fid}`, {}).send({ notes: 'call before month end', expectedMonthlyParent: 750 });
    expect(patched.body.data).toMatchObject({ notes: 'call before month end', expectedMonthlyParent: 750 });

    const contacts = await authenticatedRequest('post', `/api/finance/families/${fid}/contacts`, {}).send({ email: 'rania@example.com' });
    expect(contacts.status).toBe(409); // duplicate email on the same family

    const { rows: audit } = await pool.query(`SELECT action FROM family_link_audit WHERE family_id = $1 ORDER BY created_at`, [fid]);
    expect(audit.map((a) => a.action)).toEqual(['family_create', 'customer_link', 'customer_unlink', 'family_update']);

    const deleted = await authenticatedRequest('delete', `/api/finance/families/${fid}`, {});
    expect(deleted.status).toBe(200);
    const { rows: gone } = await pool.query(`SELECT count(*)::int AS n FROM family_students WHERE family_id = $1`, [fid]);
    expect(gone[0].n).toBe(0);
    const { rows: snapshot } = await pool.query(`SELECT family_name FROM family_link_audit WHERE action = 'family_delete' AND family_id = $1`, [fid]);
    expect(snapshot[0].family_name).toBe('Rania Saleh');
  });

  it('overrides an invoice kind and exports the CSV', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    await seedAdminUser(pool);
    await seedConnection(pool);
    await seedCustomer(pool, '670', 'Rania Saleh');
    await seedFamily(pool, year.school_year_id, { students: [{ name: 'Omar Saleh', grade: '4' }] });
    await seedInvoice(pool, { id: '1', customer: '670', docNumber: '9506', txnDate: '2025-09-01', dueDate: '2025-10-01', total: 500, balance: 500 });

    const over = await authenticatedRequest('patch', '/api/finance/invoices/1/kind', {}).send({ kind: 'subsidy_grant' });
    expect(over.status).toBe(200);
    expect(over.body.data).toMatchObject({ kindAuto: 'parent', kindOverride: 'subsidy_grant', kind: 'subsidy_grant' });
    const grid = await authenticatedRequest('get', '/api/finance/tuition/grid', {});
    expect(grid.body.data.grant.cells['2025-09'].invoiced).toBe(500);

    const cleared = await authenticatedRequest('patch', '/api/finance/invoices/1/kind', {}).send({ kind: null });
    expect(cleared.body.data.kind).toBe('parent');

    const csv = await authenticatedRequest('get', '/api/finance/tuition/grid.csv', {});
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[1]).toMatch(/^Rania Saleh,Omar Saleh \(4\),rania@example\.com,Rania Saleh,yes,no,/);
  });

  it('lists customers, suggestions and anomalies', async () => {
    const pool = getTestPool();
    const year = await activeYear(pool);
    await seedConnection(pool);
    await seedCustomer(pool, '670', 'Rania Saleh');
    await seedCustomer(pool, '999', 'Unknown Donor');
    await pool.query(`UPDATE qbo_customers SET emails = '{rania@example.com}' WHERE qbo_id = '670'`);
    const { rows: fam } = await pool.query(`INSERT INTO families (school, school_year_id, name) VALUES ($1, $2, 'Rania Saleh') RETURNING family_id`, [SCHOOL, year.school_year_id]);
    await pool.query(`INSERT INTO family_contacts (family_id, name, email, is_primary, source) VALUES ($1, 'Rania Saleh', 'rania@example.com', true, 'manual')`, [fam[0].family_id]);
    await pool.query(`INSERT INTO students (name, school, grade, school_year_id, mother_email) VALUES ('Zayn Saleh', $1, '2', $2, 'rania@example.com')`, [SCHOOL, year.school_year_id]);
    await seedInvoice(pool, { id: '4', customer: '999', docNumber: '9600', txnDate: '2025-11-01', dueDate: '2025-12-01', total: 75, balance: 75 });

    const customers = await authenticatedRequest('get', '/api/finance/qbo/customers?q=rania', {});
    expect(customers.body.data.customers.map((c) => c.qboId)).toEqual(['670']);
    const withInv = await authenticatedRequest('get', '/api/finance/qbo/customers?withInvoices=true', {});
    expect(withInv.body.data.customers.map((c) => c.qboId)).toEqual(['999']);
    expect(withInv.body.data.customers[0]).toMatchObject({ invoiceCount: 1, invoiceTotal: 75, openBalance: 75, linkedFamilyId: null });

    const sugg = await authenticatedRequest('get', '/api/finance/families/suggestions', {});
    expect(sugg.status).toBe(200);
    expect(sugg.body.data.unlinkedFamilies[0].candidates[0]).toMatchObject({ qboId: '670', reason: 'email' });
    expect(sugg.body.data.unlinkedCustomers[0]).toMatchObject({ qboId: '999', invoiceTotal: 75 });
    expect(sugg.body.data.studentsWithoutFamily[0]).toMatchObject({ name: 'Zayn Saleh', suggestedFamilyId: fam[0].family_id });

    const anomalies = await authenticatedRequest('get', '/api/finance/tuition/anomalies', {});
    expect(anomalies.body.data.unlinkedCustomers[0].qboId).toBe('999');
    expect(anomalies.body.data.studentsWithoutFamily).toHaveLength(1);
  });
});
