// services/classroom/studentSuggestions.js
//
// Which of this year's students a typed name is for, never by email. Used by
// Import emails (a file row) and by a student's account request (what the
// student typed), so both suggest the same students. Pure: callers pass the
// roster (rows with student_id, name, grade).

const { buildCandidateIndex, resolveMatch, normalizeName } = require('../import/matching');

/** The roster indexed by name, for matchRow and suggestStudents. */
const buildRosterIndex = (roster) => buildCandidateIndex(roster, (r) => r.name);

/**
 * Which roster rows a name may be for: 'matched' (one student with that exact
 * name, and the same grade when one is given), 'check' (a close name, a name
 * shared by several students, or the right name in another grade) or
 * 'not_found'. A null grade lets one student with that exact name match.
 */
function matchRow(index, { name, grade }) {
  if (grade === null) {
    const sameName = index.byName.get(normalizeName(name)) || [];
    if (sameName.length === 1) return { kind: 'matched', matches: sameName };
    if (sameName.length > 1) return { kind: 'check', matches: sameName };
  }
  const { tier, matches } = resolveMatch(index, { name, grade }, (r) => r.name, (r) => r.grade);
  return { kind: tier === 'exact' ? 'matched' : tier === 'near' ? 'check' : 'not_found', matches };
}

/**
 * The students a request's name may be for, best first: 'exact' (one student
 * with that exact name) before 'close', and within each the typed grade first.
 * The typed grade only orders the list — a student's own guess at their grade
 * never hides the right record.
 * @returns {Array<{ student: object, kind: 'exact'|'close' }>}
 */
function suggestStudents(index, { name, grade }, limit = 5) {
  const { kind, matches } = matchRow(index, { name, grade: null });
  if (kind === 'not_found') return [];
  const exact = kind === 'matched';
  const typedGradeFirst = (a, b) => Number(b.grade === grade) - Number(a.grade === grade) || a.name.localeCompare(b.name);
  const seen = new Set();
  return [...matches]
    .sort(typedGradeFirst)
    .filter((s) => !seen.has(s.student_id) && seen.add(s.student_id))
    .slice(0, limit)
    .map((student) => ({ student, kind: exact ? 'exact' : 'close' }));
}

module.exports = { buildRosterIndex, matchRow, suggestStudents };
