// The same rules, run against payloads captured from the live realm on
// 2026-09-27 (emails and addresses redacted). If Intuit changes a shape, this
// is the suite that notices.
const { normalizeInvoice, parseCdc, normalizePayment, normalizeCustomer } = require('../../../../services/finance/normalize');
const subsidy = require('../../../fixtures/qbo/invoice-subsidy-9507.json');
const parent = require('../../../fixtures/qbo/invoice-parent-9506.json');
const voided = require('../../../fixtures/qbo/invoice-voided.json');
const cdc = require('../../../fixtures/qbo/cdc-sample.json');

describe('real QBO payloads', () => {
  it('classifies the real September subsidy invoice and keeps only sales lines', () => {
    const row = normalizeInvoice(subsidy);
    expect(row).toMatchObject({ qbo_id: '21312', doc_number: '9507', customer_qbo_id: '670', txn_date: '2026-09-01', due_date: '2026-10-01',
      total_amt: 500, balance: 500, email_status: 'NotSet', kind_auto: 'subsidy_grant', is_voided: false, recurring_ref: null });
    expect(row.last_updated_time).toBe('2026-09-27T11:31:28-07:00');
    expect(row.lines.map((l) => [l.student_hint, l.amount, l.item_ref])).toEqual([['Student One', 250, '4'], ['Student Two', 250, '4']]);
  });

  it('classifies the matching parent invoice as parent despite its negative subsidy lines', () => {
    const row = normalizeInvoice(parent);
    expect(row).toMatchObject({ qbo_id: '21311', doc_number: '9506', kind_auto: 'parent', total_amt: 900, email_status: 'EmailSent' });
    const byItem = row.lines.reduce((m, l) => ({ ...m, [l.item_ref]: (m[l.item_ref] || 0) + l.amount }), {});
    expect(byItem).toEqual({ 4: 1000, 19: -500, 16: 400 });
  });

  it('recognizes QBO\'s voided-invoice shape (zero total, "Voided" note, no lines)', () => {
    const row = normalizeInvoice(voided);
    expect(row.is_voided).toBe(true);
    expect(row.kind_auto).toBe('other');
    expect(row.lines).toEqual([]);
  });

  it('parses a real CDC response with inline deletions', () => {
    const out = parseCdc(cdc);
    expect(out.Invoice.upserts.length).toBeGreaterThan(0);
    expect(out.Invoice.deleted.map((d) => d.id)).toEqual(expect.arrayContaining(['21285', '12473', '21237']));
    expect(out.Invoice.deleted[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.truncated).toBe(false);
    for (const inv of out.Invoice.upserts) expect(() => normalizeInvoice(inv)).not.toThrow();
    for (const p of out.Payment.upserts) expect(normalizePayment(p).qbo_id).toMatch(/^\d+$/);
    for (const c of out.Customer.upserts) expect(normalizeCustomer(c).display_name).toBeTruthy();
  });
});
