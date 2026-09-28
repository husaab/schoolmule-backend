jest.mock('../../../services/finance/qboAuth', () => {
  const actual = jest.requireActual('../../../services/finance/qboAuth');
  return { ...actual, exchangeCode: jest.fn(), saveConnection: jest.fn(), disconnect: jest.fn(), revokeToken: jest.fn().mockResolvedValue(true), getAccessToken: jest.fn().mockResolvedValue('tok') };
});
jest.mock('../../../services/finance/qboClient', () => ({ createClient: jest.fn() }));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_ADMIN_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const db = require('../../__mocks__/config/database');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { signState, verifyState } = require('../../../utils/oauthState');
const qboAuth = require('../../../services/finance/qboAuth');
const { createClient } = require('../../../services/finance/qboClient');

process.env.QBO_CLIENT_ID = 'cid';
process.env.QBO_CLIENT_SECRET = 'csecret';
process.env.QBO_REDIRECT_URI = 'http://localhost:4000/api/finance/qbo/callback';
process.env.QBO_TOKEN_ENC_KEY = Buffer.alloc(32, 5).toString('base64');

let app;
beforeAll(() => { app = getApp(); });

const admin = () => ({ Authorization: `Bearer ${mockAdminUser()}` });
const teacher = () => ({ Authorization: `Bearer ${mockTeacherUser()}` });

const connRow = (over = {}) => ({
  connection_id: 'c1', school: TEST_SCHOOL, realm_id: '9130351374400296', company_name: 'Al Haadi Academy', status: 'active',
  refresh_token: 'enc', access_token: 'enc', settings: {}, cdc_cursor: null, backfill_completed_at: null,
  last_success_at: null, last_error: null, consecutive_failures: 0, connected_by: TEST_ADMIN_USER_ID,
  connected_at: '2026-09-27T10:00:00Z', ...over,
});

describe('finance auth gate', () => {
  it('rejects non-admins on every finance route', async () => {
    for (const [m, url] of [['get', '/api/finance/qbo/connection'], ['post', '/api/finance/sync'], ['get', '/api/finance/tuition/grid']]) {
      const res = await request(app)[m](url).set(teacher());
      expect(res.status).toBe(403);
    }
  });
});

describe('GET /api/finance/qbo/connection', () => {
  it('reports not connected', async () => {
    mockQueryResponse([]);
    const res = await request(app).get('/api/finance/qbo/connection').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ connected: false, status: null });
  });

  it('reports the connection without ever exposing tokens', async () => {
    mockQueryResponse([connRow()]);
    const res = await request(app).get('/api/finance/qbo/connection').set(admin());
    expect(res.body.data).toMatchObject({ connected: true, realmId: '9130351374400296', companyName: 'Al Haadi Academy', status: 'active' });
    expect(JSON.stringify(res.body)).not.toMatch(/refresh_token|access_token|refreshToken|accessToken|"enc"/);
  });
});

describe('GET /api/finance/qbo/connect-url', () => {
  it('returns the Intuit consent URL carrying a signed state for this school', async () => {
    const res = await request(app).get('/api/finance/qbo/connect-url?returnTo=/finance/tuition').set(admin());
    expect(res.status).toBe(200);
    const url = new URL(res.body.data.url);
    expect(url.hostname).toBe('appcenter.intuit.com');
    expect(verifyState(url.searchParams.get('state'))).toMatchObject({ school: TEST_SCHOOL, userId: TEST_ADMIN_USER_ID, returnTo: '/finance/tuition' });
  });

  it('does not leak configuration in its error', async () => {
    const saved = process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_ID;
    const res = await request(app).get('/api/finance/qbo/connect-url').set(admin());
    process.env.QBO_CLIENT_ID = saved;
    expect(res.status).toBe(500);
    expect(res.body.message).not.toMatch(/QBO_CLIENT_ID/);
  });

  it('falls back to the allowlisted return path', async () => {
    const res = await request(app).get('/api/finance/qbo/connect-url?returnTo=https://evil.example').set(admin());
    expect(verifyState(new URL(res.body.data.url).searchParams.get('state')).returnTo).toBe('/finance/tuition');
  });
});

