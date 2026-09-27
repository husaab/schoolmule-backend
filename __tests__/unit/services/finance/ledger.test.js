const { buildFamilyLedger, buildGrantLedger, monthKeys } = require('../../../../services/finance/ledger');

const TODAY = '2026-10-15';
const MONTHS = monthKeys('2026-09-07', '2027-06-25');

const inv = (over = {}) => ({
  qboId: 'i1', docNumber: '9480', txnDate: '2026-09-01', dueDate: '2026-10-01', totalAmt: 1400, balance: 1400,
  kind: 'parent', isVoided: false, deletedAt: null, lines: [], ...over,
});
const app = (over = {}) => ({ paymentQboId: 'p1', invoiceQboId: 'i1', amount: 0, paymentDate: '2026-09-20', paymentDeleted: false, ...over });
const pay = (over = {}) => ({ qboId: 'p1', txnDate: '2026-09-20', totalAmt: 0, unappliedAmt: 0, deletedAt: null, ...over });
const items = { tuition: '4', registration: '16', discount: '19' };

const ledger = (invoices, applications = [], payments = [], extra = {}) =>
  buildFamilyLedger({ months: MONTHS, today: TODAY, invoices, applications, payments, items, ...extra });

describe('monthKeys', () => {
  it('lists every month from the year start to the year end', () => {
    expect(MONTHS).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']);
  });
});

