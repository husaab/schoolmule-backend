/**
 * 1) FETCH all existing scores for a class:
 *    We need, for each student enrolled in that class, each assessment that belongs to that class,
 *    and any existing score in student_assessments (if it exists).
 */
const selectScoresByClass = `
SELECT 
  cs.student_id,
  s.name AS student_name,
  a.assessment_id,
  a.name        AS assessment_name,
  a.weight_percent,
  sa.score
FROM class_students AS cs
JOIN students AS s
  ON cs.student_id = s.student_id
JOIN assessments AS a
  ON a.class_id = cs.class_id
LEFT JOIN student_assessments AS sa
  ON sa.student_id = cs.student_id
 AND sa.assessment_id = a.assessment_id
WHERE cs.class_id = $1
ORDER BY s.name, a.weight_percent;
`;

/**
 * 2) BULK UPSERT scores: 
 *    We pass an array of rows [ { student_id, assessment_id, score }, … ].
 *    We rely on ON CONFLICT (student_id, assessment_id) DO UPDATE.
 */
const upsertStudentAssessments = `
INSERT INTO student_assessments (student_id, assessment_id, score)
VALUES 
${ ""}
ON CONFLICT (student_id, assessment_id)
DO UPDATE SET score = EXCLUDED.score
RETURNING student_id, assessment_id, score;
`;

module.exports = {
  selectScoresByClass,
  upsertStudentAssessments,
};