const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_ADMIN_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const db = require('../../__mocks__/config/database');

process.env.QBO_TOKEN_ENC_KEY = Buffer.alloc(32, 5).toString('base64');

let app;
beforeAll(() => { app = getApp(); });
const admin = () => ({ Authorization: `Bearer ${mockAdminUser()}` });
const FID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const CID = '33333333-3333-4333-8333-333333333333';
const YEAR = db.DEFAULT_SCHOOL_YEAR_ID;

const familyRow = (over = {}) => ({ family_id: FID, school: TEST_SCHOOL, school_year_id: YEAR, name: 'Rania Saleh', is_subsidy: true, is_teacher: false,
  expected_monthly_parent: '500.00', expected_monthly_subsidy: '500.00', notes: null, roster_family_no: 25, created_at: 'c', updated_at: 'u', ...over });

/**
 * SQL-dispatching DB double; each test overrides what it needs.
 * A write statement (INSERT/UPDATE/DELETE) only matches handlers whose pattern
 * names that verb, so a broad read pattern like 'FROM students' can never
 * swallow the `INSERT INTO family_students … SELECT … FROM students` write.
 */
function fakeDb(handlers = {}) {
  const calls = [];
  const dispatch = async (sql, params) => {
    calls.push({ sql, params });
    const verb = sql.trim().split(/\s+/)[0].toUpperCase();
    const isWrite = ['INSERT', 'UPDATE', 'DELETE'].includes(verb);
    for (const [re, fn] of Object.entries(handlers)) {
      if (isWrite && !re.startsWith(verb)) continue;
      if (new RegExp(re).test(sql)) return typeof fn === 'function' ? fn(params, sql) : fn;
    }
    if (/FROM school_years/.test(sql)) return { rows: [{ school_year_id: YEAR, school: TEST_SCHOOL, label: '2025-2026', start_date: '2025-09-01', end_date: '2026-06-30', is_active: true }] };
    if (/FROM finance_qbo_connections/.test(sql)) return { rows: [{ status: 'active', settings: {} }] };
    if (/FROM families/.test(sql)) return { rows: [familyRow()] };
    if (/FROM family_students/.test(sql)) return { rows: [] };
    if (/FROM family_contacts/.test(sql)) return { rows: [] };
    if (/FROM family_customer_links/.test(sql)) return { rows: [] };
    if (/FROM qbo_customers/.test(sql)) return { rows: [{ qbo_id: '670', display_name: 'Rania Saleh', is_sub_customer: false, active: true, emails: [] }] };
    return { rows: [], rowCount: 0 };
  };
  db.query.mockImplementation(dispatch);
  db._mockClient.query.mockImplementation(dispatch);
  const find = (re) => calls.filter((c) => new RegExp(re).test(c.sql));
  return { calls, find };
}

