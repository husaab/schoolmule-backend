// services/finance/normalize.js
//
// Turns raw QuickBooks Online entities into the flat rows the cache tables
// hold, and parses Change Data Capture responses. Pure: no DB, no HTTP.
//
// The raw payload is always kept alongside the flattened fields so a rule
// (voided detection, classification) can be re-applied later by a re-run
// without another trip to QBO.

const { classifyInvoice } = require('./classify');
const { num, round2 } = require('./util');

const orNull = (v) => (v === undefined || v === '' ? null : v);

// Descriptions come in two shapes: "{Student} - Grade 4 - Tuition …" (name
// first) and "Staff Discount - {Student}" / "Registration Fee 2026-2027 -
// {Student}" / "Al-Ma'arif Subsidy share - {Student} - …" (label first).
const LABEL_FIRST = /^(staff discount|al-ma'arif subsidy( share)?|subsidy share|registration fee.*)$/i;

function studentHint(description) {
  if (!description) return null;
  const parts = String(description).replace(/[‘’]/g, "'").split(/\s+-\s+/);
  if (parts.length < 2) return null;
  const hint = LABEL_FIRST.test(parts[0].trim()) ? parts[1] : parts[0];
  return hint ? hint.trim() : null;
}

const LINE_TYPES = new Set(['SalesItemLineDetail', 'DiscountLineDetail']);

function normalizeLines(raw) {
  const kept = (raw.Line || []).filter((l) => LINE_TYPES.has(l.DetailType));
  return kept.map((l, i) => {
    const detail = l.SalesItemLineDetail || l.DiscountLineDetail || {};
    return {
      line_num: l.LineNum !== undefined ? Number(l.LineNum) : i + 1,
      line_id: orNull(l.Id) ?? null,
      detail_type: l.DetailType,
      description: orNull(l.Description) ?? null,
      amount: num(l.Amount) ?? 0,
      item_ref: detail.ItemRef?.value ?? null,
      item_name: detail.ItemRef?.name ?? null,
      qty: num(detail.Qty),
      unit_price: num(detail.UnitPrice),
      student_hint: studentHint(l.Description),
    };
  });
}

/**
 * QBO keeps a voided invoice as a zeroed row. There is no explicit flag in
 * the API, so: a zero total with either a "Voided" note or every line zeroed.
 */
function isVoided(raw, lines) {
  if (num(raw.TotalAmt) !== 0) return false;
  if (/\bvoided\b/i.test(raw.PrivateNote || '')) return true;
  return lines.every((l) => l.amount === 0);
}

function normalizeInvoice(raw, settings) {
  const lines = normalizeLines(raw);
  return {
    qbo_id: String(raw.Id),
    doc_number: orNull(raw.DocNumber) ?? null,
    customer_qbo_id: String(raw.CustomerRef?.value ?? ''),
    txn_date: raw.TxnDate,
    due_date: orNull(raw.DueDate) ?? null,
    total_amt: num(raw.TotalAmt) ?? 0,
    balance: num(raw.Balance) ?? 0,
    email_status: orNull(raw.EmailStatus) ?? null,
    private_note: orNull(raw.PrivateNote) ?? null,
    customer_memo: orNull(raw.CustomerMemo?.value) ?? null,
    recurring_ref: orNull(raw.RecurDataRef?.value) ?? null,
    sync_token: raw.SyncToken === undefined ? null : Number(raw.SyncToken),
    last_updated_time: raw.MetaData?.LastUpdatedTime ?? null,
    is_voided: isVoided(raw, lines),
    kind_auto: classifyInvoice(raw, settings),
    raw,
    lines,
  };
}

function normalizePayment(raw) {
  const warnings = [];
  const byInvoice = new Map();
  for (const line of raw.Line || []) {
    const links = (line.LinkedTxn || []).filter((t) => t.TxnType === 'Invoice');
    if (links.length === 0) continue;
    if (links.length > 1) warnings.push('MULTI_LINKED_LINE');
    const share = round2(Number(line.Amount || 0) / links.length);
    for (const t of links) {
      const id = String(t.TxnId);
      byInvoice.set(id, round2((byInvoice.get(id) || 0) + share));
    }
  }
  return {
    qbo_id: String(raw.Id),
    customer_qbo_id: String(raw.CustomerRef?.value ?? ''),
    txn_date: raw.TxnDate,
    total_amt: num(raw.TotalAmt) ?? 0,
    unapplied_amt: num(raw.UnappliedAmt) ?? 0,
    payment_method: orNull(raw.PaymentMethodRef?.name) ?? null,
    payment_ref_num: orNull(raw.PaymentRefNum) ?? null,
    private_note: orNull(raw.PrivateNote) ?? null,
    deposit_account: orNull(raw.DepositToAccountRef?.value) ?? null,
    sync_token: raw.SyncToken === undefined ? null : Number(raw.SyncToken),
    last_updated_time: raw.MetaData?.LastUpdatedTime ?? null,
    raw,
    applications: [...byInvoice].map(([invoice_qbo_id, amount]) => ({ invoice_qbo_id, amount })),
    warnings,
  };
}

function splitEmails(address) {
  if (!address) return [];
  return String(address).split(/[,;]/).map((e) => e.trim()).filter((e) => e.includes('@'));
}

function normalizeCustomer(raw) {
  const parent = orNull(raw.ParentRef?.value) ?? null;
  return {
    qbo_id: String(raw.Id),
    display_name: raw.DisplayName || raw.FullyQualifiedName || `Customer ${raw.Id}`,
    fully_qualified_name: orNull(raw.FullyQualifiedName) ?? null,
    parent_qbo_id: parent,
    is_sub_customer: raw.Job === true || parent !== null,
    active: raw.Active !== false,
    balance: num(raw.Balance),
    emails: splitEmails(raw.PrimaryEmailAddr?.Address),
    phone: orNull(raw.PrimaryPhone?.FreeFormNumber) ?? null,
    sync_token: raw.SyncToken === undefined ? null : Number(raw.SyncToken),
    last_updated_time: raw.MetaData?.LastUpdatedTime ?? null,
    raw,
  };
}

const CDC_ENTITIES = ['Invoice', 'Payment', 'Customer'];

/**
 * Splits a CDC response into per-entity upserts and deletions.
 * `truncated` means at least one block hit QBO's 1000-row cap, so the caller
 * must fall back to a windowed query to be sure nothing was missed.
 */
function parseCdc(body) {
  const out = { truncated: false };
  for (const e of CDC_ENTITIES) out[e] = { upserts: [], deleted: [] };

  const blocks = body?.CDCResponse?.[0]?.QueryResponse || [];
  for (const block of blocks) {
    if (Number(block.maxResults) >= 1000) out.truncated = true;
    for (const e of CDC_ENTITIES) {
      for (const row of block[e] || []) {
        if (row.status === 'Deleted') {
          out[e].deleted.push({ id: String(row.Id), at: row.MetaData?.LastUpdatedTime ?? null });
        } else {
          out[e].upserts.push(row);
        }
      }
    }
  }
  return out;
}

module.exports = { normalizeInvoice, normalizePayment, normalizeCustomer, parseCdc, studentHint, splitEmails };
