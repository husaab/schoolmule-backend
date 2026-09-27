// Builders for realistic QuickBooks Online API entities, shaped like the v3
// Accounting API responses (minorversion 75). Defaults describe Al Haadi's
// 2026-27 billing so ledger tests read like the real books.

const META = (t = '2026-09-27T10:00:00-07:00') => ({ CreateTime: t, LastUpdatedTime: t });

function salesLine({ id = '1', num = 1, description, amount, item = '4', itemName = 'In Person Class:School Fees', qty = 1 }) {
  return {
    Id: id, LineNum: num, Description: description, Amount: amount, DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: { ItemRef: { value: item, name: itemName }, Qty: qty, UnitPrice: amount / qty },
  };
}

function subtotalLine(amount) {
  return { Amount: amount, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} };
}

/** A parent invoice: tuition per child (+ optional registration / discount / subsidy lines). */
function invoice({
  id = '21300', docNumber = '9500', customerId = '27', txnDate = '2026-09-01', dueDate = '2026-10-01',
  lines, total, balance, emailStatus = 'EmailSent', privateNote = null, recurring = false,
  lastUpdated = '2026-09-27T10:00:00-07:00', linkedPayments = [],
} = {}) {
  const sales = lines || [salesLine({ description: 'Lina Haddad - Grade 4 - Tuition September 2026', amount: 500 })];
  const sum = sales.reduce((s, l) => s + l.Amount, 0);
  const inv = {
    Id: id, SyncToken: '0', MetaData: META(lastUpdated), DocNumber: docNumber, TxnDate: txnDate, DueDate: dueDate,
    CustomerRef: { value: customerId, name: 'Amal Haddad Karam' },
    Line: [...sales.map((l, i) => ({ ...l, Id: String(i + 1), LineNum: i + 1 })), subtotalLine(sum)],
    TotalAmt: total ?? sum, Balance: balance ?? (total ?? sum), EmailStatus: emailStatus,
    SalesTermRef: { value: '3' }, GlobalTaxCalculation: 'NotApplicable', domain: 'QBO', sparse: false,
    LinkedTxn: linkedPayments.map((p) => ({ TxnId: p, TxnType: 'Payment' })),
  };
  if (privateNote) inv.PrivateNote = privateNote;
  if (recurring) inv.RecurDataRef = { value: '21421' };
  if (docNumber === null) delete inv.DocNumber;
  return inv;
}

/** A subsidy invoice as the Sept script wrote them (never emailed). */
function subsidyInvoice({ student = 'Omar Saleh', grade = 'Grade 4', amount = 250, school = false, ...rest } = {}) {
  const prefix = school ? 'Subsidy share' : "Al-Ma'arif Subsidy share";
  return invoice({
    emailStatus: 'NotSet',
    privateNote: school
      ? "School-applied subsidy portion (not Al-Ma'arif) - do not email"
      : "Al-Ma'arif subsidy portion - to be paid from grant transfer, do not email",
    lines: [salesLine({ description: `${prefix} - ${student} - ${grade} - September 2026`, amount })],
    ...rest,
  });
}

/** A payment applied to one or more invoices. `applied` = [{invoiceId, amount}]. */
function payment({
  id = '22000', customerId = '27', txnDate = '2026-09-20', total, unapplied = 0, applied = [],
  refNum = 'E-transfer', lastUpdated = '2026-09-27T10:00:00-07:00',
} = {}) {
  const appliedSum = applied.reduce((s, a) => s + a.amount, 0);
  return {
    Id: id, SyncToken: '0', MetaData: META(lastUpdated), TxnDate: txnDate,
    CustomerRef: { value: customerId, name: 'Amal Haddad Karam' },
    DepositToAccountRef: { value: '59', name: 'Checking (0000)' },
    TotalAmt: total ?? appliedSum + unapplied, UnappliedAmt: unapplied, PaymentRefNum: refNum,
    PaymentMethodRef: { value: '2', name: 'E-Transfer' }, ProcessPayment: false, domain: 'QBO', sparse: false,
    Line: applied.map((a) => ({ Amount: a.amount, LinkedTxn: [{ TxnId: a.invoiceId, TxnType: 'Invoice' }] })),
  };
}

function customer({
  id = '27', displayName = 'Amal Haddad Karam', email = 'amal.haddad@example.com', active = true,
  parentId = null, balance = 0, lastUpdated = '2026-09-27T10:00:00-07:00',
} = {}) {
  const c = {
    Id: id, SyncToken: '2', MetaData: META(lastUpdated), DisplayName: displayName,
    FullyQualifiedName: parentId ? `Parent:${displayName}` : displayName,
    Active: active, Job: Boolean(parentId), Balance: balance, BalanceWithJobs: balance, domain: 'QBO', sparse: false,
  };
  if (email) c.PrimaryEmailAddr = { Address: email };
  if (parentId) c.ParentRef = { value: parentId };
  return c;
}

/** A CDC response body: one QueryResponse block per requested entity. */
function cdcResponse({ invoices = [], payments = [], customers = [], deleted = {}, cap = false } = {}) {
  const del = (type) => (deleted[type] || []).map((id) => ({
    Id: id, status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-27T11:00:00-07:00' },
  }));
  const block = (key, rows) => ({ [key]: [...rows, ...del(key)], startPosition: 1, maxResults: cap ? 1000 : rows.length });
  return {
    CDCResponse: [{ QueryResponse: [block('Invoice', invoices), block('Payment', payments), block('Customer', customers)] }],
    time: '2026-09-27T11:00:01-07:00',
  };
}

function queryResponse(entity, rows, { startPosition = 1 } = {}) {
  return { QueryResponse: rows.length ? { [entity]: rows, startPosition, maxResults: rows.length } : {}, time: '2026-09-27T11:00:01-07:00' };
}

module.exports = { salesLine, subtotalLine, invoice, subsidyInvoice, payment, customer, cdcResponse, queryResponse };
