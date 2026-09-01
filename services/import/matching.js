// services/import/matching.js
//
// Name normalization and match tiering for submission → entity import.
//
// Deliberately dependency-free and DB-free: every function here is pure, so
// the classification rules can be unit-tested against fixtures without a
// database. This is where the subtle bugs live, so it is kept small and
// separately testable.

// Collapses a human-entered name to a comparable key.
// "  maya   EL-Mnini " → "maya el-mnini"
function normalizeName(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .toLowerCase()
    .normalize('NFKD')            // strip accents: "José" → "Jose"
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation/hyphens become separators
    .replace(/\s+/g, ' ')
    .trim();
}

// The set of words in a normalized name, for order-insensitive comparison.
// "Khan Castro Fatimah" and "Fatimah Khan Castro" are the same person written
// differently — a real pattern in registration forms.
function nameTokens(raw) {
  const n = normalizeName(raw);
  return n ? new Set(n.split(' ')) : new Set();
}

// Levenshtein distance, iterative with a rolling row (O(min(a,b)) memory).
// Only ever called on short strings (names), so the O(n*m) time is irrelevant.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur.slice();
  }
  return prev[b.length];
}

// True when two names are close enough to be worth a human's attention, but
// not close enough to auto-decide. Catches typos and token reordering.
function isNearName(aRaw, bRaw) {
  const a = normalizeName(aRaw);
  const b = normalizeName(bRaw);
  if (!a || !b) return false;
  if (a === b) return false; // that's an exact match, not a near one

  // Same words in a different order.
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === tb.size && [...ta].every(t => tb.has(t))) return true;

  // One name is a subset of the other and shares at least two words —
  // catches a missing or added middle/family name.
  const shared = [...ta].filter(t => tb.has(t)).length;
  if (shared >= 2 && (shared === ta.size || shared === tb.size)) return true;

  // Small typo tolerance, scaled to name length. Very short names get none at
  // all: "Ali" and "Adi" are one edit apart but are two different children,
  // and a false "possible match" on every short name is just review noise.
  const maxLen = Math.max(a.length, b.length);
  if (maxLen <= 4) return false;
  const threshold = maxLen <= 8 ? 1 : maxLen <= 16 ? 2 : 3;
  return editDistance(a, b) <= threshold;
}

// Builds a lookup over existing entity rows so classification is O(1) per
// submission instead of O(candidates). Returns both an exact-name index and
// the flat list (needed for the near-match scan, which can't be indexed).
function buildCandidateIndex(candidates, getName) {
  const byName = new Map();
  for (const c of candidates) {
    const key = normalizeName(getName(c));
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
  return { byName, all: candidates };
}

/**
 * Resolve a mapped name+grade against existing entities.
 *
 * Tiers, in the order they are tested:
 *   'exact' — same normalized name AND same grade. Confident it's the same
 *             person; the caller defaults this to Skip.
 *   'near'  — same normalized name but a different grade, or a close name
 *             variant. Genuinely ambiguous, so it's surfaced for a human
 *             decision rather than guessed at.
 *   'none'  — nothing comparable; the caller defaults this to Create.
 *
 * Returns { tier, matches } where `matches` are the candidate rows that
 * triggered the tier (possibly several, e.g. same-named siblings).
 */
function resolveMatch(index, { name, grade }, getName, getGrade) {
  const key = normalizeName(name);
  if (!key) return { tier: 'none', matches: [] };

  const sameName = index.byName.get(key) || [];
  if (sameName.length > 0) {
    // Grade is compared as a string: the DB enum is 'JK'/'SK'/'1'..'8'.
    const sameGrade = grade === null || grade === undefined
      ? []
      : sameName.filter(c => String(getGrade(c)) === String(grade));

    if (sameGrade.length === 1) return { tier: 'exact', matches: sameGrade };
    // Several identically-named students in the same grade is not something to
    // resolve automatically — make a human pick.
    if (sameGrade.length > 1) return { tier: 'near', matches: sameGrade };
    // Right name, wrong grade: could be the same child moving up a grade, or a
    // sibling. Ambiguous by definition.
    return { tier: 'near', matches: sameName };
  }

  const near = index.all.filter(c => isNearName(name, getName(c)));
  if (near.length > 0) return { tier: 'near', matches: near };

  return { tier: 'none', matches: [] };
}

module.exports = {
  normalizeName,
  nameTokens,
  editDistance,
  isNearName,
  buildCandidateIndex,
  resolveMatch,
};
