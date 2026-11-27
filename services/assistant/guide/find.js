// services/assistant/guide/find.js
//
// Looks things up in the site guide (catalog.js) for the find_feature tool.
// Plain word matching: the catalogue is small, every entry lists the words
// people use for it, and the model has already turned the person's question
// into a short query.

const { ENTRIES, STAFF, FULL_ADMIN, PARENT } = require('./catalog');

const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'do', 'i', 'my', 'how', 'where', 'is', 'are', 'can', 'find', 'page', 'from', 'with', 'what', 'it',
  // Words that say nothing about which page: "all" once sent "mark all my classes" to All Messages.
  'all', 'me', 'please', 'show', 'open', 'go', 'get', 'want', 'need', 'one', 'each', 'every', 'everyone', 'there', 'this', 'that', 'we', 'our', 'you', 'your']);
const wordsOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
// "grades" and "grade", "templates" and "template" count as the same word.
// "classes" and "class", "batches" and "batch": -es after s, x, z, ch or sh goes too.
const stem = (word) => {
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
};

const termsOf = (entry) => ({ title: new Set(wordsOf(entry.title).map(stem)), others: new Set(entry.words.flatMap(wordsOf).map(stem)) });

/**
 * How much each word says about which page, for one audience's entries: a
 * word only one page uses ("stamp") counts fully, one many pages use
 * ("report", "student") counts less. Without it, "the stamp at the bottom of
 * report cards" went to Report Templates, which matched "report" and "card".
 */
function rarityOf(entries) {
  const pages = new Map();
  for (const entry of entries) {
    const { title, others } = termsOf(entry);
    for (const word of new Set([...title, ...others])) pages.set(word, (pages.get(word) || 0) + 1);
  }
  const n = Math.max(2, entries.length);
  return (word) => (pages.has(word) ? Math.max(0.25, Math.log(n / pages.get(word)) / Math.log(n)) : 1);
}

/**
 * How well an entry answers the query: its title counts most, then the words
 * people use for it, each by how rare the word is. -> { score, matched }
 */
function score(entry, queryWords, rarity) {
  const { title, others } = termsOf(entry);
  let total = 0;
  let matched = 0;
  for (const word of queryWords) {
    if (title.has(word)) total += 3 * rarity(word);
    else if (others.has(word)) total += 2 * rarity(word);
    else {
      // A word cut short ("gradeb", "timetab"); "fee" is too short to be "feedback".
      const near = word.length > 3 && [...title, ...others].find((known) => known.length > 3 && (known.startsWith(word) || word.startsWith(known)));
      if (!near) continue;
      total += rarity(near);
    }
    matched += 1;
  }
  return { score: Math.round(total * 100) / 100, matched };
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

const AUDIENCES = {
  staff: ENTRIES.filter((entry) => entry.needs !== PARENT),
  parent: ENTRIES.filter((entry) => entry.needs === PARENT),
};
const RARITY = { staff: rarityOf(AUDIENCES.staff), parent: rarityOf(AUDIENCES.parent) };

/**
 * The entries that best answer `query`, best first. A parent is shown the
 * parent portal's pages, and staff never are.
 * @returns {Array<{entry: object, score: number, matched: number, of: number}>}
 */
function find(query, { limit = 3, parent = false } = {}) {
  const queryWords = [...new Set(wordsOf(query).map(stem))];
  if (queryWords.length === 0) return [];
  const audience = parent ? 'parent' : 'staff';
  const hits = AUDIENCES[audience]
    .map((entry) => ({ entry, ...score(entry, queryWords, RARITY[audience]), of: queryWords.length }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  // A weak echo of a strong match is noise: keep what is close to the best.
  const floor = hits.length ? Math.max(1, hits[0].score * 0.4) : 0;
  return hits.filter((hit) => hit.score >= floor).slice(0, limit);
}

/** The page to open: the class's own page when the entry has one and a class is known. */
function pathFor(entry, classId) {
  if (entry.classPath && classId) return entry.classPath.replace(':classId', classId);
  return entry.path;
}

/**
 * Whether the best hit is the answer, not one of several: a button opens it
 * only then. It has to stand out from the next, carry a distinctive word, and
 * match at least half of what was asked: "compare Math grades across all
 * classes" matched only "grades" in "Publish grades to parents", and showed
 * its button.
 */
const isClear = (hits) => {
  if (hits.length === 0) return false;
  const [best, next] = hits;
  return best.score >= 2 && best.matched * 2 >= best.of && (!next || best.score > next.score);
};

module.exports = { find, canOpen, whoCan, pathFor, isClear, stem };