describe('GET /api/finance/qbo/callback (public)', () => {
  const state = (over = {}) => signState({ school: TEST_SCHOOL, userId: TEST_ADMIN_USER_ID, returnTo: '/finance/tuition', purpose: 'qbo', iat: Date.now(), ...over });
  const adminRow = () => ({ user_id: TEST_ADMIN_USER_ID, role: 'ADMIN', school: TEST_SCHOOL, is_archived: false });

  it('redirects with invalid_state when the state does not verify', async () => {
    const res = await request(app).get('/api/finance/qbo/callback?code=x&state=bad.sig&realmId=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:3000/finance/tuition?qbo=invalid_state');
  });

  it('redirects with denied when the admin declined', async () => {
    const res = await request(app).get(`/api/finance/qbo/callback?error=access_denied&state=${state()}`);
    expect(res.headers.location).toMatch(/qbo=denied$/);
  });

  it('refuses a state minted by another integration (no purpose or the wrong one)', async () => {
    const res = await request(app).get(`/api/finance/qbo/callback?code=x&state=${state({ purpose: 'google' })}&realmId=1`);
    expect(res.headers.location).toMatch(/qbo=invalid_state$/);
    expect(qboAuth.exchangeCode).not.toHaveBeenCalled();
  });

  it('refuses to finish a connect for a user who is not (or no longer) an admin of that school', async () => {
    mockQueryResponse([{ ...adminRow(), role: 'TEACHER' }]);
    const res = await request(app).get(`/api/finance/qbo/callback?code=x&state=${state()}&realmId=1`);
    expect(res.headers.location).toMatch(/qbo=forbidden$/);
    expect(qboAuth.exchangeCode).not.toHaveBeenCalled();
  });

  it('exchanges the code, stores the connection, queues a backfill and redirects connected', async () => {
    mockQueryResponse([adminRow()]); // the state's user is re-checked against the database
    qboAuth.exchangeCode.mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    createClient.mockReturnValueOnce({ request: jest.fn().mockResolvedValue({ CompanyInfo: { CompanyName: 'Al Haadi Academy' } }) });
    mockQueryResponse([]); // no existing connection → no realm conflict
    qboAuth.saveConnection.mockResolvedValueOnce({ connection_id: 'c1' });
    mockQueryResponse([{ job_id: 'j1' }]); // enqueue backfill

    const res = await request(app).get(`/api/finance/qbo/callback?code=the-code&state=${state()}&realmId=9130351374400296`);

    expect(res.headers.location).toBe('http://localhost:3000/finance/tuition?qbo=connected');
    expect(qboAuth.exchangeCode).toHaveBeenCalledWith('the-code');
    expect(qboAuth.saveConnection).toHaveBeenCalledWith(expect.objectContaining({
      school: TEST_SCHOOL, realmId: '9130351374400296', companyName: 'Al Haadi Academy', userId: TEST_ADMIN_USER_ID,
      tokens: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
    }));
    expect(db.query.mock.calls.some(([sql, params]) => /INSERT INTO finance_sync_jobs/.test(sql) && params[1] === 'backfill')).toBe(true);
  });

  it('refuses to switch a school to a different realm without a purge', async () => {
    mockQueryResponse([adminRow()]);
    qboAuth.exchangeCode.mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
    createClient.mockReturnValueOnce({ request: jest.fn().mockResolvedValue({ CompanyInfo: { CompanyName: 'Other Co' } }) });
    mockQueryResponse([connRow({ realm_id: '111' })]);
    const res = await request(app).get(`/api/finance/qbo/callback?code=c&state=${state()}&realmId=222`);
    expect(res.headers.location).toMatch(/qbo=realm_conflict$/);
    expect(qboAuth.saveConnection).not.toHaveBeenCalled();
  });

  it('never trusts a school from the query string', async () => {
    const res = await request(app).get('/api/finance/qbo/callback?code=x&school=PLAYGROUND&realmId=1');
    expect(res.headers.location).toMatch(/qbo=invalid_state$/);
    expect(qboAuth.saveConnection).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/finance/qbo/connection', () => {
  it('disconnects (keeping the cache) by default', async () => {
    qboAuth.disconnect.mockResolvedValueOnce({ connection_id: 'c1' });
    const res = await request(app).delete('/api/finance/qbo/connection').set(admin());
    expect(res.status).toBe(200);
    expect(qboAuth.disconnect).toHaveBeenCalledWith(TEST_SCHOOL, expect.anything());
    expect(db.query.mock.calls.some(([sql]) => /DELETE FROM finance_qbo_connections/.test(sql))).toBe(false);
  });

  it('purges the row (and the cache with it) when asked', async () => {
    qboAuth.disconnect.mockResolvedValueOnce({ connection_id: 'c1' });
    mockQueryResponse([{ connection_id: 'c1' }]);
    const res = await request(app).delete('/api/finance/qbo/connection?purge=true').set(admin());
    expect(res.status).toBe(200);
    expect(db.query.mock.calls.some(([sql]) => /DELETE FROM finance_qbo_connections/.test(sql))).toBe(true);
  });
});

describe('POST /api/finance/sync', () => {
  it('409s when QuickBooks is not connected', async () => {
    mockQueryResponse([]); // connection
    const res = await request(app).post('/api/finance/sync').set(admin());
    expect(res.status).toBe(409);
  });

  it('429s when a manual sync ran in the last minute', async () => {
    mockQueryResponse([connRow()]);
    mockQueryResponse([{ run_id: 'r' }]); // recent manual run
    const res = await request(app).post('/api/finance/sync').set(admin());
    expect(res.status).toBe(429);
  });

  it('queues a manual job and returns 202', async () => {
    mockQueryResponse([connRow()]);
    mockQueryResponse([]); // no recent manual run
    mockQueryResponse([{ job_id: 'j1' }]); // enqueue
    const res = await request(app).post('/api/finance/sync').set(admin());
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ jobId: 'j1', alreadyQueued: false });
    const enqueue = db.query.mock.calls.find(([sql]) => /INSERT INTO finance_sync_jobs/.test(sql));
    expect(enqueue[1]).toEqual([TEST_SCHOOL, 'manual', TEST_ADMIN_USER_ID]);
  });

  it('queues a full refresh when asked', async () => {
    mockQueryResponse([connRow()]);
    mockQueryResponse([]);
    mockQueryResponse([{ job_id: 'j2' }]);
    const res = await request(app).post('/api/finance/sync').set(admin()).send({ full: true });
    expect(res.status).toBe(202);
    const enqueue = db.query.mock.calls.find(([sql]) => /INSERT INTO finance_sync_jobs/.test(sql));
    expect(enqueue[1]).toEqual([TEST_SCHOOL, 'backfill', TEST_ADMIN_USER_ID]);
  });

  it('reports an already-live job instead of duplicating it', async () => {
    mockQueryResponse([connRow()]);
    mockQueryResponse([]);
    mockQueryResponse([]); // ON CONFLICT DO NOTHING → no row
    mockQueryResponse([{ job_id: 'live', state: 'running' }]); // latest job
    const res = await request(app).post('/api/finance/sync').set(admin());
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ jobId: 'live', alreadyQueued: true });
  });
});

