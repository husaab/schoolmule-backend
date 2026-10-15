// queries/termScope.js
//
// Current-term scoping shared by messaging and announcements. A class belongs
// to the current term when its term FK matches, or (legacy rows with no FK)
// its term_name does. When no term is current ($id NULL) nothing is filtered
// out: pickers then offer every class of the selected school year rather than
// an empty list. Year scoping stays with the caller's query, so a "Term 1" of
// another year can never match by name.
const inCurrentTerm = (alias, idParam, nameParam) =>
  `(${idParam}::uuid IS NULL OR ${alias}.term_id = ${idParam} OR (${alias}.term_id IS NULL AND ${alias}.term_name = ${nameParam}))`;

// The school's active term within the selected year. $1 school, $2 school_year_id|null
const selectCurrentTerm = `
    SELECT term_id, name FROM terms WHERE school = $1 AND is_active = TRUE
      AND ($2::uuid IS NULL OR school_year_id = $2)
    ORDER BY start_date DESC LIMIT 1
  `;

module.exports = { inCurrentTerm, selectCurrentTerm };
