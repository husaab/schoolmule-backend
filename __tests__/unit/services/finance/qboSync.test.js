jest.mock('../../../../services/finance/qboClient', () => ({ createClient: jest.fn() }));
jest.mock('../../../../services/finance/qboAuth', () => ({
  getAccessToken: jest.fn().mockResolvedValue('tok'),
  NeedsReconnectError: require('../../../../services/finance/errors').NeedsReconnectError,
}));
jest.mock('../../../../services/finance/alerts', () => ({ notifySyncFailure: jest.fn().mockResolvedValue() }));

const db = require('../../../__mocks__/config/database');
const { createClient } = require('../../../../services/finance/qboClient');
const alerts = require('../../../../services/finance/alerts');
const { NeedsReconnectError } = require('../../../../services/finance/errors');
const sync = require('../../../../services/finance/qboSync');
const { invoice, subsidyInvoice, payment, customer } = require('../../../helpers/qboFixtures');

const SCHOOL = 'ALHAADIACADEMY';
const REALM = '9130351374400296';
const NOW = new Date('2026-09-27T15:00:00Z');

const connection = (over = {}) => ({
  connection_id: 'c1', school: SCHOOL, realm_id: REALM, status: 'active', settings: {},
  cdc_cursor: null, backfill_completed_at: null, consecutive_failures: 0, alerted_at: null, connected_by: 'u1', ...over,
});

/** A fake QBO client: pages per entity + a canned CDC result. */
function fakeQbo({ customers = [], invoices = [], payments = [], paymentsByCustomer = {}, cdcResult = null, updated = {} } = {}) {
  const client = {
    queryPages: jest.fn(async function* ({ entity, where }) {
      const byCustomer = where.find((w) => w.field === 'CustomerRef');
      const byUpdated = where.find((w) => w.field === 'MetaData.LastUpdatedTime' && w.op === '>');
      let rows;
      if (entity === 'Payment' && byCustomer) rows = paymentsByCustomer[byCustomer.value] || [];
      else if (byUpdated) rows = updated[entity] || [];
      else rows = { Customer: customers, Invoice: invoices, Payment: payments }[entity] || [];
      if (rows.length) yield rows;
    }),
    cdc: jest.fn().mockResolvedValue(cdcResult || { truncated: false, Invoice: { upserts: [], deleted: [] }, Payment: { upserts: [], deleted: [] }, Customer: { upserts: [], deleted: [] } }),
  };
  createClient.mockReturnValue(client);
  return client;
}

/** SQL-dispatching DB double. Records every call; answers by statement shape. */
function fakeDb(conn, { unexplainedCustomers = [] } = {}) {
  const calls = [];
  const answer = (sql, params) => {
    calls.push({ sql, params });
    if (/FROM finance_qbo_connections/.test(sql)) return { rows: conn ? [conn] : [] };
    if (/INSERT INTO finance_sync_runs/.test(sql)) return { rows: [{ run_id: 'run-1', started_at: NOW.toISOString() }] };
    if (/INSERT INTO qbo_(customers|invoices|payments)/.test(sql)) {
      const rows = JSON.parse(params[2]).map((r) => ({ qbo_id: r.qbo_id }));
      return { rows, rowCount: rows.length };
    }
    if (/unexplained/i.test(sql)) return { rows: unexplainedCustomers.map((id) => ({ customer_qbo_id: id })) };
    if (/UPDATE qbo_(invoices|payments|customers)\s+SET deleted_at/.test(sql)) { const ids = Array.isArray(params[1]) ? params[1] : []; return { rows: ids.map((id) => ({ qbo_id: id })), rowCount: ids.length }; }
    if (/UPDATE finance_qbo_connections/.test(sql)) return { rows: [{ consecutive_failures: (conn.consecutive_failures || 0) + 1, alerted_at: conn.alerted_at }] };
    return { rows: [], rowCount: 0 };
  };
  db.query.mockImplementation(async (sql, params) => answer(sql, params));
  db._mockClient.query.mockImplementation(async (sql, params) => answer(sql, params));
  const find = (re) => calls.filter((c) => re.test(c.sql));
  return { calls, find };
}