describe('GET /api/finance/sync/status and /runs', () => {
  it('returns connection, latest job and last run', async () => {
    mockQueryResponse([connRow({ last_success_at: '2026-09-27T12:00:00Z' })]);
    mockQueryResponse([{ job_id: 'j1', kind: 'cdc', state: 'pending', attempts: 0, last_error: null, next_attempt_at: null }]);
    mockQueryResponse([{ run_id: 'r1', kind: 'cdc', mode: 'cdc', status: 'success', started_at: 'x', finished_at: 'y', invoices_upserted: 2, payments_upserted: 1, error: null }]);
    const res = await request(app).get('/api/finance/sync/status').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data.connection).toMatchObject({ connected: true, lastSuccessAt: '2026-09-27T12:00:00Z' });
    expect(res.body.data.job).toMatchObject({ jobId: 'j1', state: 'pending' });
    expect(res.body.data.lastRun).toMatchObject({ runId: 'r1', status: 'success', invoicesUpserted: 2 });
    expect(res.body.data.pendingSync).toBe(true);
  });

  it('ignores a failed job that predates the last successful sync', async () => {
    mockQueryResponse([connRow({ last_success_at: '2026-09-27T12:00:00Z' })]);
    mockQueryResponse([{ job_id: 'old', kind: 'cdc', state: 'failed', attempts: 6, last_error: 'boom', created_at: '2026-09-27T10:00:00Z' }]);
    mockQueryResponse([]);
    const res = await request(app).get('/api/finance/sync/status').set(admin());
    expect(res.body.data.job).toBeNull();
    expect(res.body.data.pendingSync).toBe(false);
  });

  it('lists runs with a clamped limit', async () => {
    mockQueryResponse([{ run_id: 'r1', kind: 'cdc', mode: 'cdc', status: 'success' }]);
    mockQueryResponse([{ total: 1 }]);
    const res = await request(app).get('/api/finance/sync/runs?limit=999').set(admin());
    expect(res.status).toBe(200);
    expect(res.body.data.runs[0]).toMatchObject({ runId: 'r1' });
    expect(res.body.data.total).toBe(1);
    const q = db.query.mock.calls.find(([sql]) => /FROM finance_sync_runs[\s\S]*LIMIT \$2/.test(sql));
    expect(q[1][1]).toBe(100);
  });
});

