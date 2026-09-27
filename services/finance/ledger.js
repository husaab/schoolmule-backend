// services/finance/ledger.js
//
// Turns a family's cached QBO invoices and payments into the month-by-month
// cells the Tuition grid shows. Pure and DB-free; every rule that decides
// what a family "owes" lives here and is unit-tested against fixtures.
//
// Ground rules (see the plan):
//   • paid = total − balance. QBO's invoice Balance is the truth; payment
//     records are only for showing *when* money arrived, because one
//     e-transfer is often split into several Payments and some are mis-dated.
//   • Voided and deleted invoices are listed but never summed.
//   • The three streams never mix: parent (family owes), grant (Al-Ma'arif
//     owes), schoolSubsidy (nobody external owes — shown for completeness).

const { round2, groupBy } = require('./util');

const EPSILON = 0.005;

const utcDay = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const daysBetween = (fromIso, toIso) => Math.round((utcDay(toIso) - utcDay(fromIso)) / 86400000);

/** 'YYYY-MM' for every month from the year's start date to its end date, inclusive. */
function monthKeys(startDate, endDate) {
  const keys = [];
  let y = +startDate.slice(0, 4);
  let m = +startDate.slice(5, 7);
  const endY = +endDate.slice(0, 4);
  const endM = +endDate.slice(5, 7);
  while (y < endY || (y === endY && m <= endM)) {
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return keys;
}

const STREAM_OF = { parent: 'parent', subsidy_grant: 'grant', subsidy_school: 'schoolSubsidy' };

function breakdownOf(lines, items) {
  const b = { tuition: 0, registration: 0, discounts: 0, subsidyDeduction: 0, other: 0 };
  for (const l of lines || []) {
    const amt = Number(l.amount) || 0;
    if (l.itemRef === items.tuition && amt > 0) b.tuition += amt;
    else if (l.itemRef === items.registration) b.registration += amt;
    else if (l.itemRef === items.discount || amt < 0) {
      if (/subsidy/i.test(l.description || '')) b.subsidyDeduction += amt;
      else b.discounts += amt;
    } else b.other += amt;
  }
  for (const k of Object.keys(b)) b[k] = round2(b[k]);
  return b;
}

function invoiceEntry(inv, items) {
  return {
    id: inv.qboId,
    docNumber: inv.docNumber ?? null,
    txnDate: inv.txnDate,
    dueDate: inv.dueDate ?? null,
    total: round2(Number(inv.totalAmt) || 0),
    balance: round2(Number(inv.balance) || 0),
    kind: inv.kind,
    voided: Boolean(inv.isVoided),
    deleted: Boolean(inv.deletedAt),
    breakdown: breakdownOf(inv.lines, items),
  };
}

const isActive = (e) => !e.voided && !e.deleted;

/** The status and sums for one month of one stream. Shared by family and grant rows. */
function summarizeCell(invoices, payments, today) {
  const active = invoices.filter(isActive);
  const invoiced = round2(active.reduce((s, e) => s + e.total, 0));
  const balance = round2(active.reduce((s, e) => s + e.balance, 0));
  const paid = round2(invoiced - balance);

  const unpaid = active.filter((e) => e.balance > EPSILON);
  const overdue = unpaid.filter((e) => e.dueDate && today > e.dueDate);

  let status;
  if (invoices.length === 0) status = 'none';
  else if (active.length === 0) status = 'voided';
  else if (overdue.length > 0) status = 'overdue';
  else if (balance <= EPSILON) status = 'paid';
  else if (paid > EPSILON) status = 'partial';
  else status = 'unpaid';

  const daysOverdue = overdue.length ? Math.max(...overdue.map((e) => daysBetween(e.dueDate, today))) : 0;
  const overdueBalance = round2(overdue.reduce((s, e) => s + e.balance, 0));

  return { status, invoiced, paid, balance, daysOverdue, overdueBalance, invoices, payments };
}

function emptyLedger(months) {
  const cells = {};
  for (const m of months) cells[m] = { status: 'none', invoiced: 0, paid: 0, balance: 0, daysOverdue: 0, invoices: [], payments: [] };
  return { cells, totals: { invoiced: 0, paid: 0, balance: 0, overdueBalance: 0 } };
}

function finishLedger(ledger) {
  const t = { invoiced: 0, paid: 0, balance: 0, overdueBalance: 0 };
  for (const cell of Object.values(ledger.cells)) {
    t.invoiced += cell.invoiced; t.paid += cell.paid; t.balance += cell.balance;
    t.overdueBalance += cell.overdueBalance || 0;
    delete cell.overdueBalance; // internal
  }
  ledger.totals = { invoiced: round2(t.invoiced), paid: round2(t.paid), balance: round2(t.balance), overdueBalance: round2(t.overdueBalance) };
  return ledger;
}

/**
 * @param {object} in
 * @param {string[]} in.months        from monthKeys()
 * @param {string}   in.today         'YYYY-MM-DD' (Toronto date)
 * @param {object[]} in.invoices      camelCase rows: qboId, docNumber, txnDate, dueDate, totalAmt, balance, kind, isVoided, deletedAt, lines[{description, amount, itemRef}]
 * @param {object[]} in.applications  paymentQboId, invoiceQboId, amount, paymentDate, paymentDeleted
 * @param {object[]} in.payments      qboId, txnDate, totalAmt, unappliedAmt, deletedAt (customer-level, for credit)
 * @param {object}   in.items         { tuition, registration, discount } item ids
 * @param {object}   [in.expected]    { monthlyParent, studentCount, registrationFee } for the amount-differs check
 */
function buildFamilyLedger({ months, today, invoices = [], applications = [], payments = [], items, expected }) {
  const streams = { parent: emptyLedger(months), grant: emptyLedger(months), schoolSubsidy: emptyLedger(months) };
  const warnings = [];
  const outOfRange = [];
  const monthSet = new Set(months);

  // Bucket invoices by stream and month.
  const buckets = { parent: {}, grant: {}, schoolSubsidy: {} };
  const entryById = new Map();
  for (const inv of invoices) {
    const entry = invoiceEntry(inv, items);
    entryById.set(entry.id, entry);
    const month = inv.txnDate.slice(0, 7);
    if (!monthSet.has(month)) { outOfRange.push(entry); continue; }
    const stream = STREAM_OF[inv.kind];
    if (!stream) { warnings.push({ code: 'OTHER_KIND_INVOICE', month, invoiceId: entry.id, detail: inv.kind }); continue; }
    (buckets[stream][month] ||= []).push(entry);
  }

  // Applications, keyed by invoice, for the payment lists.
  const appsByInvoice = groupBy(applications.filter((a) => !a.paymentDeleted), 'invoiceQboId');

  const startYear = +months[0].slice(0, 4);
  const endYear = +months[months.length - 1].slice(0, 4);

  for (const [stream, byMonth] of Object.entries(buckets)) {
    for (const month of months) {
      const cellInvoices = byMonth[month] || [];
      if (cellInvoices.length === 0) continue;

      const cellPayments = [];
      for (const e of cellInvoices) {
        if (!isActive(e)) continue;
        for (const a of appsByInvoice.get(e.id) || []) {
          const year = +a.paymentDate.slice(0, 4);
          if (year < startYear || year > endYear) {
            warnings.push({ code: 'MISDATED_PAYMENT', month, invoiceId: e.id, paymentId: a.paymentQboId, detail: a.paymentDate });
          }
          cellPayments.push({
            paymentId: a.paymentQboId, invoiceId: e.id, date: a.paymentDate, amount: round2(Number(a.amount) || 0),
            dateBeforeInvoice: a.paymentDate < e.txnDate,
          });
        }
      }
      cellPayments.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

      const cell = summarizeCell(cellInvoices, cellPayments, today);
      streams[stream].cells[month] = cell;

      const applied = round2(cellPayments.reduce((s, p) => s + p.amount, 0));
      if (cell.paid - applied > 0.01) {
        warnings.push({ code: 'UNEXPLAINED_PAID', month, amount: round2(cell.paid - applied), stream });
      }
      if (stream === 'parent') {
        const activeCount = cellInvoices.filter(isActive).length;
        if (activeCount > 1) warnings.push({ code: 'TWO_PARENT_INVOICES_IN_MONTH', month, invoiceIds: cellInvoices.filter(isActive).map((e) => e.id) });
        if (expected && typeof expected.monthlyParent === 'number' && activeCount > 0) {
          const registration = month === months[0] ? (expected.studentCount || 0) * (expected.registrationFee || 0) : 0;
          const want = round2(expected.monthlyParent + registration);
          if (Math.abs(cell.invoiced - want) > 0.01) {
            warnings.push({ code: 'AMOUNT_DIFFERS', month, expected: want, actual: cell.invoiced });
          }
        }
      }
    }
  }

  const credit = round2(payments.filter((p) => !p.deletedAt).reduce((s, p) => s + (Number(p.unappliedAmt) || 0), 0));

  return {
    parent: finishLedger(streams.parent),
    grant: finishLedger(streams.grant),
    schoolSubsidy: finishLedger(streams.schoolSubsidy),
    credit,
    warnings,
    outOfRange,
  };
}

/**
 * The pseudo-family row: one stream summed across families.
 * @param {Array<{familyId, name, ledger}>} entries  each family's grant (or schoolSubsidy) Ledger
 */
function buildGrantLedger(entries, months, today) {
  const combined = emptyLedger(months);
  for (const month of months) {
    const invoices = [];
    const payments = [];
    for (const f of entries) {
      const cell = f.ledger.cells[month];
      if (!cell) continue;
      invoices.push(...cell.invoices.map((e) => ({ ...e, familyId: f.familyId, familyName: f.name })));
      payments.push(...cell.payments.map((p) => ({ ...p, familyId: f.familyId })));
    }
    if (invoices.length === 0) continue;
    combined.cells[month] = summarizeCell(invoices, payments, today);
  }
  const byFamily = entries.map((f) => ({ familyId: f.familyId, name: f.name, cells: f.ledger.cells, totals: f.ledger.totals }));
  return { ...finishLedger(combined), byFamily };
}

module.exports = { buildFamilyLedger, buildGrantLedger, monthKeys };
