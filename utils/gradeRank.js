// Grade order for the student portal: JK and SK sit below Grade 1, so a
// setting like "student logins from Grade 1" can be compared numerically.
const GRADE_CODES = ['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8'];
const gradeRank = (g) => (g === 'JK' ? -1 : g === 'SK' ? 0 : /^[1-8]$/.test(String(g)) ? Number(g) : null);
// SQL twin. Always pass a TEXT expression, e.g. GRADE_RANK('s.grade::text').
const GRADE_RANK = (expr) => `(CASE (${expr}) WHEN 'JK' THEN -1 WHEN 'SK' THEN 0 ELSE NULLIF(${expr}, '')::int END)`;
module.exports = { GRADE_CODES, gradeRank, GRADE_RANK };
