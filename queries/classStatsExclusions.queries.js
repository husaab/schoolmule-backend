// queries/classStatsExclusions.queries.js
//
// Students left out of a class's pooled statistics (services/classStats.js).
// One row per scope: assessment_id NULL = the whole class, otherwise one
// column (a category covers its children when the stats are pooled).

const { PERSON_NAME, CLASS_TEACHER_NAME } = require('./personName');

const ENTRY_COLUMNS = `
  e.class_id, e.student_id, e.assessment_id, e.note, e.created_by, e.created_at,
  ${PERSON_NAME('u')} AS created_by_name`;

module.exports = {
  // $1 class_id
  selectForClass: `
    SELECT ${ENTRY_COLUMNS}
    FROM class_stats_exclusions e
    LEFT JOIN users u ON u.user_id = e.created_by
    WHERE e.class_id = $1
    ORDER BY e.student_id, e.assessment_id NULLS FIRST
  `,

  // $1 class_id, $2 student_id
  selectForStudent: `
    SELECT ${ENTRY_COLUMNS}
    FROM class_stats_exclusions e
    LEFT JOIN users u ON u.user_id = e.created_by
    WHERE e.class_id = $1 AND e.student_id = $2
    ORDER BY e.assessment_id NULLS FIRST
  `,

  // Every exclusion in a school's term (all terms when $2 is NULL), for the
  // admin list. $1 school, $2 term_id | NULL
  selectForSchoolTerm: `
    SELECT ${ENTRY_COLUMNS},
           c.subject, c.grade::text AS grade, c.term_id,
           ${CLASS_TEACHER_NAME('c', 'ctn')} AS teacher_name,
           s.name AS student_name,
           a.name AS assessment_name
    FROM class_stats_exclusions e
    JOIN classes c ON c.class_id = e.class_id
    LEFT JOIN users ctn ON ctn.user_id = c.teacher_id
    JOIN students s ON s.student_id = e.student_id
    LEFT JOIN assessments a ON a.assessment_id = e.assessment_id
    LEFT JOIN users u ON u.user_id = e.created_by
    WHERE c.school = $1
      AND ($2::uuid IS NULL OR c.term_id = $2)
    ORDER BY c.grade, c.subject, s.name, a.sort_order NULLS FIRST
  `,

  // $1 class_id, $2 student_id
  selectEnrolment: `
    SELECT 1 FROM class_students WHERE class_id = $1 AND student_id = $2
  `,

  // Which of these ids are columns of the class. $1 class_id, $2 uuid[]
  selectClassAssessmentIds: `
    SELECT assessment_id FROM assessments WHERE class_id = $1 AND assessment_id = ANY($2::uuid[])
  `,

  // $1 class_id, $2 student_id
  deleteForStudent: `
    DELETE FROM class_stats_exclusions WHERE class_id = $1 AND student_id = $2
  `,

  // $1 class_id, $2 student_id, $3 note, $4 created_by
  insertWholeClass: `
    INSERT INTO class_stats_exclusions (class_id, student_id, assessment_id, note, created_by)
    VALUES ($1, $2, NULL, $3, $4)
  `,

  // $1 class_id, $2 student_id, $3 uuid[] assessment ids, $4 note, $5 created_by
  insertAssessments: `
    INSERT INTO class_stats_exclusions (class_id, student_id, assessment_id, note, created_by)
    SELECT $1, $2, ids.assessment_id, $4, $5
    FROM unnest($3::uuid[]) AS ids(assessment_id)
  `,

  // Duplicating a class into the next term: whole-class rows follow the
  // students; per-assessment rows don't (the columns are new). Runs after
  // the enrolments are copied. $1 source class_id, $2 new class_id
  copyWholeClassToClass: `
    INSERT INTO class_stats_exclusions (class_id, student_id, assessment_id, note, created_by)
    SELECT $2, e.student_id, NULL, e.note, e.created_by
    FROM class_stats_exclusions e
    JOIN class_students cs ON cs.class_id = $2 AND cs.student_id = e.student_id
    WHERE e.class_id = $1 AND e.assessment_id IS NULL
    ON CONFLICT DO NOTHING
  `,
};
