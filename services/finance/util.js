// services/finance/util.js
//
// Tiny helpers shared by the finance modules. Kept in one place because two
// of them (money coercion and rounding) are rules that must never drift
// between the sync, the ledger and the API.

/** pg returns NUMERIC as strings; null stays null. */
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Cents rounding for every summed money value. */
const round2 = (v) => Math.round(v * 100) / 100;

/** pg hands DATE columns back as local-midnight Date objects; normalize to 'YYYY-MM-DD'. */
function dateStr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

/** Map<key, row[]> — rows grouped by one column (or by a key function). */
function groupBy(rows, key) {
  const pick = typeof key === 'function' ? key : (r) => r[key];
  const map = new Map();
  for (const r of rows) {
    const k = pick(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

module.exports = { num, round2, dateStr, groupBy };
