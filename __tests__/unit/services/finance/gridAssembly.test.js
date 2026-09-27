const { assembleGrid } = require('../../../../services/finance/gridAssembly');

const YEAR = { start_date: '2026-09-07', end_date: '2027-06-25', label: '2026-2027' };
const TODAY = '2026-10-15';

// DB-shaped rows (snake_case, numerics as strings like pg returns them)
const family = (over = {}) => ({ family_id: 'fa', name: 'Rania Saleh', is_subsidy: true, is_teacher: false,
  expected_monthly_parent: '500.00', expected_monthly_subsidy: '500.00', notes: null, roster_family_no: 25, ...over });
const link = (over = {}) => ({ link_id: 'l1', family_id: 'fa', qbo_customer_id: '670', effective_from: '2026-08-01', effective_to: null, ...over });
const inv = (over = {}) => ({ qbo_id: 'i1', customer_qbo_id: '670', doc_number: '9506', txn_date: '2026-09-01', due_date: '2026-10-01',
  total_amt: '900.00', balance: '0.00', kind: 'parent', is_voided: false, deleted_at: null, ...over });

const base = () => ({
  year: YEAR, today: TODAY, settings: {},
  families: [family(), family({ family_id: 'fb', name: 'Maha Younes', roster_family_no: 32, expected_monthly_parent: '0.00', expected_monthly_subsidy: '250.00' })],
  students: [
    { family_id: 'fa', student_id: 's1', name: 'Omar Saleh', grade: '4', is_archived: false },
    { family_id: 'fa', student_id: 's2', name: 'Dana Saleh', grade: '7', is_archived: false },
    { family_id: 'fb', student_id: 's3', name: 'Sara Younes', grade: '7', is_archived: false },
  ],
  contacts: [
    { contact_id: 'c1', family_id: 'fa', name: 'Rania Saleh', email: 'rania.saleh@example.com', phone: null, relation: 'mother', is_primary: true, user_id: null },
    { contact_id: 'c2', family_id: 'fb', name: 'Maha Younes', email: 'maha.younes@example.com', phone: null, relation: 'mother', is_primary: true, user_id: 'u9' },
  ],
  links: [link(), link({ link_id: 'l2', family_id: 'fb', qbo_customer_id: '169' })],
  customers: [
    { qbo_id: '670', display_name: 'Rania Saleh', is_sub_customer: false, active: true },
    { qbo_id: '169', display_name: 'Maha Younes', is_sub_customer: false, active: true },
    { qbo_id: '999', display_name: 'Unknown Donor', is_sub_customer: false, active: true },
  ],
  invoices: [
    inv(), // Saleh parent Sept, paid
    inv({ qbo_id: 'i2', doc_number: '9507', kind: 'subsidy_grant', total_amt: '500.00', balance: '500.00' }),
    inv({ qbo_id: 'i3', doc_number: null, txn_date: '2026-10-01', due_date: '2026-10-31', total_amt: '500.00', balance: '500.00' }),
    inv({ qbo_id: 'i4', customer_qbo_id: '169', doc_number: '9515', total_amt: '200.00', balance: '200.00' }),
    inv({ qbo_id: 'i5', customer_qbo_id: '169', doc_number: '9516', kind: 'subsidy_school', total_amt: '250.00', balance: '250.00' }),
    inv({ qbo_id: 'i6', customer_qbo_id: '999', doc_number: '9600', total_amt: '75.00', balance: '75.00' }),
    inv({ qbo_id: 'i7', customer_qbo_id: '999', doc_number: '9601', total_amt: '25.00', balance: '0.00', is_voided: true }),
  ],
  lines: [
    { invoice_qbo_id: 'i1', description: 'Omar Saleh - Grade 4 - Tuition September 2026', amount: '500.00', item_ref: '4' },
    { invoice_qbo_id: 'i1', description: 'Dana Saleh - Grade 7 - Tuition September 2026', amount: '500.00', item_ref: '4' },
    { invoice_qbo_id: 'i1', description: "Al-Ma'arif Subsidy - Omar Saleh", amount: '-250.00', item_ref: '19' },
    { invoice_qbo_id: 'i1', description: "Al-Ma'arif Subsidy - Dana Saleh", amount: '-250.00', item_ref: '19' },
    { invoice_qbo_id: 'i1', description: 'Registration Fee 2026-2027 - Omar Saleh', amount: '200.00', item_ref: '16' },
    { invoice_qbo_id: 'i1', description: 'Registration Fee 2026-2027 - Dana Saleh', amount: '200.00', item_ref: '16' },
  ],
  applications: [{ payment_qbo_id: 'p1', invoice_qbo_id: 'i1', amount: '900.00', payment_date: '2026-09-20', payment_deleted: false }],
  payments: [{ qbo_id: 'p1', customer_qbo_id: '670', txn_date: '2026-09-20', total_amt: '950.00', unapplied_amt: '50.00', deleted_at: null }],
  studentsWithoutFamily: 2,
  sync: { connected: true, status: 'active', last_success_at: '2026-10-15T10:00:00Z', last_error: null, pending: false },
});

