// services/payments/tax.js
//
// Tax math, pure, so the server and the web (src/lib/paymentTax.ts) work every
// total out the same way.
//
//   - Money is integer cents. A rate is thousandths of a percent (rateMilli):
//     13% is 13000, 9.975% is 9975.
//   - Added on top:        tax = round(amount * rate / 100000)
//   - Included in a price: tax = amount - round(amount * 100000 / (100000 + rate))
//   - Tax is worked out per line and summed; the total is never rounded again.

const MODES = Object.freeze(['added', 'included']);
const MAX_RATE_MILLI = 100000; // 100%
const MAX_NAME = 30;

/** 'included' or 'added' (anything else is 'added'). */
const normalizeMode = (value) => (value === 'included' ? 'included' : 'added');

/** One amount's tax at a rate. No rate, no tax. */
function taxFor(amountCents, rateMilli, mode = 'added') {
  const amount = Number(amountCents) || 0;
  const rate = Number(rateMilli) || 0;
  if (amount <= 0 || rate <= 0) return 0;
  if (mode === 'included') return amount - Math.round((amount * 100000) / (100000 + rate));
  return Math.round((amount * rate) / 100000);
}

/** 13000 → "13%", 9975 → "9.975%", 12500 → "12.5%". */
function percentLabel(rateMilli) {
  return `${Number((Number(rateMilli) / 1000).toFixed(3))}%`;
}

/** "HST 13%", for pickers. */
const rateLabel = (rate) => `${rate.name} ${percentLabel(rate.rateMilli)}`;

/** "HST (13%)", the name of added tax as its own line (Stripe's page, emails). */
const taxLineName = (entry) => `${entry.name} (${percentLabel(entry.rateMilli)})`;

/**
 * A percent the office typed, as a rate: a number or a string like "13" or
 * "9.975" (a trailing % is fine). More than 0, at most 100, at most three
 * decimals. Anything else is null.
 */
function parsePercent(value) {
  let milli = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const scaled = value * 1000;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return null;
    milli = Math.round(scaled);
  } else if (typeof value === 'string') {
    const match = value.trim().replace(/\s*%$/, '').match(/^(\d{0,3})(?:\.(\d{1,3}))?$/);
    if (!match || (match[1] === '' && match[2] === undefined)) return null;
    milli = Number(match[1] || 0) * 1000 + Number((match[2] || '').padEnd(3, '0'));
  } else {
    return null;
  }
  return milli > 0 && milli <= MAX_RATE_MILLI ? milli : null;
}

/**
 * The tax on a set of lines, one entry per rate and mode, largest first.
 * Lines are { taxCents, taxName, taxRateMilli, taxIncluded }. Untaxed lines
 * (and tax that came to nothing) are left out.
 * @returns {Array<{ name, rateMilli, cents, included }>}
 */
function summarize(lines = []) {
  const byRate = new Map();
  for (const line of lines) {
    if (!line || !line.taxName || !(line.taxCents > 0)) continue;
    const key = `${line.taxName}\u0000${line.taxRateMilli}\u0000${Boolean(line.taxIncluded)}`;
    const entry = byRate.get(key) || { name: line.taxName, rateMilli: line.taxRateMilli, cents: 0, included: Boolean(line.taxIncluded) };
    entry.cents += line.taxCents;
    byRate.set(key, entry);
  }
  return [...byRate.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name) || a.rateMilli - b.rateMilli);
}

/** The tax that goes on top of the prices (not the tax inside them). */
const addedTaxCents = (lines = []) => lines.reduce((sum, l) => sum + (l && !l.taxIncluded ? Number(l.taxCents) || 0 : 0), 0);

/** All the tax on the lines, added and included. */
const totalTaxCents = (lines = []) => lines.reduce((sum, l) => sum + (Number(l?.taxCents) || 0), 0);

/**
 * One priced line: the price as typed and its tax at `rate` ({ name, rateMilli }
 * or null) in `mode`.
 */
function taxLine(amountCents, rate, mode) {
  if (!rate) return { amountCents, taxCents: 0, taxName: null, taxRateMilli: null, taxIncluded: false };
  const included = normalizeMode(mode) === 'included';
  return {
    amountCents,
    taxCents: taxFor(amountCents, rate.rateMilli, included ? 'included' : 'added'),
    taxName: rate.name,
    taxRateMilli: rate.rateMilli,
    taxIncluded: included,
  };
}

module.exports = {
  MODES,
  MAX_RATE_MILLI,
  MAX_NAME,
  normalizeMode,
  taxFor,
  percentLabel,
  rateLabel,
  taxLineName,
  parsePercent,
  summarize,
  addedTaxCents,
  totalTaxCents,
  taxLine,
};
