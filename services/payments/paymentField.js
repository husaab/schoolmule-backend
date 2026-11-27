// services/payments/paymentField.js
//
// The rules for a form's payment field, pure so the builder's save, the public
// form and the tests all apply the same ones.
//
// A payment field holds a price list:
//   { items: [{ id, label, amountCents, required, taxRateId }], allowOffline,
//     accountingCode, taxMode }
// Required items are always charged; optional ones only when the family ticks
// them. The total is always worked out here from the form's own prices: an
// amount sent by the browser is never trusted.
//
// Tax: each item names one of the school's rates (or none), and the field
// says whether tax is added on top of its prices or already inside them
// (taxMode 'added' | 'included'). `rates` below is the school's rates by id,
// archived ones too: a form keeps a rate that was removed after it was chosen.

const tax = require('./tax');

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
const BAD_RATE = 'Choose a tax rate from your school’s list';

/** A rates argument as a Map of id → { taxRateId, name, rateMilli, archived }. */
function rateMap(rates) {
  if (rates instanceof Map) return rates;
  if (Array.isArray(rates)) return new Map(rates.map((r) => [r.taxRateId, r]));
  return new Map(Object.entries(rates || {}));
}

/**
 * Checks and tidies a payment field's settings as the builder sent them.
 * Throws PaymentFieldError with a message a person can act on.
 *
 * @param rates        the school's tax rates (archived ones too)
 * @param keepArchived rate ids already on this field: an archived one may stay
 */
function normalizePaymentConfig(raw, { rates, keepArchived } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaymentFieldError('A payment field needs at least one item with a price');
  const items = Array.isArray(raw.items) ? raw.items : [];
  if (items.length === 0) throw new PaymentFieldError('A payment field needs at least one item with a price');
  if (items.length > MAX_ITEMS) throw new PaymentFieldError(`A payment field can list up to ${MAX_ITEMS} items`);
  const known = rateMap(rates);
  const kept = new Set(keepArchived || []);
  const taxMode = tax.normalizeMode(raw.taxMode);

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
    let taxRateId = null;
    if (item?.taxRateId != null && item.taxRateId !== '') {
      const rate = known.get(String(item.taxRateId));
      if (!rate || (rate.archived && !kept.has(rate.taxRateId))) throw new PaymentFieldError(BAD_RATE);
      taxRateId = rate.taxRateId;
    }
    return { id, label, amountCents, required: Boolean(item?.required), taxRateId };
  });

  // The item limit is on the price as typed; this one is on what a family could pay, tax included.
  const taxed = clean.some((item) => item.taxRateId);
  const everything = clean.reduce((sum, item) => {
    const line = tax.taxLine(item.amountCents, item.taxRateId ? known.get(item.taxRateId) : null, taxMode);
    return sum + item.amountCents + (line.taxIncluded ? 0 : line.taxCents);
  }, 0);
  if (everything > MAX_TOTAL_CENTS) {
    throw new PaymentFieldError(taxed
      ? `All the items together, with tax, can come to at most ${formatCents(MAX_TOTAL_CENTS)}`
      : `All the items together can come to at most ${formatCents(MAX_TOTAL_CENTS)}`);
  }

  const code = raw.accountingCode == null ? '' : String(raw.accountingCode).replace(/<[^>]*>/g, '').trim().slice(0, 40);
  return {
    items: clean,
    allowOffline: Boolean(raw.allowOffline),
    accountingCode: code || null,
    currency: CURRENCY,
    taxMode,
  };
}

/**
 * What the family owes for what they picked. Required items are always in;
 * an id the field doesn't list is refused rather than ignored. Each line
 * carries its own tax (worked out per line); a rate the school no longer has
 * at all counts as no tax.
 * @param rates  the school's tax rates by id, archived ones too
 * @returns {{
 *   lines: {itemId,label,amountCents,taxCents,taxName,taxRateMilli,taxIncluded}[],
 *   subtotalCents, taxCents, taxAddedCents, totalCents
 * }} totalCents is what the family owes: the prices plus any tax added on top
 */