describe('buildFamilyLedger', () => {
  it('Amal Haddad: Sept overdue, Oct unpaid, rest none, registration split out', () => {
    const l = ledger([
      inv({ lines: [
        { description: 'Lina Haddad - Grade 4 - Tuition September 2026', amount: 500, itemRef: '4' },
        { description: 'Nour Haddad - Grade 7 - Tuition September 2026', amount: 500, itemRef: '4' },
        { description: 'Registration Fee 2026-2027 - Lina Haddad', amount: 200, itemRef: '16' },
        { description: 'Registration Fee 2026-2027 - Nour Haddad', amount: 200, itemRef: '16' },
      ] }),
      inv({ qboId: 'i2', docNumber: null, txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 1000, balance: 1000 }),
    ]);
    expect(l.parent.cells['2026-09']).toMatchObject({ invoiced: 1400, paid: 0, balance: 1400, status: 'overdue', daysOverdue: 14 });
    expect(l.parent.cells['2026-09'].invoices[0].breakdown).toEqual({ tuition: 1000, registration: 400, discounts: 0, subsidyDeduction: 0, other: 0 });
    expect(l.parent.cells['2026-10']).toMatchObject({ invoiced: 1000, paid: 0, balance: 1000, status: 'unpaid', daysOverdue: 0 });
    expect(l.parent.cells['2026-11'].status).toBe('none');
    expect(l.parent.totals).toEqual({ invoiced: 2400, paid: 0, balance: 2400, overdueBalance: 1400 });
    expect(l.grant.totals.invoiced).toBe(0);
    expect(l.credit).toBe(0);
  });

  it('Rania Saleh: parent paid, grant invoice separate and overdue', () => {
    const l = ledger([
      inv({ qboId: 'i1', docNumber: '9506', totalAmt: 900, balance: 0, lines: [
        { description: 'Omar Saleh - Grade 4 - Tuition September 2026', amount: 500, itemRef: '4' },
        { description: 'Dana Saleh - Grade 7 - Tuition September 2026', amount: 500, itemRef: '4' },
        { description: "Al-Ma'arif Subsidy - Omar Saleh", amount: -250, itemRef: '19' },
        { description: "Al-Ma'arif Subsidy - Dana Saleh", amount: -250, itemRef: '19' },
        { description: 'Registration Fee 2026-2027 - Omar Saleh', amount: 200, itemRef: '16' },
        { description: 'Registration Fee 2026-2027 - Dana Saleh', amount: 200, itemRef: '16' },
      ] }),
      inv({ qboId: 'i2', docNumber: '9507', kind: 'subsidy_grant', totalAmt: 500, balance: 500 }),
      inv({ qboId: 'i3', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 500, balance: 500 }),
      inv({ qboId: 'i4', txnDate: '2026-10-01', dueDate: '2026-10-31', kind: 'subsidy_grant', totalAmt: 500, balance: 500 }),
    ], [app({ invoiceQboId: 'i1', amount: 900 })], [pay({ totalAmt: 900 })]);
    const sept = l.parent.cells['2026-09'];
    expect(sept).toMatchObject({ invoiced: 900, paid: 900, balance: 0, status: 'paid' });
    expect(sept.payments).toEqual([{ paymentId: 'p1', invoiceId: 'i1', date: '2026-09-20', amount: 900, dateBeforeInvoice: false }]);
    expect(sept.invoices[0].breakdown).toMatchObject({ tuition: 1000, registration: 400, subsidyDeduction: -500 });
    expect(l.parent.cells['2026-10'].status).toBe('unpaid');
    expect(l.grant.cells['2026-09']).toMatchObject({ invoiced: 500, paid: 0, balance: 500, status: 'overdue' });
    expect(l.grant.cells['2026-10'].status).toBe('unpaid');
    expect(l.grant.totals).toEqual({ invoiced: 1000, paid: 0, balance: 1000, overdueBalance: 500 });
  });

  it('Maha Younes: registration-only parent invoice, school-applied subsidy kept out of the grant', () => {
    const l = ledger([
      inv({ qboId: 'i1', totalAmt: 200, balance: 200, lines: [{ description: 'Registration Fee 2026-2027 - Sara Younes', amount: 200, itemRef: '16' }] }),
      inv({ qboId: 'i2', kind: 'subsidy_school', totalAmt: 250, balance: 250 }),
      inv({ qboId: 'i3', kind: 'subsidy_school', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 250, balance: 250 }),
    ]);
    expect(l.parent.cells['2026-09']).toMatchObject({ invoiced: 200, balance: 200, status: 'overdue' });
    expect(l.parent.cells['2026-09'].invoices[0].breakdown.registration).toBe(200);
    expect(l.parent.cells['2026-10'].status).toBe('none');
    expect(l.grant.totals.invoiced).toBe(0);
    expect(l.schoolSubsidy.cells['2026-09']).toMatchObject({ invoiced: 250, balance: 250, status: 'overdue' });
    expect(l.schoolSubsidy.totals.invoiced).toBe(500);
  });

  it('partial payment: partial before the due date, overdue after it', () => {
    const invoices = [inv({ balance: 400 })];
    const apps = [app({ amount: 1000, paymentDate: '2026-09-15' })];
    expect(ledger(invoices, apps).parent.cells['2026-09']).toMatchObject({ invoiced: 1400, paid: 1000, balance: 400, status: 'overdue' });
    const early = buildFamilyLedger({ months: MONTHS, today: '2026-09-20', invoices, applications: apps, payments: [], items });
    expect(early.parent.cells['2026-09'].status).toBe('partial');
  });

  it('split payment across two invoices plus an unapplied credit', () => {
    const l = ledger(
      [inv({ balance: 0 }), inv({ qboId: 'i2', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 1000, balance: 0 })],
      [app({ paymentQboId: 'p3', invoiceQboId: 'i1', amount: 400, paymentDate: '2026-10-05' }), app({ paymentQboId: 'p3', invoiceQboId: 'i2', amount: 1000, paymentDate: '2026-10-05' })],
      [pay({ qboId: 'p3', txnDate: '2026-10-05', totalAmt: 1500, unappliedAmt: 100 })],
    );
    expect(l.parent.cells['2026-09']).toMatchObject({ status: 'paid', paid: 1400 });
    expect(l.parent.cells['2026-09'].payments).toEqual([{ paymentId: 'p3', invoiceId: 'i1', date: '2026-10-05', amount: 400, dateBeforeInvoice: false }]);
    expect(l.parent.cells['2026-10'].payments[0].amount).toBe(1000);
    expect(l.credit).toBe(100);
  });

  it('voided invoices are listed but excluded from the sums', () => {
    const both = ledger([
      inv({ qboId: 'a', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 0, balance: 0, isVoided: true }),
      inv({ qboId: 'b', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 1000, balance: 1000 }),
    ]);
    expect(both.parent.cells['2026-10']).toMatchObject({ invoiced: 1000, balance: 1000, status: 'unpaid' });
    expect(both.parent.cells['2026-10'].invoices.find((i) => i.id === 'a').voided).toBe(true);
    const only = ledger([inv({ qboId: 'a', txnDate: '2026-10-01', totalAmt: 0, balance: 0, isVoided: true })]);
    expect(only.parent.cells['2026-10']).toMatchObject({ invoiced: 0, paid: 0, balance: 0, status: 'voided' });
  });

  it('deleted invoices behave like voided ones', () => {
    const l = ledger([inv({ deletedAt: '2026-09-28T00:00:00Z' })]);
    expect(l.parent.cells['2026-09'].status).toBe('voided');
    expect(l.parent.cells['2026-09'].invoices[0].deleted).toBe(true);
  });

  it('a mis-dated payment still pays the invoice and raises a warning', () => {
    const l = ledger(
      [inv({ qboId: 'i2', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 1000, balance: 0 })],
      [app({ paymentQboId: 'p4', invoiceQboId: 'i2', amount: 1000, paymentDate: '2025-10-05' })],
      [pay({ qboId: 'p4', txnDate: '2025-10-05', totalAmt: 1000 })],
    );
    expect(l.parent.cells['2026-10']).toMatchObject({ status: 'paid', paid: 1000 });
    expect(l.parent.cells['2026-10'].payments[0]).toMatchObject({ date: '2025-10-05', dateBeforeInvoice: true });
    expect(l.warnings).toContainEqual(expect.objectContaining({ code: 'MISDATED_PAYMENT', month: '2026-10' }));
  });

  it('a balance reduced without any payment is flagged as unexplained', () => {
    const l = ledger([inv({ balance: 400 })]);
    expect(l.parent.cells['2026-09']).toMatchObject({ paid: 1000, status: 'overdue' });
    expect(l.parent.cells['2026-09'].payments).toEqual([]);
    expect(l.warnings).toContainEqual(expect.objectContaining({ code: 'UNEXPLAINED_PAID', month: '2026-09', amount: 1000 }));
  });

  it('two parent invoices in one month are flagged', () => {
    const l = ledger([
      inv({ qboId: 'a', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 500, balance: 500 }),
      inv({ qboId: 'b', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 500, balance: 500 }),
    ]);
    expect(l.parent.cells['2026-10'].invoiced).toBe(1000);
    expect(l.warnings).toContainEqual(expect.objectContaining({ code: 'TWO_PARENT_INVOICES_IN_MONTH', month: '2026-10' }));
  });

  it('invoices outside the school year go to outOfRange, and "other" kinds are flagged', () => {
    const l = ledger([
      inv({ qboId: 'aug', txnDate: '2026-08-15', dueDate: '2026-09-14', totalAmt: 200, balance: 0 }),
      inv({ qboId: 'trip', kind: 'other', txnDate: '2026-10-03', totalAmt: 40, balance: 40 }),
    ]);
    expect(l.outOfRange.map((i) => i.id)).toEqual(['aug']);
    expect(l.parent.totals.invoiced).toBe(0);
    expect(l.warnings).toContainEqual(expect.objectContaining({ code: 'OTHER_KIND_INVOICE', invoiceId: 'trip' }));
  });

  it('flags a month whose tuition (invoice minus registration lines) differs from the expected amount', () => {
    const l = ledger(
      [inv({ qboId: 'i2', txnDate: '2026-10-01', dueDate: '2026-10-31', totalAmt: 900, balance: 900 })],
      [], [], { expected: { monthlyParent: 1000 } },
    );
    expect(l.warnings).toContainEqual(expect.objectContaining({ code: 'AMOUNT_DIFFERS', month: '2026-10', expected: 1000, actual: 900 }));
    // September carries registration lines on top of tuition; only the tuition part is compared.
    const regLines = [
      { description: 'Mariam - Grade 4 - Tuition September 2026', amount: 500, itemRef: '4' },
      { description: 'Zahraa - Grade 7 - Tuition September 2026', amount: 500, itemRef: '4' },
      { description: 'Registration Fee 2026-2027 - Mariam', amount: 200, itemRef: '16' },
      { description: 'Registration Fee 2026-2027 - Zahraa', amount: 200, itemRef: '16' },
    ];
    const sept = ledger([inv({ totalAmt: 1400, balance: 1400, lines: regLines })], [], [], { expected: { monthlyParent: 1000 } });
    expect(sept.warnings.some((w) => w.code === 'AMOUNT_DIFFERS')).toBe(false);
    // A family that pre-paid registration in August has no registration line: still no warning.
    const prepaid = ledger([inv({ totalAmt: 1000, balance: 1000, lines: regLines.slice(0, 2) })], [], [], { expected: { monthlyParent: 1000 } });
    expect(prepaid.warnings.some((w) => w.code === 'AMOUNT_DIFFERS')).toBe(false);
    // The actual reported is the tuition part, so the admin sees like for like.
    const wrong = ledger([inv({ totalAmt: 1300, balance: 1300, lines: [...regLines.slice(0, 1), ...regLines.slice(2)] })], [], [], { expected: { monthlyParent: 1000 } });
    expect(wrong.warnings).toContainEqual(expect.objectContaining({ code: 'AMOUNT_DIFFERS', month: '2026-09', expected: 1000, actual: 900 }));
  });

  it('treats sub-cent balances as paid', () => {
    const l = ledger([inv({ balance: 0.004 })]);
    expect(l.parent.cells['2026-09'].status).toBe('paid');
  });
});

describe('buildGrantLedger', () => {
  it('sums every family\'s grant stream and keeps a per-family breakdown', () => {
    const a = ledger([inv({ kind: 'subsidy_grant', totalAmt: 500, balance: 500 })]);
    const b = ledger([inv({ qboId: 'x', kind: 'subsidy_grant', totalAmt: 250, balance: 0 })], [app({ invoiceQboId: 'x', amount: 250 })], [pay({ totalAmt: 250 })]);
    const g = buildGrantLedger([{ familyId: 'fa', name: 'Saleh', ledger: a.grant }, { familyId: 'fb', name: 'Younes', ledger: b.grant }], MONTHS, TODAY);
    expect(g.cells['2026-09']).toMatchObject({ invoiced: 750, paid: 250, balance: 500, status: 'overdue' });
    expect(g.cells['2026-10'].status).toBe('none');
    expect(g.totals).toEqual({ invoiced: 750, paid: 250, balance: 500, overdueBalance: 500 });
    expect(g.byFamily.map((f) => f.familyId)).toEqual(['fa', 'fb']);
    expect(g.byFamily[0].cells['2026-09'].balance).toBe(500);
  });
});
