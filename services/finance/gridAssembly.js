// services/finance/gridAssembly.js
//
// Joins the cached QBO rows to the family model and produces the Tuition page
// payload. Pure: takes rows, returns JSON. The controller only fetches.
//
// An invoice belongs to the family whose customer link covers its TxnDate;
// invoices under no link are the "unlinked customers" the admin must resolve.

const { buildFamilyLedger, buildGrantLedger, monthKeys } = require('./ledger');
const { resolveSettings } = require('./classify');
const { num, round2, dateStr, groupBy } = require('./util');

const inRange = (date, from, to) => date >= from && (to === null || date <= to);

/** The school year's months and the first/last calendar days they span. */
function monthWindow(year) {
  const months = monthKeys(dateStr(year.start_date), dateStr(year.end_date));
  const last = months[months.length - 1];
  const [y, m] = last.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { months, from: `${months[0]}-01`, to: `${last}-${String(lastDay).padStart(2, '0')}` };
}

function toLedgerInvoice(row, linesByInvoice) {
  return {
    qboId: row.qbo_id,
    docNumber: row.doc_number ?? null,
    txnDate: dateStr(row.txn_date),
    dueDate: dateStr(row.due_date),
    totalAmt: num(row.total_amt),
    balance: num(row.balance),
    kind: row.kind,
    isVoided: Boolean(row.is_voided),
    deletedAt: row.deleted_at ?? null,
    lines: (linesByInvoice.get(row.qbo_id) || []).map((l) => ({ description: l.description, amount: num(l.amount), itemRef: l.item_ref })),
  };
}

function toLedgerApplication(row) {
  return {
    paymentQboId: row.payment_qbo_id,
    invoiceQboId: row.invoice_qbo_id,
    amount: num(row.amount),
    paymentDate: dateStr(row.payment_date),
    paymentDeleted: Boolean(row.payment_deleted),
  };
}

function toLedgerPayment(row) {
  return { qboId: row.qbo_id, txnDate: dateStr(row.txn_date), totalAmt: num(row.total_amt), unappliedAmt: num(row.unapplied_amt), deletedAt: row.deleted_at ?? null };
}

const hasAnyInvoice = (ledger) => Object.values(ledger.cells).some((c) => c.status !== 'none');

function shapeSync(sync, now) {
  if (!sync) return { connected: false, status: null, lastSuccessAt: null, lastError: null, pendingSync: false, needsFullRefresh: false };
  const cursor = sync.cdc_cursor ? new Date(sync.cdc_cursor).getTime() : null;
  return {
    connected: Boolean(sync.connected),
    status: sync.status ?? null,
    lastSuccessAt: sync.last_success_at ?? null,
    lastError: sync.last_error ?? null,
    pendingSync: Boolean(sync.pending),
    needsFullRefresh: cursor !== null && now - cursor > 29 * 24 * 3600 * 1000,
  };
}

/**
 * Resolves which family (if any) an invoice belongs to, honouring link date
 * ranges. Shared by the grid and the family detail.
 */
function buildLinkIndex(links) {
  const byCustomer = new Map();
  for (const l of links) {
    const entry = { familyId: l.family_id, from: dateStr(l.effective_from), to: dateStr(l.effective_to), linkId: l.link_id, customerId: l.qbo_customer_id };
    if (!byCustomer.has(l.qbo_customer_id)) byCustomer.set(l.qbo_customer_id, []);
    byCustomer.get(l.qbo_customer_id).push(entry);
  }
  return {
    familyFor(customerId, txnDate) {
      for (const e of byCustomer.get(customerId) || []) if (inRange(txnDate, e.from, e.to)) return e.familyId;
      return null;
    },
    currentFor(familyId) {
      for (const list of byCustomer.values()) for (const e of list) if (e.familyId === familyId && e.to === null) return e;
      return null;
    },
    customersFor(familyId) {
      const out = new Set();
      for (const list of byCustomer.values()) for (const e of list) if (e.familyId === familyId) out.add(e.customerId);
      return [...out];
    },
  };
}

/**
 * @param {object} in  DB rows (snake_case) — see the controller for the queries
 */
