// services/finance/classify.js
//
// Decides what kind of invoice a QBO invoice is, from its own content:
//
//   parent          what the family owes (tuition, registration, discounts)
//   subsidy_grant   the Al-Ma'arif share, paid by the grant transfer
//   subsidy_school  a share the school absorbs itself (nobody external pays)
//   other           anything else (field trips, corrections) — surfaced for review
//
// Pure and DB-free so the rules can be unit-tested against fixtures. The
// bookkeeper marks subsidy invoices with a PrivateNote prefix; the line
// description is a fallback for hand-made invoices that lost the note.
// EmailStatus is deliberately NOT a signal: an unrelated invoice (9456) is also
// NotSet, so it would misclassify.

const DEFAULT_SETTINGS = Object.freeze({
  items: Object.freeze({ tuition: '4', registration: '16', discount: '19' }),
  backfillSince: '2026-08-01',
  // Charged per child on the first invoice of the year; the ledger's
  // "amount differs" check adds it to September's expected amount.
  registrationFee: 200,
  subsidyNotePrefixes: Object.freeze({
    grant: "Al-Ma'arif subsidy portion",
    school: 'School-applied subsidy portion',
  }),
  grantLabel: "Al-Ma'arif",
});

/** Lower-cases and straightens curly apostrophes/dashes so prefixes compare reliably. */
function normalizeText(s) {
  return String(s || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[–—]/g, '-')
    .trim()
    .toLowerCase();
}

/** Merges per-school settings over the defaults (shallow per section). */
function resolveSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    items: { ...DEFAULT_SETTINGS.items, ...(settings.items || {}) },
    subsidyNotePrefixes: { ...DEFAULT_SETTINGS.subsidyNotePrefixes, ...(settings.subsidyNotePrefixes || {}) },
  };
}

const salesLines = (invoice) => (invoice.Line || []).filter((l) => l.DetailType === 'SalesItemLineDetail');
const itemOf = (line) => line.SalesItemLineDetail?.ItemRef?.value;

// "Al-Ma'arif Subsidy share - Student …" or "Subsidy share - Student …".
// The parent invoice's negative "Al-Ma'arif Subsidy - Student" line does not match.
const SHARE_LINE = /^(al-ma'arif )?subsidy share - /;

/**
 * @param {object} invoice  raw QBO Invoice entity
 * @param {object} settings connection.settings (merged over defaults)
 * @returns {'parent'|'subsidy_grant'|'subsidy_school'|'other'}
 */
function classifyInvoice(invoice, settings) {
  const cfg = resolveSettings(settings);
  const note = normalizeText(invoice.PrivateNote);

  if (note && note.startsWith(normalizeText(cfg.subsidyNotePrefixes.grant))) return 'subsidy_grant';
  if (note && note.startsWith(normalizeText(cfg.subsidyNotePrefixes.school))) return 'subsidy_school';

  const lines = salesLines(invoice);
  const shareLine = lines.find((l) => SHARE_LINE.test(normalizeText(l.Description)));
  if (shareLine) {
    return normalizeText(shareLine.Description).startsWith("al-ma'arif") ? 'subsidy_grant' : 'subsidy_school';
  }

  const billable = new Set([cfg.items.tuition, cfg.items.registration]);
  if (lines.some((l) => billable.has(itemOf(l)))) return 'parent';

  return 'other';
}

module.exports = { classifyInvoice, resolveSettings, normalizeText, DEFAULT_SETTINGS };
