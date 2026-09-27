const { normalizeInvoice, normalizePayment, normalizeCustomer, parseCdc } = require('../../../../services/finance/normalize');
const { invoice, subsidyInvoice, payment, customer, salesLine, cdcResponse } = require('../../../helpers/qboFixtures');

describe('normalizeInvoice', () => {
  it('flattens the fields the ledger needs and keeps the raw payload', () => {
    const raw = invoice({ id: '21300', docNumber: '9480', customerId: '27', total: 1400, balance: 400,
      lines: [
        salesLine({ description: 'Lina Haddad - Grade 4 - Tuition September 2026', amount: 500 }),
        salesLine({ description: 'Nour Haddad - Grade 7 - Tuition September 2026', amount: 500 }),
        salesLine({ description: 'Registration Fee 2026-2027 - Lina Haddad', amount: 200, item: '16' }),
        salesLine({ description: 'Registration Fee 2026-2027 - Nour Haddad', amount: 200, item: '16' }),
      ] });
    const row = normalizeInvoice(raw);
    expect(row).toMatchObject({
      qbo_id: '21300', doc_number: '9480', customer_qbo_id: '27', txn_date: '2026-09-01', due_date: '2026-10-01',
      total_amt: 1400, balance: 400, email_status: 'EmailSent', private_note: null, recurring_ref: null,
      sync_token: 0, last_updated_time: '2026-09-27T10:00:00-07:00', is_voided: false, kind_auto: 'parent',
    });
    expect(row.raw).toBe(raw);
    expect(row.lines).toHaveLength(4);
    expect(row.lines[0]).toMatchObject({ line_num: 1, amount: 500, item_ref: '4', student_hint: 'Lina Haddad' });
    expect(row.lines[2]).toMatchObject({ item_ref: '16', student_hint: 'Lina Haddad' });
  });

  it('records a template-generated invoice with a blank number and its RecurDataRef', () => {
    const row = normalizeInvoice(invoice({ docNumber: null, recurring: true }));
    expect(row.doc_number).toBeNull();
    expect(row.recurring_ref).toBe('21421');
  });

  it('classifies subsidy invoices with the school settings', () => {
    expect(normalizeInvoice(subsidyInvoice()).kind_auto).toBe('subsidy_grant');
    expect(normalizeInvoice(subsidyInvoice({ school: true })).kind_auto).toBe('subsidy_school');
  });

  it('flags a voided invoice (zeroed total with a Voided note or all-zero lines)', () => {
    const voided = invoice({ total: 0, balance: 0, privateNote: 'Voided - duplicate' });
    expect(normalizeInvoice(voided).is_voided).toBe(true);
    const zeroLines = invoice({ lines: [salesLine({ description: 'x', amount: 0 })], total: 0, balance: 0 });
    expect(normalizeInvoice(zeroLines).is_voided).toBe(true);
    expect(normalizeInvoice(invoice()).is_voided).toBe(false);
  });

  it('extracts the student hint only from "{Name} - …" descriptions', () => {
    const row = normalizeInvoice(invoice({ lines: [
      salesLine({ description: 'Staff Discount - Hana Mansour', amount: -100, item: '19' }),
      salesLine({ description: 'Hana Mansour - JK - Tuition September 2026', amount: 650 }),
    ] }));
    expect(row.lines[0].student_hint).toBe('Hana Mansour'); // "Staff Discount - X" → trailing name
    expect(row.lines[1].student_hint).toBe('Hana Mansour');
  });
});

describe('normalizePayment', () => {
  it('extracts applications from LinkedTxn invoice lines and the unapplied credit', () => {
    const raw = payment({ id: '22001', customerId: '670', txnDate: '2026-09-20', unapplied: 100,
      applied: [{ invoiceId: '21300', amount: 400 }, { invoiceId: '21301', amount: 1000 }] });
    const row = normalizePayment(raw);
    expect(row).toMatchObject({ qbo_id: '22001', customer_qbo_id: '670', txn_date: '2026-09-20', total_amt: 1500, unapplied_amt: 100,
      payment_ref_num: 'E-transfer', payment_method: 'E-Transfer', deposit_account: '59' });
    expect(row.applications).toEqual([
      { invoice_qbo_id: '21300', amount: 400 },
      { invoice_qbo_id: '21301', amount: 1000 },
    ]);
  });

  it('ignores non-invoice links and splits a line linked to several invoices', () => {
    const raw = payment({ applied: [] });
    raw.Line = [
      { Amount: 300, LinkedTxn: [{ TxnId: '1', TxnType: 'Invoice' }, { TxnId: '2', TxnType: 'Invoice' }] },
      { Amount: 50, LinkedTxn: [{ TxnId: '9', TxnType: 'CreditMemo' }] },
    ];
    const row = normalizePayment(raw);
    expect(row.applications).toEqual([{ invoice_qbo_id: '1', amount: 150 }, { invoice_qbo_id: '2', amount: 150 }]);
    expect(row.warnings).toContain('MULTI_LINKED_LINE');
  });
});

describe('normalizeCustomer', () => {
  it('splits comma-separated emails and marks sub-customers', () => {
    const row = normalizeCustomer(customer({ id: '26', displayName: 'Yara Darwish-Khoury', parentId: '171',
      email: 'rima.darwish@example.com, adel.darwish@example.com', balance: 500 }));
    expect(row).toMatchObject({ qbo_id: '26', display_name: 'Yara Darwish-Khoury', parent_qbo_id: '171', is_sub_customer: true,
      active: true, balance: 500, emails: ['rima.darwish@example.com', 'adel.darwish@example.com'], sync_token: 2 });
  });

  it('handles a customer with no email', () => {
    expect(normalizeCustomer(customer({ email: null })).emails).toEqual([]);
  });
});

describe('parseCdc', () => {
  it('separates upserts from deletions per entity and reports truncation', () => {
    const body = cdcResponse({ invoices: [invoice({ id: '1' })], payments: [payment({ id: '2' })],
      deleted: { Payment: ['3'], Invoice: ['4'] } });
    const out = parseCdc(body);
    expect(out.Invoice.upserts.map((i) => i.Id)).toEqual(['1']);
    expect(out.Invoice.deleted).toEqual([{ id: '4', at: '2026-09-27T11:00:00-07:00' }]);
    expect(out.Payment.deleted).toEqual([{ id: '3', at: '2026-09-27T11:00:00-07:00' }]);
    expect(out.Customer.upserts).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('flags truncation when a block hits the 1000 cap', () => {
    expect(parseCdc(cdcResponse({ cap: true })).truncated).toBe(true);
  });

  it('tolerates an empty response', () => {
    const out = parseCdc({ CDCResponse: [{ QueryResponse: [{}] }] });
    expect(out.Invoice.upserts).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});