describe('assembleGrid', () => {
  it('builds the months, families, grant row, school-subsidy row and summary', () => {
    const g = assembleGrid(base());

    expect(g.months).toHaveLength(10);
    expect(g.months[0]).toBe('2026-09');
    expect(g.asOfMonth).toBe('2026-10');
    expect(g.today).toBe(TODAY);

    const akbari = g.families.find((f) => f.familyId === 'fa');
    expect(akbari).toMatchObject({ name: 'Rania Saleh', isSubsidy: true, expectedMonthlyParent: 500, credit: 50,
      customer: { qboId: '670', displayName: 'Rania Saleh', isSubCustomer: false } });
    expect(akbari.students.map((s) => s.name)).toEqual(['Omar Saleh', 'Dana Saleh']);
    expect(akbari.contacts[0]).toMatchObject({ name: 'Rania Saleh', isPrimary: true, hasAccount: false });
    expect(akbari.parent.cells['2026-09']).toMatchObject({ status: 'paid', invoiced: 900, paid: 900 });
    expect(akbari.parent.cells['2026-09'].invoices[0].breakdown).toMatchObject({ tuition: 1000, registration: 400, subsidyDeduction: -500 });
    expect(akbari.parent.cells['2026-10']).toMatchObject({ status: 'unpaid', invoiced: 500 });
    expect(akbari.parent.cells['2026-10'].invoices[0].docNumber).toBeNull();
    expect(akbari.parent.totals).toEqual({ invoiced: 1400, paid: 900, balance: 500, overdueBalance: 0 });
    expect(akbari.warnings.map((w) => w.code)).not.toContain('UNLINKED');
    // Sept = 500 tuition + 2 × $200 registration = 900: no false "amount differs" with the default settings.
    expect(akbari.warnings.map((w) => w.code)).not.toContain('AMOUNT_DIFFERS');

    const kassab = g.families.find((f) => f.familyId === 'fb');
    expect(kassab.contacts[0].hasAccount).toBe(true);
    expect(kassab.parent.cells['2026-09']).toMatchObject({ status: 'overdue', invoiced: 200, daysOverdue: 14 });
    expect(kassab.parent.cells['2026-10'].status).toBe('none');
    // Younes's school-applied subsidy is not the grant's problem.
    expect(g.grant.byFamily.map((f) => f.familyId)).toEqual(['fa']);
    expect(g.grant.cells['2026-09']).toMatchObject({ invoiced: 500, balance: 500, status: 'overdue' });
    expect(g.grant.label).toBe("Al-Ma'arif Subsidy (grant)");
    expect(g.schoolSubsidy.cells['2026-09']).toMatchObject({ invoiced: 250, balance: 250 });
    expect(g.schoolSubsidy.byFamily.map((f) => f.familyId)).toEqual(['fb']);

    expect(g.summary).toEqual({
      collectedThisMonth: 0,           // Oct invoices unpaid so far
      outstanding: 700,                // 500 Saleh Oct + 200 Younes Sept
      overdueTotal: 200,
      subsidyReceivable: 500,
      schoolAppliedSubsidy: 250,
      familiesTotal: 2,
      familiesUnpaidThisMonth: 1,      // Saleh Oct unpaid; Younes has no Oct invoice
      familiesOverdue: 1,
      unlinkedCustomersWithInvoices: 1,
      unlinkedInvoiceTotal: 75,
      studentsWithoutFamily: 2,
    });

    expect(g.unlinked.customers).toEqual([{ qboId: '999', displayName: 'Unknown Donor', invoiceCount: 1, invoiceTotal: 75, openBalance: 75, earliestInvoiceDate: '2026-09-01' }]);
    expect(g.sync).toMatchObject({ connected: true, status: 'active', lastSuccessAt: '2026-10-15T10:00:00Z', pendingSync: false });
  });

  it('flags a family with no customer link and one with no active students', () => {
    const input = base();
    input.links = [link({ link_id: 'l2', family_id: 'fb', qbo_customer_id: '169' })]; // Saleh unlinked
    input.students = input.students.map((s) => (s.family_id === 'fb' ? { ...s, is_archived: true } : s));
    const g = assembleGrid(input);
    const akbari = g.families.find((f) => f.familyId === 'fa');
    expect(akbari.customer).toBeNull();
    expect(akbari.warnings.map((w) => w.code)).toContain('UNLINKED');
    expect(akbari.parent.cells['2026-09'].status).toBe('none');
    const kassab = g.families.find((f) => f.familyId === 'fb');
    expect(kassab.warnings.map((w) => w.code)).toContain('NO_ACTIVE_STUDENTS');
    // Saleh's customer now counts as unlinked-with-invoices
    expect(g.unlinked.customers.map((c) => c.qboId).sort()).toEqual(['670', '999']);
  });

  it('honours link date ranges when a family switched customers', () => {
    const input = base();
    input.links = [
      link({ link_id: 'l1', family_id: 'fa', qbo_customer_id: '670', effective_from: '2026-08-01', effective_to: '2026-09-30' }),
      link({ link_id: 'l3', family_id: 'fa', qbo_customer_id: '999', effective_from: '2026-10-01', effective_to: null }),
      link({ link_id: 'l2', family_id: 'fb', qbo_customer_id: '169' }),
    ];
    input.invoices.push(inv({ qbo_id: 'i8', customer_qbo_id: '999', txn_date: '2026-11-01', due_date: '2026-12-01', total_amt: '500.00', balance: '500.00' }));
    const g = assembleGrid(input);
    const akbari = g.families.find((f) => f.familyId === 'fa');
    expect(akbari.customer.qboId).toBe('999');
    expect(akbari.parent.cells['2026-09'].invoiced).toBe(900);   // from 670 while linked
    expect(akbari.parent.cells['2026-10'].status).toBe('none');  // 670's Oct invoice falls outside the range
    expect(akbari.parent.cells['2026-11'].invoiced).toBe(500);   // from 999
    // 670's Oct invoice is now nobody's, and 999's Sept invoice predates its link.
    expect(g.unlinked.customers.map((c) => c.qboId)).toEqual(['670', '999']);
  });

  it('clamps asOfMonth into the school year', () => {
    expect(assembleGrid({ ...base(), today: '2026-07-01' }).asOfMonth).toBe('2026-09');
    expect(assembleGrid({ ...base(), today: '2027-08-01' }).asOfMonth).toBe('2027-06');
  });
});