describe('GET /api/finance/tuition/grid', () => {
  it('assembles the grid for the selected school year', async () => {
    // The db mock answers the school_years lookups itself (2025-09-01 → 2026-06-30).
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM school_years/.test(sql)) return { rows: [{ school_year_id: db.DEFAULT_SCHOOL_YEAR_ID, school: TEST_SCHOOL, label: '2025-2026', start_date: '2025-09-01', end_date: '2026-06-30', is_active: true }] };
      if (/FROM finance_qbo_connections/.test(sql)) return { rows: [connRow({ last_success_at: '2026-09-27T12:00:00Z' })] };
      if (/FROM finance_sync_jobs/.test(sql)) return { rows: [] };
      if (/FROM families/.test(sql)) return { rows: [{ family_id: '11111111-1111-4111-8111-111111111111', name: 'Amal Haddad', is_subsidy: false, is_teacher: false, expected_monthly_parent: '1000.00', expected_monthly_subsidy: null, notes: null, roster_family_no: 24 }] };
      if (/FROM family_students/.test(sql)) return { rows: [{ family_id: '11111111-1111-4111-8111-111111111111', student_id: 's1', name: 'Lina Haddad', grade: '4', is_archived: false }] };
      if (/FROM family_contacts/.test(sql)) return { rows: [] };
      if (/FROM family_customer_links/.test(sql)) return { rows: [{ link_id: 'l1', family_id: '11111111-1111-4111-8111-111111111111', qbo_customer_id: '27', effective_from: '2025-08-01', effective_to: null }] };
      if (/FROM qbo_customers/.test(sql)) return { rows: [{ qbo_id: '27', display_name: 'Amal Haddad Karam', is_sub_customer: false, active: true }] };
      if (/FROM qbo_invoices/.test(sql)) return { rows: [{ qbo_id: 'i1', customer_qbo_id: '27', doc_number: '9480', txn_date: '2025-09-01', due_date: '2025-10-01', total_amt: '1400.00', balance: '0.00', kind: 'parent', is_voided: false, deleted_at: null }] };
      if (/FROM qbo_invoice_lines/.test(sql)) return { rows: [] };
      if (/FROM qbo_payment_applications/.test(sql)) return { rows: [{ payment_qbo_id: 'p1', invoice_qbo_id: 'i1', amount: '1400.00', payment_date: '2025-09-20', payment_deleted: false }] };
      if (/FROM qbo_payments/.test(sql)) return { rows: [{ qbo_id: 'p1', customer_qbo_id: '27', txn_date: '2025-09-20', total_amt: '1400.00', unapplied_amt: '0.00', deleted_at: null }] };
      if (/students_without_family|LEFT JOIN family_students/.test(sql)) return { rows: [{ count: 3 }] };
      return { rows: [] };
    });

    const res = await request(app).get('/api/finance/tuition/grid').set(admin());
    expect(res.status).toBe(200);
    const g = res.body.data;
    expect(g.months).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']);
    expect(g.families).toHaveLength(1);
    expect(g.families[0].parent.cells['2025-09']).toMatchObject({ status: 'paid', invoiced: 1400, paid: 1400 });
    expect(g.families[0].customer.displayName).toBe('Amal Haddad Karam');
    expect(g.summary).toMatchObject({ familiesTotal: 1, outstanding: 0, studentsWithoutFamily: 3 });
    expect(g.sync).toMatchObject({ connected: true, lastSuccessAt: '2026-09-27T12:00:00Z' });
    expect(g.grant.cells).toBeDefined();
    // Every school-scoped query was bound to the caller's school, never a query param.
    for (const [sql, params] of db.query.mock.calls) {
      if (/FROM (families|qbo_invoices|qbo_payments|family_customer_links)/.test(sql)) expect(params[0]).toBe(TEST_SCHOOL);
    }
  });
});