function priceSelection(config, selectedIds = [], rates = null) {
  const items = config?.items || [];
  const known = rateMap(rates);
  const mode = tax.normalizeMode(config?.taxMode);
  const wanted = new Set(Array.isArray(selectedIds) ? selectedIds.map(String) : []);
  for (const id of wanted) {
    if (!items.some((item) => item.id === id)) throw new PaymentFieldError('One of the items picked is no longer on this form. Reload the page and try again.');
  }
  const lines = items
    .filter((item) => item.required || wanted.has(item.id))
    .map((item) => ({
      itemId: item.id,
      label: item.label,
      ...tax.taxLine(item.amountCents, item.taxRateId ? known.get(item.taxRateId) || null : null, mode),
    }));
  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const taxAddedCents = tax.addedTaxCents(lines);
  return {
    lines,
    subtotalCents,
    taxCents: tax.totalTaxCents(lines),
    taxAddedCents,
    totalCents: subtotalCents + taxAddedCents,
  };
}

/** A rate as it rides along on an item: staff see whether it was removed, families don't. */
const itemTax = (rate, { staff }) => {
  if (!rate) return null;
  return staff ? { name: rate.name, rateMilli: rate.rateMilli, archived: Boolean(rate.archived) } : { name: rate.name, rateMilli: rate.rateMilli };
};

/**
 * A field's settings as staff read them: every item with its taxRateId and
 * its rate (`tax`, so the builder can show "HST 13% (removed)"), and the
 * field's taxMode. Settings saved before tax existed read as untaxed.
 */
function staffPaymentConfig(config, rates) {
  if (!config || typeof config !== 'object') return config;
  const known = rateMap(rates);
  return {
    ...config,
    items: (config.items || []).map((item) => {
      const taxRateId = item.taxRateId || null;
      return { ...item, taxRateId, tax: itemTax(taxRateId ? known.get(taxRateId) : null, { staff: true }) };
    }),
    taxMode: tax.normalizeMode(config.taxMode),
  };
}

/** A field's settings as a family sees them: no accounting code, no rate ids, each item's tax. */
function publicPaymentConfig(config, rates) {
  if (!config || typeof config !== 'object') return config;
  const known = rateMap(rates);
  const { accountingCode, ...rest } = config;
  return {
    ...rest,
    items: (config.items || []).map(({ taxRateId, ...item }) => ({
      ...item,
      tax: itemTax(taxRateId ? known.get(taxRateId) : null, { staff: false }),
    })),
    taxMode: tax.normalizeMode(config.taxMode),
  };
}

const CAD = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

/** Integer cents as dollars, always with two decimals: 2397 → "$23.97". */
function formatCents(cents) {
  return CAD.format((Number(cents) || 0) / 100);
}

/**
 * The payment field's answer as stored on the response, so exports and a
 * linked sheet read sensibly. One line of plain text:
 *   "Trip fee $25.00, Pizza lunch $6.00 · Total $31.00 · Paying online"
 * and with tax,
 *   "Trip fee $25.00 + HST $3.25 = $28.25 (paying online)"
 *   "Trip fee $25.00 = $25.00, includes $2.88 HST (paying online)"
 */
function summaryAnswer({ lines, totalCents }, method) {
  if (lines.length === 0) return 'Nothing to pay';
  const items = lines.map((line) => `${line.label} ${formatCents(line.amountCents)}`).join(', ');
  const taxes = tax.summarize(lines);
  if (taxes.length === 0) {
    const how = method === 'offline' ? 'Paying at the office' : 'Paying online';
    return `${items} · Total ${formatCents(totalCents)} · ${how}`;
  }
  const how = method === 'offline' ? 'paying at the office' : 'paying online';
  const added = taxes.filter((t) => !t.included).map((t) => ` + ${t.name} ${formatCents(t.cents)}`).join('');
  const included = taxes.filter((t) => t.included).map((t) => `, includes ${formatCents(t.cents)} ${t.name}`).join('');
  return `${items}${added} = ${formatCents(totalCents)}${included} (${how})`;
}

module.exports = {
  normalizePaymentConfig,
  priceSelection,
  summaryAnswer,
  staffPaymentConfig,
  publicPaymentConfig,
  formatCents,
  PaymentFieldError,
  MAX_ITEMS,
  MIN_ITEM_CENTS,
  MAX_ITEM_CENTS,
  MAX_TOTAL_CENTS,
  CURRENCY,
};
