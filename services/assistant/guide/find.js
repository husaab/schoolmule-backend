// services/assistant/guide/find.js
//
// Looks things up in the site guide (catalog.js) for the find_feature tool.
// Plain word matching: the catalogue is small, every entry lists the words
// people use for it, and the model has already turned the person's question
// into a short query.

const { ENTRIES, STAFF, FULL_ADMIN, PARENT } = require('./catalog');

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'do', 'i', 'my', 'how', 'where', 'is', 'are', 'can', 'find', 'page', 'from', 'with', 'what', 'it']);
const wordsOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
// "grades" and "grade", "templates" and "template" count as the same word.
const stem = (word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

/** How well an entry answers the query: its title counts most, then the words people use for it. */
function score(entry, queryWords) {
  const title = new Set(wordsOf(entry.title).map(stem));
  const others = new Set(entry.words.flatMap(wordsOf).map(stem));
  let total = 0;
  for (const word of queryWords.map(stem)) {
    if (title.has(word)) total += 3;
    else if (others.has(word)) total += 2;
    else if ([...title, ...others].some((known) => known.length > 3 && (known.startsWith(word) || word.startsWith(known)))) total += 1;
  }
  return total;
}

/** Whether this account can open the entry's page. `access` is req.access. */
function canOpen(entry, access) {
  if (entry.needs === PARENT) return Boolean(access && access.view === 'PARENT');
  if (!access || !access.isStaffView) return false;
  if (entry.needs === STAFF) return true;
  if (entry.needs === FULL_ADMIN) return Boolean(access.isFullAdmin);
  return entry.needs.some((key) => access.permissions.has(key));
}

/** Who can open it, said plainly, for someone who can't. */
function whoCan(entry) {
  if (entry.needs === PARENT) return 'A parent or guardian, in the parent portal';
  if (entry.needs === STAFF) return 'Any teacher or administrator';
  if (entry.needs === FULL_ADMIN) return 'A full administrator of the school';
  return 'Someone whose role includes this area, such as an administrator';
}

/**
 * The entries that best answer `query`, best first.
 * @returns {Array<{entry: object, score: number}>}
 */
function find(query, { limit = 3, parent = false } = {}) {
  const queryWords = wordsOf(query);
  if (queryWords.length === 0) return [];
  // A parent is shown the parent portal's pages, and staff never are.
  const hits = ENTRIES.filter((entry) => (entry.needs === PARENT) === parent)
    .map((entry) => ({ entry, score: score(entry, queryWords) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  // A weak echo of a strong match is noise: keep what is close to the best.
  const floor = hits.length ? Math.max(2, hits[0].score * 0.4) : 0;
  return hits.filter((hit) => hit.score >= floor).slice(0, limit);
}

/** The page to open: the class's own page when the entry has one and a class is known. */
function pathFor(entry, classId) {
  if (entry.classPath && classId) return entry.classPath.replace(':classId', classId);
  return entry.path;
}

module.exports = { find, canOpen, whoCan, pathFor };