describe('qboSync.runSync — full mode', () => {
  it('backfills customers, invoices and payments when the connection has never synced', async () => {
    const conn = connection();
    const d = fakeDb(conn);
    const qbo = fakeQbo({
      customers: [customer({ id: '27' }), customer({ id: '26', parentId: '171' })],
      invoices: [invoice({ id: '1', customerId: '27' }), subsidyInvoice({ id: '2', customerId: '670' })],
      payments: [payment({ id: '9', customerId: '27', applied: [{ invoiceId: '1', amount: 500 }] })],
    });

    const out = await sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW });

    expect(out.mode).toBe('full');
    expect(out.counts).toEqual({ customers: 2, invoices: 2, payments: 1, deleted: 0 });

    // Queries went to QBO in the right shape.
    const entities = qbo.queryPages.mock.calls.map(([q]) => q.entity);
    expect(entities).toEqual(['Customer', 'Invoice', 'Payment']);
    expect(qbo.queryPages.mock.calls[0][0].where).toEqual([{ field: 'Active', op: 'IN', value: [true, false] }]);
    expect(qbo.queryPages.mock.calls[1][0].where).toEqual([{ field: 'TxnDate', op: '>=', value: '2026-08-01' }]);
    expect(qbo.queryPages.mock.calls[2][0].where[0]).toMatchObject({ field: 'MetaData.LastUpdatedTime', op: '>=' });
    expect(qbo.cdc).not.toHaveBeenCalled();

    // Set-based upserts, one per page, with the school and realm bound.
    const inv = d.find(/INSERT INTO qbo_invoices/)[0];
    expect(inv.sql).toMatch(/jsonb_to_recordset/);
    expect(inv.sql).toMatch(/ON CONFLICT \(school, qbo_id\) DO UPDATE/);
    expect(inv.sql).toMatch(/EXCLUDED\.last_updated_time >= qbo_invoices\.last_updated_time/);
    expect(inv.params.slice(0, 2)).toEqual([SCHOOL, REALM]);
    const invRows = JSON.parse(inv.params[2]);
    expect(invRows.map((r) => r.kind_auto)).toEqual(['parent', 'subsidy_grant']);
    expect(invRows[0].raw).toBeDefined();

    // Lines and applications are rebuilt for the rows that were written.
    expect(d.find(/DELETE FROM qbo_invoice_lines/)[0].params[1]).toEqual(['1', '2']);
    expect(d.find(/INSERT INTO qbo_invoice_lines/)).toHaveLength(1);
    expect(d.find(/DELETE FROM qbo_payment_applications/)[0].params[1]).toEqual(['9']);
    const apps = JSON.parse(d.find(/INSERT INTO qbo_payment_applications/)[0].params[1]);
    expect(apps).toEqual([{ payment_qbo_id: '9', invoice_qbo_id: '1', amount: 500 }]);

    // Each page is its own transaction.
    const txn = d.calls.map((c) => c.sql).filter((s) => s === 'BEGIN' || s === 'COMMIT');
    expect(txn.filter((s) => s === 'BEGIN')).toHaveLength(3);
    expect(txn.filter((s) => s === 'COMMIT')).toHaveLength(3);

    // Unseen invoices in the window are swept, run closed, cursor advanced 5 min behind the start.
    expect(d.find(/UPDATE qbo_invoices\s+SET deleted_at = now\(\)[\s\S]*synced_at </)).toHaveLength(1);
    const run = d.find(/UPDATE finance_sync_runs/)[0];
    expect(run.sql).toMatch(/'success'/);
    const success = d.find(/UPDATE finance_qbo_connections[\s\S]*cdc_cursor = \$2/)[0];
    expect(new Date(success.params[1]).toISOString()).toBe('2026-09-27T14:55:00.000Z');
    expect(success.sql).toMatch(/backfill_completed_at = COALESCE\(backfill_completed_at, now\(\)\)/);
    expect(success.sql).toMatch(/consecutive_failures = 0/);
  });

  it('runs the gap pass for customers whose invoices were paid by payments we never fetched', async () => {
    const d = fakeDb(connection(), { unexplainedCustomers: ['27'] });
    const qbo = fakeQbo({ invoices: [invoice({ id: '1', customerId: '27', balance: 0 })], paymentsByCustomer: { 27: [payment({ id: '77', customerId: '27', txnDate: '2025-10-05', applied: [{ invoiceId: '1', amount: 500 }] })] } });
    await sync.runSync(SCHOOL, { kind: 'backfill', now: () => NOW });
    const gap = qbo.queryPages.mock.calls.find(([q]) => q.entity === 'Payment' && q.where.some((w) => w.field === 'CustomerRef'));
    expect(gap[0].where).toEqual([{ field: 'CustomerRef', op: '=', value: '27' }]);
    expect(JSON.parse(d.find(/INSERT INTO qbo_payments/).pop().params[2])[0].qbo_id).toBe('77');
  });

  it('escalates to a full run when the cursor is older than 29 days', async () => {
    fakeDb(connection({ cdc_cursor: '2026-08-20T00:00:00Z', backfill_completed_at: '2026-08-20T00:00:00Z' }));
    const qbo = fakeQbo();
    const out = await sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW });
    expect(out.mode).toBe('full');
    expect(qbo.cdc).not.toHaveBeenCalled();
  });
});

