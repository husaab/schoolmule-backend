// services/payments/paymentField.js
//
// The rules for a form's payment field, pure so the builder's save, the public
// form and the tests all apply the same ones.
//
// A payment field holds a price list:
//   { items: [{ id, label, amountCents, required }], allowOffline, accountingCode }
// Required items are always charged; optional ones only when the family ticks
// them. The total is always worked out here from the form's own prices: an
// amount sent by the browser is never trusted.

const MAX_ITEMS = 20;
// Stripe's smallest card charge in CAD is 50 cents.
const MIN_ITEM_CENTS = 50;
const MAX_ITEM_CENTS = 1000000; // $10,000.00
const MAX_TOTAL_CENTS = 2000000; // $20,000.00
const CURRENCY = 'cad';

class PaymentFieldError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentFieldError';
    this.status = 400;
  }
}

const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Checks and tidies a payment field's settings as the builder sent them.
 * Throws PaymentFieldError with a message a person can act on.
 */
function normalizePaymentConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaymentFieldError('A payment field needs at least one item with a price');
  const items = Array.isArray(raw.items) ? raw.items : [];
  if (items.length === 0) throw new PaymentFieldError('A payment field needs at least one item with a price');
  if (items.length > MAX_ITEMS) throw new PaymentFieldError(`A payment field can list up to ${MAX_ITEMS} items`);

  const seen = new Set();
  const clean = items.map((item, i) => {
    const id = String(item?.id ?? '');
    if (!ITEM_ID_RE.test(id) || seen.has(id)) throw new PaymentFieldError(`Item ${i + 1} has a missing or repeated id`);
    seen.add(id);
    const label = String(item?.label ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 80);
    if (!label) throw new PaymentFieldError(`Item ${i + 1} needs a name`);
    const amountCents = Number(item?.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < MIN_ITEM_CENTS || amountCents > MAX_ITEM_CENTS) {
      throw new PaymentFieldError(`“${label}” needs a price between ${formatCents(MIN_ITEM_CENTS)} and ${formatCents(MAX_ITEM_CENTS)}`);
    }
    return { id, label, amountCents, required: Boolean(item?.required) };
  });

  const everything = clean.reduce((sum, item) => sum + item.amountCents, 0);
  if (everything > MAX_TOTAL_CENTS) throw new PaymentFieldError(`All the items together can come to at most ${formatCents(MAX_TOTAL_CENTS)}`);

  const code = raw.accountingCode == null ? '' : String(raw.accountingCode).replace(/<[^>]*>/g, '').trim().slice(0, 40);
  return {
    items: clean,
    allowOffline: Boolean(raw.allowOffline),
    accountingCode: code || null,
    currency: CURRENCY,
  };
}

/**
 * What the family owes for what they picked. Required items are always in;
 * an id the field doesn't list is refused rather than ignored.
 * @returns {{ lines: {itemId,label,amountCents}[], totalCents: number }}
 */
function priceSelection(config, selectedIds = []) {
  const items = config?.items || [];
  const wanted = new Set(Array.isArray(selectedIds) ? selectedIds.map(String) : []);
  for (const id of wanted) {
    if (!items.some((item) => item.id === id)) throw new PaymentFieldError('One of the items picked is no longer on this form. Reload the page and try again.');
  }
  const lines = items
    .filter((item) => item.required || wanted.has(item.id))
    .map((item) => ({ itemId: item.id, label: item.label, amountCents: item.amountCents }));
  return { lines, totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0) };
}

const CAD = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** Integer cents as dollars, always with two decimals: 2397 → "$23.97". */
function formatCents(cents) {
  return CAD.format((Number(cents) || 0) / 100);
}

/**
 * The payment field's answer as stored on the response, so exports and a
 * linked sheet read sensibly: "Trip fee $25.00, Pizza lunch $6.00 · Total $31.00 · Paying online".
 */
function summaryAnswer({ lines, totalCents }, method) {
  if (lines.length === 0) return 'Nothing to pay';
  const items = lines.map((line) => `${line.label} ${formatCents(line.amountCents)}`).join(', ');
  const how = method === 'offline' ? 'Paying at the office' : 'Paying online';
  return `${items} · Total ${formatCents(totalCents)} · ${how}`;
}

module.exports = {
  normalizePaymentConfig,
  priceSelection,
  summaryAnswer,
  formatCents,
  PaymentFieldError,
  MAX_ITEMS,
  MIN_ITEM_CENTS,
  MAX_ITEM_CENTS,
  CURRENCY,
};
