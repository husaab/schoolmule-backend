// services/payments/taxSettings.js
//
// A school's tax settings: its rates ("HST 13%") and the tax number printed on
// its receipts (Finance → Payments → Settings).
//
// Rules this module keeps:
//   - A rate is removed by archiving it, never deleted. Forms and requests
//     that still name it keep working; pickers hide it unless it is already
//     chosen on the thing being edited.
//   - One live rate per name per school (any case).
//   - Charges keep their own copy of a rate's name and percent, so nothing
//     here rewrites a past payment.

const db = require('../../config/database');
const q = require('../../queries/paymentSettings.queries');
const { ChargeError } = require('./charges');
const { parsePercent, MAX_NAME } = require('./tax');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAX_NUMBER = 60;
const BAD_PERCENT = 'Enter a rate between 0.001% and 100%';
const BAD_RATE = 'Choose a tax rate from your school’s list';

/** A rate in every answer. */
const toRate = (row) => ({
  taxRateId: row.tax_rate_id,
  name: row.name,
  rateMilli: row.rate_milli,
  archived: row.archived_at != null,
});

const plain = (value) => String(value ?? '').replace(/<[^>]*>/g, '').trim();

function cleanName(value) {
  const name = plain(value);
  if (!name || name.length > MAX_NAME) throw new ChargeError(`Give the rate a name of up to ${MAX_NAME} characters, like HST.`, 400);
  return name;
}

function cleanPercent(value) {
  const milli = parsePercent(value);
  if (milli == null) throw new ChargeError(BAD_PERCENT, 400);
  return milli;
}

/** Every rate of the school, live ones first by name, then the archived ones. */
async function listRates(conn, school) {
  const { rows } = await conn.query(q.selectRates, [school]);
  return rows.map(toRate);
}

/** The school's rates by id, archived ones too (a form or request may keep one). */
async function ratesById(school, conn = db) {
  return new Map((await listRates(conn, school)).map((r) => [r.taxRateId, r]));
}

/** GET /api/payments/settings */
async function load(school, conn = db) {
  const [{ rows: [settings] }, taxRates] = await Promise.all([
    conn.query(q.selectSettings, [school]),
    listRates(conn, school),
  ]);
  return { taxNumber: settings?.tax_number || null, taxRates };
}

async function setTaxNumber({ school, taxNumber, user }) {
  const value = taxNumber == null ? '' : plain(taxNumber);
  if (value.length > MAX_TAX_NUMBER) throw new ChargeError(`Keep the tax number to ${MAX_TAX_NUMBER} characters.`, 400);
  await db.query(q.upsertTaxNumber, [school, value || null, user?.userId || null]);
  return load(school);
}

async function refuseTakenName(school, name, exceptId = null) {
  const { rows: [taken] } = await db.query(q.selectLiveRateByName, [school, name, exceptId]);
  if (taken) throw new ChargeError(`You already have a rate called ${taken.name}`, 409, 'RATE_EXISTS');
}

/** Two saves of the same name at once: the unique index refuses the second. */
async function withNameGuard(name, work) {
  try {
    return await work();
  } catch (error) {
    if (error.code === '23505') throw new ChargeError(`You already have a rate called ${name}`, 409, 'RATE_EXISTS');
    throw error;
  }
}

async function findRate(school, taxRateId) {
  if (!UUID_RE.test(String(taxRateId))) throw new ChargeError('Tax rate not found', 404);
  const { rows: [row] } = await db.query(q.selectRate, [taxRateId, school]);
  if (!row) throw new ChargeError('Tax rate not found', 404);
  return row;
}

async function createRate({ school, body = {}, user }) {
  const name = cleanName(body.name);
  const rateMilli = cleanPercent(body.percent);
  await refuseTakenName(school, name);
  await withNameGuard(name, () => db.query(q.insertRate, [school, name, rateMilli, user?.userId || null]));
  return load(school);
}

async function updateRate({ school, taxRateId, body = {} }) {
  const row = await findRate(school, taxRateId);
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
  const name = has('name') ? cleanName(body.name) : row.name;
  const rateMilli = has('percent') ? cleanPercent(body.percent) : row.rate_milli;
  if (row.archived_at == null) await refuseTakenName(school, name, row.tax_rate_id);
  await withNameGuard(name, () => db.query(q.updateRate, [row.tax_rate_id, school, name, rateMilli]));
  return load(school);
}

async function archiveRate({ school, taxRateId }) {
  const row = await findRate(school, taxRateId);
  await db.query(q.archiveRate, [row.tax_rate_id, school]);
  return load(school);
}

/**
 * The rate a payment request names, checked: the school's, and live unless
 * it is the one the request already has (`keep`). Null for none.
 * @returns {Promise<{ taxRateId, name, rateMilli, archived }|null>}
 */
async function resolveForRequest(conn, school, taxRateId, { keep = null } = {}) {
  if (taxRateId == null) return null;
  if (!UUID_RE.test(String(taxRateId))) throw new ChargeError(BAD_RATE, 400);
  const { rows: [row] } = await conn.query(q.selectRate, [taxRateId, school]);
  if (!row || (row.archived_at != null && row.tax_rate_id !== keep)) throw new ChargeError(BAD_RATE, 400);
  return toRate(row);
}

module.exports = {
  load,
  listRates,
  ratesById,
  setTaxNumber,
  createRate,
  updateRate,
  archiveRate,
  resolveForRequest,
  toRate,
  BAD_RATE,
  MAX_TAX_NUMBER,
};