function assembleGrid({ year, today, settings: rawSettings, families, students, contacts, links, customers, invoices, lines, applications, payments, studentsWithoutFamily = 0, sync = null, now = Date.now() }) {
  const settings = resolveSettings(rawSettings || {});
  const months = monthKeys(dateStr(year.start_date), dateStr(year.end_date));
  const monthSet = new Set(months);
  const todayMonth = today.slice(0, 7);
  const asOfMonth = todayMonth < months[0] ? months[0] : todayMonth > months[months.length - 1] ? months[months.length - 1] : todayMonth;

  const linkIndex = buildLinkIndex(links);
  const customerById = new Map(customers.map((c) => [c.qbo_id, c]));
  const studentsByFamily = groupBy(students, 'family_id');
  const contactsByFamily = groupBy(contacts, 'family_id');
  const linesByInvoice = groupBy(lines, 'invoice_qbo_id');
  const appsByInvoice = groupBy(applications, 'invoice_qbo_id');
  const paymentsByCustomer = groupBy(payments, 'customer_qbo_id');

  // Assign invoices to families, or to the unlinked pile.
  const invoicesByFamily = new Map();
  const unlinkedByCustomer = new Map();
  for (const row of invoices) {
    const txnDate = dateStr(row.txn_date);
    const familyId = linkIndex.familyFor(row.customer_qbo_id, txnDate);
    if (familyId) {
      if (!invoicesByFamily.has(familyId)) invoicesByFamily.set(familyId, []);
      invoicesByFamily.get(familyId).push(row);
    } else if (!row.deleted_at && !row.is_voided && monthSet.has(txnDate.slice(0, 7))) {
      const c = customerById.get(row.customer_qbo_id);
      const entry = unlinkedByCustomer.get(row.customer_qbo_id) || {
        qboId: row.customer_qbo_id, displayName: c?.display_name || `Customer ${row.customer_qbo_id}`, invoiceCount: 0, invoiceTotal: 0, openBalance: 0,
        earliestInvoiceDate: txnDate, // where a new link should start to claim everything
      };
      if (txnDate < entry.earliestInvoiceDate) entry.earliestInvoiceDate = txnDate;
      entry.invoiceCount += 1;
      entry.invoiceTotal = round2(entry.invoiceTotal + num(row.total_amt));
      entry.openBalance = round2(entry.openBalance + num(row.balance));
      unlinkedByCustomer.set(row.customer_qbo_id, entry);
    }
  }

  const grantEntries = [];
  const schoolEntries = [];
  const outFamilies = families.map((f) => {
    const famStudents = (studentsByFamily.get(f.family_id) || []).map((s) => ({ studentId: s.student_id, name: s.name, grade: s.grade, isArchived: Boolean(s.is_archived) }));
    const activeStudents = famStudents.filter((s) => !s.isArchived).length;
    const famInvoices = invoicesByFamily.get(f.family_id) || [];
    const famInvoiceIds = new Set(famInvoices.map((i) => i.qbo_id));
    const famApps = [];
    for (const id of famInvoiceIds) for (const a of appsByInvoice.get(id) || []) famApps.push(toLedgerApplication(a));
    const famPayments = linkIndex.customersFor(f.family_id).flatMap((cid) => (paymentsByCustomer.get(cid) || []).map(toLedgerPayment));

    const expectedParent = num(f.expected_monthly_parent);
    const ledger = buildFamilyLedger({
      months, today,
      invoices: famInvoices.map((r) => toLedgerInvoice(r, linesByInvoice)),
      applications: famApps,
      payments: famPayments,
      items: settings.items,
      expected: expectedParent === null ? undefined : { monthlyParent: expectedParent },
    });

    const current = linkIndex.currentFor(f.family_id);
    const customer = current ? customerById.get(current.customerId) : null;
    const warnings = [...ledger.warnings];
    if (!current) warnings.push({ code: 'UNLINKED' });
    if (activeStudents === 0) warnings.push({ code: 'NO_ACTIVE_STUDENTS' });

    if (hasAnyInvoice(ledger.grant)) grantEntries.push({ familyId: f.family_id, name: f.name, ledger: ledger.grant });
    if (hasAnyInvoice(ledger.schoolSubsidy)) schoolEntries.push({ familyId: f.family_id, name: f.name, ledger: ledger.schoolSubsidy });

    return {
      familyId: f.family_id,
      name: f.name,
      isSubsidy: Boolean(f.is_subsidy),
      isTeacher: Boolean(f.is_teacher),
      notes: f.notes ?? null,
      expectedMonthlyParent: expectedParent,
      expectedMonthlySubsidy: num(f.expected_monthly_subsidy),
      rosterFamilyNo: f.roster_family_no ?? null,
      customer: current
        ? { qboId: current.customerId, displayName: customer?.display_name || `Customer ${current.customerId}`, isSubCustomer: Boolean(customer?.is_sub_customer), active: customer ? customer.active !== false : true }
        : null,
      students: famStudents,
      contacts: (contactsByFamily.get(f.family_id) || []).map((c) => ({
        contactId: c.contact_id, name: c.name, email: c.email, phone: c.phone, relation: c.relation, isPrimary: Boolean(c.is_primary), hasAccount: Boolean(c.user_id),
      })),
      parent: ledger.parent,
      credit: ledger.credit,
      warnings,
      outOfRange: ledger.outOfRange,
    };
  });

  const grant = { label: `${settings.grantLabel} Subsidy (grant)`, ...buildGrantLedger(grantEntries, months, today) };
  const schoolSubsidy = { label: 'School-applied subsidy', ...buildGrantLedger(schoolEntries, months, today) };

  const unlinkedCustomers = [...unlinkedByCustomer.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const isOpen = (s) => s === 'unpaid' || s === 'partial' || s === 'overdue';
  const summary = {
    collectedThisMonth: round2(outFamilies.reduce((s, f) => s + f.parent.cells[asOfMonth].paid, 0)),
    outstanding: round2(outFamilies.reduce((s, f) => s + f.parent.totals.balance, 0)),
    overdueTotal: round2(outFamilies.reduce((s, f) => s + f.parent.totals.overdueBalance, 0)),
    subsidyReceivable: grant.totals.balance,
    schoolAppliedSubsidy: schoolSubsidy.totals.balance,
    familiesTotal: outFamilies.length,
    familiesUnpaidThisMonth: outFamilies.filter((f) => isOpen(f.parent.cells[asOfMonth].status)).length,
    familiesOverdue: outFamilies.filter((f) => f.parent.totals.overdueBalance > 0).length,
    unlinkedCustomersWithInvoices: unlinkedCustomers.length,
    unlinkedInvoiceTotal: round2(unlinkedCustomers.reduce((s, c) => s + c.invoiceTotal, 0)),
    studentsWithoutFamily: Number(studentsWithoutFamily) || 0,
  };

  return {
    months, asOfMonth, today,
    year: { label: year.label, startDate: dateStr(year.start_date), endDate: dateStr(year.end_date) },
    sync: shapeSync(sync, now),
    summary,
    families: outFamilies,
    grant,
    schoolSubsidy,
    unlinked: { customers: unlinkedCustomers },
  };
}

module.exports = { assembleGrid, buildLinkIndex, monthWindow, dateStr, toLedgerInvoice, toLedgerApplication, toLedgerPayment };