describe('GET /api/finance/families/:familyId', () => {
  it('404s on a malformed id without touching the database', async () => {
    const res = await request(app).get('/api/finance/families/not-a-uuid').set(admin());
    expect(res.status).toBe(404);
  });

  it('404s when the family belongs to another school or does not exist', async () => {
    db.query.mockImplementation(async (sql) => (/FROM families/.test(sql) ? { rows: [] } : { rows: [] }));
    const res = await request(app).get('/api/finance/families/11111111-1111-4111-8111-111111111111').set(admin());
    expect(res.status).toBe(404);
  });

  it('returns the family with its ledger, invoices and audit trail', async () => {
    const fid = '11111111-1111-4111-8111-111111111111';
    db.query.mockImplementation(async (sql) => {
      if (/FROM school_years/.test(sql)) return { rows: [{ school_year_id: db.DEFAULT_SCHOOL_YEAR_ID, school: TEST_SCHOOL, label: '2025-2026', start_date: '2025-09-01', end_date: '2026-06-30', is_active: true }] };
      if (/FROM finance_qbo_connections/.test(sql)) return { rows: [connRow()] };
      if (/FROM families/.test(sql)) return { rows: [{ family_id: fid, school: TEST_SCHOOL, name: 'Rania Saleh', is_subsidy: true, is_teacher: false, expected_monthly_parent: '500.00', expected_monthly_subsidy: '500.00', notes: null, roster_family_no: 25, created_at: 'x', updated_at: 'y' }] };
      if (/FROM family_students/.test(sql)) return { rows: [{ family_id: fid, student_id: 's1', name: 'Omar Saleh', grade: '4', is_archived: false }] };
      if (/FROM family_contacts/.test(sql)) return { rows: [{ contact_id: 'c1', family_id: fid, name: 'Rania Saleh', email: 'f@x.com', phone: null, relation: 'mother', is_primary: true, user_id: null, source: 'roster' }] };
      if (/FROM family_customer_links/.test(sql)) return { rows: [{ link_id: 'l1', family_id: fid, qbo_customer_id: '670', effective_from: '2025-08-01', effective_to: null, created_at: 'x', customer_name: 'Rania Saleh', is_sub_customer: false, customer_active: true }] };
      if (/FROM qbo_customers/.test(sql)) return { rows: [{ qbo_id: '670', display_name: 'Rania Saleh', is_sub_customer: false, active: true }] };
      if (/FROM qbo_invoices/.test(sql)) return { rows: [
        { qbo_id: 'i1', customer_qbo_id: '670', doc_number: '9506', txn_date: '2025-09-01', due_date: '2025-10-01', total_amt: '900.00', balance: '0.00', kind: 'parent', kind_auto: 'parent', kind_override: null, is_voided: false, deleted_at: null, email_status: 'EmailSent', private_note: null },
        { qbo_id: 'i2', customer_qbo_id: '670', doc_number: '9507', txn_date: '2025-09-01', due_date: '2025-10-01', total_amt: '500.00', balance: '500.00', kind: 'subsidy_grant', kind_auto: 'subsidy_grant', kind_override: null, is_voided: false, deleted_at: null, email_status: 'NotSet', private_note: "Al-Ma'arif subsidy portion" },
      ] };
      if (/FROM qbo_invoice_lines/.test(sql)) return { rows: [{ invoice_qbo_id: 'i1', line_num: 1, description: 'Omar Saleh - Grade 4 - Tuition', amount: '500.00', item_ref: '4', item_name: 'School Fees', student_hint: 'Omar Saleh' }] };
      if (/FROM qbo_payment_applications/.test(sql)) return { rows: [{ payment_qbo_id: 'p1', invoice_qbo_id: 'i1', amount: '900.00', payment_date: '2025-09-20', payment_deleted: false, payment_ref_num: 'E-transfer' }] };
      if (/FROM qbo_payments/.test(sql)) return { rows: [{ qbo_id: 'p1', customer_qbo_id: '670', txn_date: '2025-09-20', total_amt: '900.00', unapplied_amt: '0.00', payment_ref_num: 'E-transfer', payment_method: 'E-Transfer', deleted_at: null }] };
      if (/FROM family_link_audit/.test(sql)) return { rows: [{ audit_id: 'a1', action: 'seed', created_at: 'x', actor_user_id: null, details: {} }] };
      return { rows: [] };
    });
    const res = await request(app).get(`/api/finance/families/${fid}`).set(admin());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.family).toMatchObject({ familyId: fid, name: 'Rania Saleh', isSubsidy: true });
    expect(d.students[0].name).toBe('Omar Saleh');
    expect(d.contacts[0]).toMatchObject({ email: 'f@x.com', isPrimary: true });
    expect(d.customerLinks[0]).toMatchObject({ qboCustomerId: '670', customerName: 'Rania Saleh', current: true });
    expect(d.ledger.parent.cells['2025-09'].status).toBe('paid');
    expect(d.ledger.grant.cells['2025-09'].status).toBe('overdue');
    const parentInv = d.invoices.find((i) => i.qboId === 'i1');
    expect(parentInv).toMatchObject({ docNumber: '9506', kind: 'parent', month: '2025-09', total: 900, balance: 0 });
    expect(parentInv.lines[0]).toMatchObject({ description: 'Omar Saleh - Grade 4 - Tuition', amount: 500, studentHint: 'Omar Saleh' });
    expect(parentInv.payments[0]).toMatchObject({ paymentId: 'p1', amount: 900, date: '2025-09-20', ref: 'E-transfer' });
    expect(d.audit[0]).toMatchObject({ action: 'seed' });
  });
});