describe('qboSync.runSync — cdc mode', () => {
  const synced = () => connection({ cdc_cursor: '2026-09-27T14:30:00Z', backfill_completed_at: '2026-09-01T00:00:00Z' });

  it('applies upserts and flags deletions from a CDC response', async () => {
    const d = fakeDb(synced());
    const qbo = fakeQbo({ cdcResult: {
      truncated: false,
      Invoice: { upserts: [invoice({ id: '5', balance: 0 })], deleted: [{ id: '6', at: '2026-09-27T14:40:00-07:00' }] },
      Payment: { upserts: [], deleted: [{ id: '8', at: '2026-09-27T14:40:00-07:00' }] },
      Customer: { upserts: [customer({ id: '27' })], deleted: [] },
    } });

    const out = await sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW });

    expect(out.mode).toBe('cdc');
    expect(qbo.cdc).toHaveBeenCalledWith(['Invoice', 'Payment', 'Customer'], '2026-09-27T14:30:00.000Z');
    expect(qbo.queryPages).not.toHaveBeenCalled();
    expect(out.counts).toEqual({ customers: 1, invoices: 1, payments: 0, deleted: 2 });
    expect(d.find(/UPDATE qbo_invoices\s+SET deleted_at = now\(\)\s+WHERE school = \$1 AND qbo_id = ANY\(\$2/)[0].params[1]).toEqual(['6']);
    expect(d.find(/UPDATE qbo_payments\s+SET deleted_at/)[0].params[1]).toEqual(['8']);
    // A deleted payment's applications must go, or the ledger keeps showing the money.
    expect(d.find(/DELETE FROM qbo_payment_applications WHERE school = \$1 AND payment_qbo_id = ANY\(\$2/)[0].params[1]).toEqual(['8']);
    // No sweep in cdc mode.
    expect(d.find(/synced_at </)).toHaveLength(0);
  });

  it('escalates to a full run when CDC was truncated, so inactive customers and deletions are not missed', async () => {
    const d = fakeDb(synced());
    const qbo = fakeQbo({
      cdcResult: { truncated: true, Invoice: { upserts: [], deleted: [] }, Payment: { upserts: [], deleted: [] }, Customer: { upserts: [], deleted: [] } },
      invoices: [invoice({ id: '50' })],
    });
    const out = await sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW });
    const where = qbo.queryPages.mock.calls.map(([q]) => [q.entity, q.where[0].field, q.where[0].op]);
    expect(where).toEqual([
      ['Customer', 'Active', 'IN'],
      ['Invoice', 'TxnDate', '>='],
      ['Payment', 'MetaData.LastUpdatedTime', '>='],
    ]);
    expect(out.mode).toBe('full');
    expect(out.counts.invoices).toBe(1);
    expect(d.find(/UPDATE finance_sync_runs[\s\S]*mode = 'full'/)).toHaveLength(1);
  });
});

describe('qboSync.runSync — failures', () => {
  it('records the failure on the run and the connection, alerts after 3 in a row, and rethrows', async () => {
    const d = fakeDb(connection({ cdc_cursor: '2026-09-27T14:30:00Z', backfill_completed_at: '2026-09-01T00:00:00Z', consecutive_failures: 2 }));
    const qbo = fakeQbo();
    qbo.cdc.mockRejectedValueOnce(new Error('QuickBooks server error (503)'));

    await expect(sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW })).rejects.toThrow(/503/);

    expect(d.find(/UPDATE finance_sync_runs[\s\S]*'failed'/)).toHaveLength(1);
    const fail = d.find(/consecutive_failures = consecutive_failures \+ 1/)[0];
    expect(fail.params[1]).toMatch(/503/);
    expect(d.find(/cdc_cursor = \$2/)).toHaveLength(0); // cursor never advances on failure
    expect(alerts.notifySyncFailure).toHaveBeenCalledWith(expect.objectContaining({ school: SCHOOL, consecutiveFailures: 3 }));
  });

  it('does not alert on the first failure', async () => {
    fakeDb(connection({ cdc_cursor: '2026-09-27T14:30:00Z', backfill_completed_at: '2026-09-01T00:00:00Z', consecutive_failures: 0 }));
    fakeQbo().cdc.mockRejectedValueOnce(new Error('boom'));
    await expect(sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW })).rejects.toThrow();
    expect(alerts.notifySyncFailure).not.toHaveBeenCalled();
  });

  it('marks the connection needs_reconnect and alerts immediately when the grant is dead', async () => {
    const d = fakeDb(connection({ cdc_cursor: '2026-09-27T14:30:00Z', backfill_completed_at: '2026-09-01T00:00:00Z' }));
    fakeQbo().cdc.mockRejectedValueOnce(new NeedsReconnectError());
    await expect(sync.runSync(SCHOOL, { kind: 'cdc', now: () => NOW })).rejects.toBeInstanceOf(NeedsReconnectError);
    expect(alerts.notifySyncFailure).toHaveBeenCalledWith(expect.objectContaining({ needsReconnect: true }));
    // Otherwise the 15-minute schedule re-creates a job every tick and burns a refresh token each time.
    expect(d.find(/needs_reconnect/)).toHaveLength(1);
  });

  it('refuses to sync a school that is not connected', async () => {
    fakeDb(connection({ status: 'disconnected' }));
    await expect(sync.runSync(SCHOOL, { now: () => NOW })).rejects.toBeInstanceOf(NeedsReconnectError);
  });
});
