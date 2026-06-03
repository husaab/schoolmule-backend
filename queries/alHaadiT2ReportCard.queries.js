// queries/alHaadiT2ReportCard.queries.js
//
// SQL for the Al Haadi Academy Term-2 report card variant (grades 1-8).
// The variant shows three grade rows per subject (First Term / Second Term /
// Final Term), so it needs to resolve the school's Term 1 + Term 2 term rows
// and pull the student's classes one term at a time.
//
// Term resolution strategy (see resolveAlHaadiTermPair in the controller):
//   1. Resolve T2 by exact name match on the string the frontend sent.
//   2. If that misses (name formatting drift), fall back to a LIKE match.
//   3. Resolve T1 in the same academic_year as T2; fall back to the most
//      recent '%term 1%' term for the school.

const alHaadiT2ReportCardQueries = {
  // Exact term lookup. Params: $1 name, $2 school (enum)
  selectTermByNameAndSchool: `
    SELECT term_id, name, academic_year, start_date
    FROM terms
    WHERE name = $1 AND school = $2
    LIMIT 1
  `,

  // Fallback lookup by pattern, newest first.
  // Params: $1 school (enum), $2 lowercase LIKE pattern (e.g. '%term 2%')
  selectTermLike: `
    SELECT term_id, name, academic_year, start_date
    FROM terms
    WHERE school = $1 AND lower(name) LIKE $2
    ORDER BY start_date DESC NULLS LAST
    LIMIT 1
  `,

  // Term 1 in the same academic year as the resolved Term 2.
  // Params: $1 school (enum), $2 academic_year (nullable)
  selectTerm1ForAcademicYear: `
    SELECT term_id, name, academic_year, start_date
    FROM terms
    WHERE school = $1
      AND academic_year IS NOT DISTINCT FROM $2
      AND lower(name) LIKE '%term 1%'
    ORDER BY start_date ASC NULLS LAST
    LIMIT 1
  `,

  // A student's enrolled classes for one term. JK/SK classes are excluded —
  // those grades have their own report card generators.
  // Params: $1 studentId, $2 termId
  selectStudentClassesForTerm: `
    SELECT c.class_id, c.subject
    FROM class_students cs
    JOIN classes c ON c.class_id = cs.class_id
    WHERE cs.student_id = $1
      AND c.term_id = $2
      AND c.grade NOT IN ('JK', 'SK')
  `,
};

module.exports = alHaadiT2ReportCardQueries;