describe('GET /api/finance/tuition/grid.csv and /anomalies and /families/suggestions', () => {
  const FID = '11111111-1111-4111-8111-111111111111';
  const wire = () => db.query.mockImplementation(async (sql) => {
    if (/FROM school_years/.test(sql)) return { rows: [{ school_year_id: db.DEFAULT_SCHOOL_YEAR_ID, school: TEST_SCHOOL, label: '2025-2026', start_date: '2025-09-01', end_date: '2026-06-30', is_active: true }] };
    if (/FROM finance_qbo_connections/.test(sql)) return { rows: [connRow()] };
    if (/FROM families/.test(sql)) return { rows: [{ family_id: FID, name: 'Rania Saleh', is_subsidy: true, is_teacher: false, expected_monthly_parent: '500.00', expected_monthly_subsidy: '500.00', notes: null, roster_family_no: 25 }] };
    if (/FROM family_students/.test(sql)) return { rows: [{ family_id: FID, student_id: 's1', name: 'Omar Saleh', grade: '4', is_archived: false }] };
    if (/FROM family_contacts/.test(sql)) return { rows: [{ contact_id: 'c1', family_id: FID, name: 'Rania Saleh', email: 'rania@example.com', phone: null, relation: 'mother', is_primary: true, user_id: null }] };
    if (/FROM family_customer_links/.test(sql)) return { rows: [{ link_id: 'l1', family_id: FID, qbo_customer_id: '670', effective_from: '2025-08-01', effective_to: null }] };
    if (/FROM qbo_customers/.test(sql)) return { rows: [
      { qbo_id: '670', display_name: 'Rania Saleh', is_sub_customer: false, active: false, emails: ['rania@example.com'], deleted_at: null },
      { qbo_id: '999', display_name: 'Unknown Donor', is_sub_customer: false, active: true, emails: ['donor@example.com'], deleted_at: null },
    ] };
    if (/FROM qbo_invoices/.test(sql)) return { rows: [
      { qbo_id: 'i1', customer_qbo_id: '670', doc_number: '9506', txn_date: '2025-09-01', due_date: '2025-10-01', total_amt: '900.00', balance: '0.00', kind: 'parent', is_voided: false, deleted_at: null },
      { qbo_id: 'i2', customer_qbo_id: '999', doc_number: '9600', txn_date: '2025-10-01', due_date: '2025-10-31', total_amt: '75.00', balance: '75.00', kind: 'parent', is_voided: false, deleted_at: null },
      { qbo_id: 'i3', customer_qbo_id: '670', doc_number: '9700', txn_date: '2025-10-03', due_date: '2025-11-02', total_amt: '40.00', balance: '40.00', kind: 'other', is_voided: false, deleted_at: null },
    ] };
    if (/FROM qbo_invoice_lines/.test(sql)) return { rows: [] };
    if (/FROM qbo_payment_applications/.test(sql)) return { rows: [] };
    if (/FROM qbo_payments/.test(sql)) return { rows: [] };
    if (/LEFT JOIN family_students/.test(sql) && /count/.test(sql)) return { rows: [{ count: 1 }] };
    if (/LEFT JOIN family_students/.test(sql)) return { rows: [{ student_id: 's7', name: 'Zayn Saleh', grade: '2', mother_email: 'rania@example.com', father_email: null }] };
    return { rows: [] };
  });

  it('exports one CSV row per family with month columns and totals', async () => {
    wire();
    const res = await request(app).get('/api/finance/tuition/grid.csv').set(admin());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/tuition-2025-2026\.csv/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toMatch(/^Family,Students,Primary contact,Customer,Subsidy,Teacher,2025-09 status,2025-09 owed/);
    expect(lines[1]).toMatch(/^Rania Saleh,Omar Saleh \(4\),rania@example\.com,Rania Saleh,yes,no,paid,0/);
    expect(lines[1]).toMatch(/,900,900,0$/); // invoiced YTD, paid YTD, balance
  });

  it('neutralizes spreadsheet formulas in exported text cells', async () => {
    wire();
    db.query.mockImplementation(async (sql) => {
      if (/FROM school_years/.test(sql)) return { rows: [{ school_year_id: db.DEFAULT_SCHOOL_YEAR_ID, school: TEST_SCHOOL, label: '2025-2026', start_date: '2025-09-01', end_date: '2026-06-30', is_active: true }] };
      if (/FROM finance_qbo_connections/.test(sql)) return { rows: [connRow()] };
      if (/FROM families/.test(sql)) return { rows: [{ family_id: FID, name: '=HYPERLINK("http://evil")', is_subsidy: false, is_teacher: false, expected_monthly_parent: null, expected_monthly_subsidy: null, notes: null, roster_family_no: null }] };
      if (/count/.test(sql)) return { rows: [{ count: 0 }] };
      return { rows: [] };
    });
    const res = await request(app).get('/api/finance/tuition/grid.csv').set(admin());
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[1]).toMatch(/^"'=HYPERLINK/);
  });

  it('reports anomalies: unlinked customers, students without a family, other-kind invoices, stale links, warnings', async () => {
    wire();
    const res = await request(app).get('/api/finance/tuition/anomalies').set(admin());
    expect(res.status).toBe(200);
    const a = res.body.data;
    expect(a.unlinkedCustomers[0]).toMatchObject({ qboId: '999', displayName: 'Unknown Donor', invoiceTotal: 75 });
    expect(a.studentsWithoutFamily).toEqual([{ studentId: 's7', name: 'Zayn Saleh', grade: '2' }]);
    expect(a.otherKindInvoices[0]).toMatchObject({ qboId: 'i3', familyId: FID, familyName: 'Rania Saleh', total: 40 });
    expect(a.staleLinks[0]).toMatchObject({ familyId: FID, qboCustomerId: '670', reason: 'inactive' });
    expect(a.warningsByFamily[0]).toMatchObject({ familyId: FID });
    expect(a.warningsByFamily[0].warnings.map((w) => w.code)).toContain('OTHER_KIND_INVOICE');
  });

  it('suggests customers for unlinked families, families for unlinked customers, and families for orphan students', async () => {
    wire();
    db.query.mockImplementation(async (sql) => {
      if (/FROM family_customer_links/.test(sql)) return { rows: [] }; // nobody linked
      if (/FROM families/.test(sql)) return { rows: [{ family_id: FID, name: 'Rania Saleh', is_subsidy: true, is_teacher: false, expected_monthly_parent: '500.00', expected_monthly_subsidy: null, notes: null, roster_family_no: 25 }] };
      if (/FROM family_students/.test(sql)) return { rows: [{ family_id: FID, student_id: 's1', name: 'Omar Saleh', grade: '4', is_archived: false }] };
      if (/FROM family_contacts/.test(sql)) return { rows: [{ contact_id: 'c1', family_id: FID, name: 'Rania Saleh', email: 'rania@example.com', phone: null, relation: 'mother', is_primary: true, user_id: null }] };
      if (/FROM qbo_customers/.test(sql)) return { rows: [{ qbo_id: '670', display_name: 'Rania Saleh', is_sub_customer: false, active: true, emails: ['rania@example.com'], deleted_at: null }, { qbo_id: '999', display_name: 'Unknown Donor', is_sub_customer: false, active: true, emails: [], deleted_at: null }] };
      if (/FROM qbo_invoices/.test(sql)) return { rows: [{ qbo_id: 'i2', customer_qbo_id: '999', doc_number: '9600', txn_date: '2025-10-01', due_date: '2025-10-31', total_amt: '75.00', balance: '75.00', kind: 'parent', is_voided: false, deleted_at: null }] };
      if (/FROM school_years/.test(sql)) return { rows: [{ school_year_id: db.DEFAULT_SCHOOL_YEAR_ID, school: TEST_SCHOOL, label: '2025-2026', start_date: '2025-09-01', end_date: '2026-06-30', is_active: true }] };
      if (/LEFT JOIN family_students/.test(sql)) return { rows: [{ student_id: 's7', name: 'Zayn Saleh', grade: '2', mother_email: 'rania@example.com', father_email: null }] };
      return { rows: [] };
    });
    const res = await request(app).get('/api/finance/families/suggestions').set(admin());
    expect(res.status).toBe(200);
    const s = res.body.data;
    expect(s.unlinkedFamilies[0]).toMatchObject({ familyId: FID });
    expect(s.unlinkedFamilies[0].candidates[0]).toMatchObject({ qboId: '670', reason: 'email' });
    expect(s.unlinkedCustomers.map((c) => c.qboId)).toEqual(['999']);
    expect(s.unlinkedCustomers[0].earliestInvoiceDate).toBe('2025-10-01');
    expect(s.studentsWithoutFamily[0]).toMatchObject({ studentId: 's7', suggestedFamilyId: FID, suggestedFamilyName: 'Rania Saleh' });
  });
});