describe('finance families — auth', () => {
  it('rejects non-admins', async () => {
    const res = await request(app).post('/api/finance/families').set({ Authorization: `Bearer ${mockTeacherUser()}` }).send({ name: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/finance/families', () => {
  it('lists families with students, contacts and current customer, filtered by linked state', async () => {
    fakeDb({
      'FROM families': { rows: [familyRow(), familyRow({ family_id: CID, name: 'Maha Younes', roster_family_no: 32 })] },
      'FROM family_students': { rows: [{ family_id: FID, student_id: SID, name: 'Omar Saleh', grade: '4', is_archived: false }] },
      'FROM family_contacts': { rows: [{ contact_id: 'c1', family_id: FID, name: 'Rania Saleh', email: 'rania@example.com', phone: null, relation: 'mother', is_primary: true, user_id: null, source: 'roster' }] },
      'FROM family_customer_links': { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '670', effective_from: '2025-08-01', effective_to: null }] },
    });
    const res = await request(app).get('/api/finance/families?linked=unlinked').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data.families.map((f) => f.name)).toEqual(['Maha Younes']);

    const all = await request(app).get('/api/finance/families').set(admin());
    const fa = all.body.data.families.find((f) => f.familyId === FID);
    expect(fa).toMatchObject({ name: 'Rania Saleh', isSubsidy: true, expectedMonthlyParent: 500, customer: { qboId: '670', displayName: 'Rania Saleh' } });
    expect(fa.students[0]).toMatchObject({ studentId: SID, name: 'Omar Saleh' });
    expect(fa.contacts[0]).toMatchObject({ email: 'rania@example.com', isPrimary: true, hasAccount: false, source: 'roster' });
  });
});

describe('POST /api/finance/families', () => {
  it('validates the name', async () => {
    fakeDb();
    const res = await request(app).post('/api/finance/families').set(admin()).send({ name: '  ' });
    expect(res.status).toBe(400);
  });

  it('creates the family, links students and customer, writes contacts and an audit row in one transaction', async () => {
    const d = fakeDb({
      'INSERT INTO families': { rows: [familyRow({ name: 'New Family', roster_family_no: null })] },
      'FROM families': { rows: [familyRow({ name: 'New Family', roster_family_no: null })] },
      'INSERT INTO family_students': { rows: [{ student_id: SID }], rowCount: 1 },
      'INSERT INTO family_contacts': { rows: [{ contact_id: 'c9' }], rowCount: 1 },
      'INSERT INTO family_customer_links': { rows: [{ link_id: 'l9' }] },
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2[\\s\\S]*effective_to IS NULL': { rows: [] },
    });
    const res = await request(app).post('/api/finance/families').set(admin()).send({
      name: 'New Family', studentIds: [SID], qboCustomerId: '670', isSubsidy: false,
      contacts: [{ name: 'Parent One', email: 'one@example.com', relation: 'mother', isPrimary: true }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ familyId: FID, name: 'New Family' });
    const sqls = d.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(d.find('INSERT INTO families')[0].params.slice(0, 3)).toEqual([TEST_SCHOOL, YEAR, 'New Family']);
    expect(d.find('INSERT INTO family_students')[0].params).toEqual([FID, SID]);
    expect(d.find('INSERT INTO family_customer_links')[0].params.slice(0, 3)).toEqual([TEST_SCHOOL, FID, '670']);
    expect(d.find('INSERT INTO family_contacts')).toHaveLength(1);
    const audit = d.find('INSERT INTO family_link_audit')[0];
    expect(audit.params).toEqual(expect.arrayContaining(['family_create', TEST_ADMIN_USER_ID]));
  });

  it('409s with CUSTOMER_LINKED when the customer already bills another family', async () => {
    fakeDb({
      'INSERT INTO families': { rows: [familyRow()] },
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2': { rows: [{ family_id: CID, name: 'Maha Younes' }] },
    });
    const res = await request(app).post('/api/finance/families').set(admin()).send({ name: 'Dup', qboCustomerId: '670' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_LINKED');
    expect(res.body.message).toMatch(/Maha Younes/);
  });

  it('400s on an unknown QuickBooks customer', async () => {
    fakeDb({ 'INSERT INTO families': { rows: [familyRow()] }, 'FROM qbo_customers': { rows: [] } });
    const res = await request(app).post('/api/finance/families').set(admin()).send({ name: 'X', qboCustomerId: '12345' });
    expect(res.status).toBe(400);
  });

  it('409s with STUDENT_IN_FAMILY when a student already belongs elsewhere', async () => {
    fakeDb({
      'INSERT INTO families': { rows: [familyRow()] },
      'INSERT INTO family_students': { rows: [], rowCount: 0 },
      'SELECT f\\.family_id, f\\.name FROM family_students': { rows: [{ family_id: CID, name: 'Maha Younes' }] },
    });
    const res = await request(app).post('/api/finance/families').set(admin()).send({ name: 'X', studentIds: [SID] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'STUDENT_IN_FAMILY', studentId: SID });
    expect(db._mockClient.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
  });
});

describe('PATCH / DELETE /api/finance/families/:id', () => {
  it('updates editable fields and audits', async () => {
    const d = fakeDb({ 'UPDATE families': { rows: [familyRow({ name: 'Renamed', notes: 'n' })] }, 'FROM families': { rows: [familyRow({ name: 'Renamed', notes: 'n' })] } });
    const res = await request(app).patch(`/api/finance/families/${FID}`).set(admin()).send({ name: 'Renamed', notes: 'n', expectedMonthlyParent: 750 });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
    expect(d.find('UPDATE families')[0].params).toContain(750);
    expect(d.find('INSERT INTO family_link_audit')[0].params).toContain('family_update');
  });

  it('rejects an empty patch and bad amounts', async () => {
    fakeDb();
    expect((await request(app).patch(`/api/finance/families/${FID}`).set(admin()).send({})).status).toBe(400);
    expect((await request(app).patch(`/api/finance/families/${FID}`).set(admin()).send({ expectedMonthlyParent: -1 })).status).toBe(400);
  });

  it('404s for a family of another school', async () => {
    fakeDb({ 'FROM families': { rows: [] } });
    expect((await request(app).patch(`/api/finance/families/${FID}`).set(admin()).send({ name: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/finance/families/${FID}`).set(admin())).status).toBe(404);
  });

  it('deletes the family and audits with a snapshot', async () => {
    const d = fakeDb({ 'DELETE FROM families': { rows: [{ family_id: FID }], rowCount: 1 } });
    const res = await request(app).delete(`/api/finance/families/${FID}`).set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });
    const audit = d.find('INSERT INTO family_link_audit')[0];
    expect(audit.params).toContain('family_delete');
    expect(audit.params).toContain('Rania Saleh');
  });
});

describe('customer link / unlink', () => {
  it('closes the open link and opens a new one, auditing old and new ids', async () => {
    const d = fakeDb({
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2': { rows: [] },
      'FROM family_customer_links': { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '172', effective_from: '2025-08-01', effective_to: null }] },
      'UPDATE family_customer_links': { rows: [{ link_id: 'l1' }], rowCount: 1 },
      'INSERT INTO family_customer_links': { rows: [{ link_id: 'l2' }] },
    });
    const res = await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670', effectiveFrom: '2025-11-01' });
    expect(res.status).toBe(200);
    const close = d.find('UPDATE family_customer_links[\\s\\S]*effective_to')[0];
    expect(close.params).toEqual(expect.arrayContaining(['l1', '2025-10-31']));
    expect(d.find('INSERT INTO family_customer_links')[0].params.slice(0, 4)).toEqual([TEST_SCHOOL, FID, '670', '2025-11-01']);
    const audit = d.find('INSERT INTO family_link_audit')[0];
    expect(audit.params).toEqual(expect.arrayContaining(['customer_link', '172', '670']));
  });

  it('runs the relink in one transaction and rolls back when the new link collides', async () => {
    const d = fakeDb({
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2': { rows: [] },
      'FROM family_customer_links': { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '172', effective_from: '2025-08-01', effective_to: null }] },
      'UPDATE family_customer_links': { rows: [{ link_id: 'l1' }], rowCount: 1 },
      'INSERT INTO family_customer_links': () => { const e = new Error('dup'); e.code = '23505'; e.constraint = 'uq_fcl_open_per_customer'; throw e; },
    });
    const res = await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_LINKED');
    const sqls = d.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('replace mode deletes the wrong link and re-opens from its original start date', async () => {
    const d = fakeDb({
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2': { rows: [] },
      'FROM family_customer_links': { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '172', effective_from: '2025-08-01', effective_to: null }] },
      'DELETE FROM family_customer_links': { rows: [{ link_id: 'l1' }], rowCount: 1 },
      'INSERT INTO family_customer_links': { rows: [{ link_id: 'l2' }] },
    });
    const res = await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670', replace: true });
    expect(res.status).toBe(200);
    expect(d.find('DELETE FROM family_customer_links')[0].params).toEqual(['l1']);
    expect(d.find('UPDATE family_customer_links')).toHaveLength(0);
    expect(d.find('INSERT INTO family_customer_links')[0].params.slice(0, 4)).toEqual([TEST_SCHOOL, FID, '670', '2025-08-01']);
    const audit = d.find('INSERT INTO family_link_audit')[0];
    expect(audit.params).toEqual(expect.arrayContaining(['customer_link', '172', '670']));
    expect(audit.params.find((p) => typeof p === 'string' && p.startsWith('{'))).toMatch(/"replaced":true/);
  });

  it('starts a first link after the customer\'s latest closed link, and refuses an overlapping start date', async () => {
    const d = fakeDb({
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2[\\s\\S]*effective_to IS NULL': { rows: [] },
      'MAX\\(effective_to\\)': { rows: [{ latest_to: '2025-10-15' }] },
      'FROM family_customer_links': { rows: [] },
      'INSERT INTO family_customer_links': { rows: [{ link_id: 'l2' }] },
    });
    const res = await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670' });
    expect(res.status).toBe(200);
    expect(d.find('INSERT INTO family_customer_links')[0].params[3]).toBe('2025-10-16');

    fakeDb({
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2[\\s\\S]*effective_to IS NULL': { rows: [] },
      'MAX\\(effective_to\\)': { rows: [{ latest_to: '2025-10-15' }] },
      'FROM family_customer_links': { rows: [] },
    });
    const overlap = await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670', effectiveFrom: '2025-10-01' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('LINK_OVERLAP');
    expect(overlap.body.message).toMatch(/2025-10-16/);
  });

  it('checks the open link within the school year, not across years', async () => {
    const d = fakeDb({
      'SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2': { rows: [] },
      'FROM family_customer_links': { rows: [] },
      'INSERT INTO family_customer_links': { rows: [{ link_id: 'l2' }] },
    });
    await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670' });
    const check = d.find('SELECT .*FROM family_customer_links[\\s\\S]*qbo_customer_id = \\$2')[0];
    expect(check.sql).toMatch(/school_year_id = \$3/);
    expect(check.params).toEqual([TEST_SCHOOL, '670', YEAR]);
  });

  it('rejects an id that is not a QuickBooks id or a bad date', async () => {
    fakeDb();
    expect((await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: 'abc' })).status).toBe(400);
    expect((await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670', effectiveFrom: '2025-1-1' })).status).toBe(400);
    expect((await request(app).put(`/api/finance/families/${FID}/customer`).set(admin()).send({ qboCustomerId: '670', effectiveFrom: '2026-13-45' })).status).toBe(400);
  });

  it('unlinks by closing the open link as of today', async () => {
    const d = fakeDb({
      'FROM family_customer_links': { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '670', effective_from: '2025-08-01', effective_to: null }] },
      'UPDATE family_customer_links': { rows: [{ link_id: 'l1' }], rowCount: 1 },
    });
    const res = await request(app).delete(`/api/finance/families/${FID}/customer`).set(admin());
    expect(res.status).toBe(200);
    expect(d.find('UPDATE family_customer_links[\\s\\S]*effective_to')).toHaveLength(1);
    expect(d.find('INSERT INTO family_link_audit')[0].params).toEqual(expect.arrayContaining(['customer_unlink', '670']));
  });

  it('409s when there is nothing to unlink', async () => {
    fakeDb();
    expect((await request(app).delete(`/api/finance/families/${FID}/customer`).set(admin())).status).toBe(409);
  });
});

describe('students and contacts', () => {
  it('validates studentIds on create, and scopes the "already in a family" check to the school year', async () => {
    fakeDb({ 'INSERT INTO families': { rows: [familyRow()] } });
    expect((await request(app).post('/api/finance/families').set(admin()).send({ name: 'X', studentIds: ['abc'] })).status).toBe(400);
    const d = fakeDb({ 'INSERT INTO families': { rows: [familyRow()] }, 'INSERT INTO family_students': { rows: [], rowCount: 0 }, 'SELECT f\\.family_id, f\\.name FROM family_students': { rows: [] } });
    const res = await request(app).post('/api/finance/families').set(admin()).send({ name: 'X', studentIds: [SID, SID] });
    expect(res.status).toBe(400);
    const holder = d.find('SELECT f\\.family_id, f\\.name FROM family_students')[0];
    expect(holder.sql).toMatch(/f\.school = \$2 AND f\.school_year_id = \$3/);
    expect(holder.params).toEqual([SID, TEST_SCHOOL, YEAR]);
  });

  it('adds a student (400 when not in this school year) and removes one', async () => {
    const d = fakeDb({ 'INSERT INTO family_students': { rows: [{ student_id: SID }], rowCount: 1 } });
    const res = await request(app).post(`/api/finance/families/${FID}/students`).set(admin()).send({ studentId: SID });
    expect(res.status).toBe(200);
    expect(d.find('INSERT INTO family_link_audit')[0].params).toEqual(expect.arrayContaining(['student_add', SID]));

    fakeDb({ 'INSERT INTO family_students': { rows: [], rowCount: 0 }, 'SELECT f\\.family_id, f\\.name FROM family_students': { rows: [] } });
    expect((await request(app).post(`/api/finance/families/${FID}/students`).set(admin()).send({ studentId: SID })).status).toBe(400);

    const d2 = fakeDb({ 'DELETE FROM family_students': { rows: [{ student_id: SID }], rowCount: 1 } });
    expect((await request(app).delete(`/api/finance/families/${FID}/students/${SID}`).set(admin())).status).toBe(200);
    expect(d2.find('INSERT INTO family_link_audit')[0].params).toContain('student_remove');
  });

  it('creates, updates and deletes contacts, keeping a single primary', async () => {
    const d = fakeDb({ 'INSERT INTO family_contacts': { rows: [{ contact_id: CID }], rowCount: 1 } });
    const created = await request(app).post(`/api/finance/families/${FID}/contacts`).set(admin()).send({ name: 'Parent Two', email: 'Two@Example.com', relation: 'father', isPrimary: true });
    expect(created.status).toBe(201);
    expect(d.find('INSERT INTO family_contacts')[0].params).toContain('two@example.com');
    expect(d.find('is_primary = false')).toHaveLength(1);

    fakeDb();
    expect((await request(app).post(`/api/finance/families/${FID}/contacts`).set(admin()).send({ phone: '416' })).status).toBe(400);
    expect((await request(app).post(`/api/finance/families/${FID}/contacts`).set(admin()).send({ name: 'x', relation: 'cousin' })).status).toBe(400);

    const d3 = fakeDb({
      'FROM family_contacts WHERE family_id = \\$1 AND contact_id': { rows: [{ contact_id: CID, family_id: FID, name: 'Parent Two', email: 'two@example.com', phone: null, relation: 'father', is_primary: true, user_id: null, source: 'manual' }] },
      'UPDATE family_contacts[\\s\\S]*SET name': { rows: [{ contact_id: CID }], rowCount: 1 },
    });
    expect((await request(app).patch(`/api/finance/families/${FID}/contacts/${CID}`).set(admin()).send({ phone: '416-555-0100' })).status).toBe(200);
    expect(d3.find('INSERT INTO family_link_audit')[0].params).toContain('contact_update');

    const d4 = fakeDb({ 'DELETE FROM family_contacts': { rows: [{ contact_id: CID }], rowCount: 1 } });
    expect((await request(app).delete(`/api/finance/families/${FID}/contacts/${CID}`).set(admin())).status).toBe(200);
    expect(d4.find('INSERT INTO family_link_audit')[0].params).toContain('contact_remove');
  });

  it('404s when patching a contact that is not on this family', async () => {
    fakeDb({ 'FROM family_contacts WHERE family_id = \\$1 AND contact_id': { rows: [] } });
    const res = await request(app).patch(`/api/finance/families/${FID}/contacts/${CID}`).set(admin()).send({ phone: '1' });
    expect(res.status).toBe(404);
  });

  it('409s on a duplicate contact email', async () => {
    fakeDb({ 'INSERT INTO family_contacts': () => { const e = new Error('dup'); e.code = '23505'; throw e; } });
    const res = await request(app).post(`/api/finance/families/${FID}/contacts`).set(admin()).send({ email: 'dup@example.com' });
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/finance/invoices/:qboId/kind', () => {
  it('sets and clears the override', async () => {
    const d = fakeDb({
      'UPDATE qbo_invoices': { rows: [{ qbo_id: '21312', kind_auto: 'parent', kind_override: 'subsidy_grant', kind: 'subsidy_grant', customer_qbo_id: '670', txn_date: '2025-09-01' }], rowCount: 1 },
      'FROM family_customer_links': { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '670', effective_from: '2025-08-01', effective_to: '2025-09-30' }, { link_id: 'l2', family_id: CID, qbo_customer_id: '670', effective_from: '2025-10-01', effective_to: null }] },
    });
    const res = await request(app).patch('/api/finance/invoices/21312/kind').set(admin()).send({ kind: 'subsidy_grant' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ qboId: '21312', kindAuto: 'parent', kindOverride: 'subsidy_grant', kind: 'subsidy_grant' });
    expect(d.find('UPDATE qbo_invoices')[0].params).toEqual([TEST_SCHOOL, '21312', 'subsidy_grant', TEST_ADMIN_USER_ID]);
    expect(d.find('INSERT INTO family_link_audit')[0].params).toContain('invoice_kind_override');
    // The audit lands on the family whose link covered the invoice's date, not the customer's current link.
    expect(d.find('INSERT INTO family_link_audit')[0].params).toContain(FID);
    expect((await request(app).patch('/api/finance/invoices/21312/kind').set(admin()).send({ kind: 'bogus' })).status).toBe(400);
    expect((await request(app).patch('/api/finance/invoices/abc/kind').set(admin()).send({ kind: null })).status).toBe(404);
  });
});

describe('GET /api/finance/qbo/customers', () => {
  it('searches the cache and marks linked customers', async () => {
    fakeDb({
      'FROM qbo_customers': { rows: [
        { qbo_id: '670', display_name: 'Rania Saleh', fully_qualified_name: 'Rania Saleh', is_sub_customer: false, parent_qbo_id: null, active: true, emails: ['r@example.com'], linked_family_id: FID, linked_family_name: 'Rania Saleh', invoice_count: 2, invoice_total: '1400.00', open_balance: '500.00', earliest_invoice_date: '2025-09-01' },
      ] },
    });
    const res = await request(app).get('/api/finance/qbo/customers?q=rania').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data.customers[0]).toMatchObject({ qboId: '670', linkedFamilyId: FID, invoiceCount: 2, invoiceTotal: 1400, openBalance: 500, earliestInvoiceDate: '2025-09-01' });
    const q = db.query.mock.calls.find(([sql]) => /FROM qbo_customers/.test(sql));
    expect(q[1][0]).toBe(TEST_SCHOOL);
    expect(q[1]).toContain('%rania%');
  });
});

describe('POST /api/finance/families/import', () => {
  const roster = { families: [{ family_no: 1, primary_parent: 'Parent One', parents: ['Parent One'], emails: ['one@example.com'], children: [{ name: 'Kid One', grade: '3' }], monthly_parent_total: 500, monthly_subsidy_total: 0, is_subsidy: false, is_teacher: false }] };
  const csv = 'family_no,status,final_id,note\n1,AUTO,991,\n';

  it('dry-runs inside a rolled-back transaction and returns the plan and summary', async () => {
    const d = fakeDb({
      'INSERT INTO families': { rows: [{ family_id: FID }] },
      'INSERT INTO family_students': { rows: [{ student_id: SID }], rowCount: 1 },
      'INSERT INTO family_contacts': { rows: [{ contact_id: 'c' }], rowCount: 1 },
      'FROM students': { rows: [{ student_id: SID, name: 'Kid One', grade: '3' }] },
    });
    const res = await request(app).post('/api/finance/families/import').set(admin()).send({ roster, customerMap: csv });
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(false);
    expect(res.body.data.plan.counts).toMatchObject({ families: 1, exact: 1 });
    expect(res.body.data.summary).toMatchObject({ familiesCreated: 1, studentsLinked: 1 });
    const sqls = d.calls.map((c) => c.sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('commits when dryRun is false', async () => {
    const d = fakeDb({ 'INSERT INTO families': { rows: [{ family_id: FID }] }, 'INSERT INTO family_students': { rows: [{ student_id: SID }], rowCount: 1 }, 'FROM students': { rows: [{ student_id: SID, name: 'Kid One', grade: '3' }] } });
    const res = await request(app).post('/api/finance/families/import').set(admin()).send({ roster, customerMap: csv, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(true);
    expect(d.calls.map((c) => c.sql)).toContain('COMMIT');
  });

  it('returns plan errors with 422 and applies nothing', async () => {
    const d = fakeDb({ 'FROM students': { rows: [] } });
    const res = await request(app).post('/api/finance/families/import').set(admin()).send({ roster, customerMap: 'family_no,status,final_id,note\n', dryRun: false });
    expect(res.status).toBe(422);
    expect(res.body.data.plan.errors[0]).toMatch(/no customer-map row/);
    expect(d.find('INSERT INTO families')).toHaveLength(0);
  });

  it('validates the payload', async () => {
    fakeDb();
    expect((await request(app).post('/api/finance/families/import').set(admin()).send({ roster: 'nope', customerMap: csv })).status).toBe(400);
  });

  it('lets two roster families swap customers (the seeder handles that itself)', async () => {
    const roster2 = { families: [
      { ...roster.families[0], family_no: 1, primary_parent: 'Parent One' },
      { ...roster.families[0], family_no: 2, primary_parent: 'Parent Two', children: [{ name: 'Kid Two', grade: '5' }], emails: ['two@example.com'] },
    ] };
    const csv2 = 'family_no,status,final_id,note\n1,AUTO,991,\n2,AUTO,992,\n';
    const d = fakeDb({
      'INSERT INTO families': (params) => ({ rows: [{ family_id: params[8] === 1 ? 'f-1' : 'f-2' }] }),
      'FROM students': { rows: [] },
      'SELECT f\\.family_id, f\\.roster_family_no, f\\.name, l\\.qbo_customer_id': { rows: [{ family_id: 'f-1', roster_family_no: 1, name: 'Parent One', qbo_customer_id: '992' }, { family_id: 'f-2', roster_family_no: 2, name: 'Parent Two', qbo_customer_id: '991' }] },
      'FROM family_customer_links': (params, sql) => (/SELECT l\.family_id, f\.name AS family_name/.test(sql)
        ? { rows: [{ family_id: 'f-1', family_name: 'Parent One', qbo_customer_id: '992', roster_family_no: 1 }, { family_id: 'f-2', family_name: 'Parent Two', qbo_customer_id: '991', roster_family_no: 2 }] }
        : { rows: [{ link_id: `old-${params[0]}`, qbo_customer_id: params[0] === 'f-1' ? '992' : '991' }] }),
    });
    const res = await request(app).post('/api/finance/families/import').set(admin()).send({ roster: roster2, customerMap: csv2 });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ linksClosed: 2, linksOpened: 2 });
    expect(d.find('DELETE FROM family_customer_links')).toHaveLength(2);
  });

  it('422s (naming the family) when a mapped customer is already linked to a family outside the roster', async () => {
    const d = fakeDb({
      'INSERT INTO families': { rows: [{ family_id: FID }] },
      'FROM students': { rows: [{ student_id: SID, name: 'Kid One', grade: '3' }] },
      'FROM family_customer_links': { rows: [{ family_id: CID, family_name: 'Hand-made Family', qbo_customer_id: '991', roster_family_no: null }] },
    });
    const res = await request(app).post('/api/finance/families/import').set(admin()).send({ roster, customerMap: csv, dryRun: false });
    expect(res.status).toBe(422);
    expect(res.body.data.plan.errors[0]).toMatch(/991.*Hand-made Family/);
    expect(d.find('INSERT INTO families')).toHaveLength(0);
  });

  it('accepts the real roster size (~150 KB), well above the default JSON body limit', async () => {
    fakeDb({ 'INSERT INTO families': (params) => ({ rows: [{ family_id: `f-${params[8]}` }] }), 'FROM students': { rows: [] } });
    const big = { families: Array.from({ length: 400 }, (_, i) => ({ family_no: i + 1, primary_parent: `Parent ${i}`, parents: [`Parent ${i}`], emails: [`p${i}@example.com`],
      address: 'x'.repeat(200), children: [{ name: `Child ${i}`, grade: '3', grade_label: 'Grade 3', rate: 500, subsidy: 0, subsidy_source: 'al-maarif', staff_discount: 0, teacher: null, tuition_waived: false, master_no: i, parent_monthly: 500 }],
      monthly_parent_total: 500, monthly_subsidy_total: 0, is_subsidy: false, is_teacher: false })) };
    const map = 'family_no,status,final_id,note\n' + big.families.map((f) => `${f.family_no},AUTO,${1000 + f.family_no},`).join('\n');
    expect(JSON.stringify({ roster: big, customerMap: map }).length).toBeGreaterThan(150 * 1024);
    const res = await request(app).post('/api/finance/families/import').set(admin()).send({ roster: big, customerMap: map });
    expect(res.status).not.toBe(413);
    expect([200, 422]).toContain(res.status);
  });
});
