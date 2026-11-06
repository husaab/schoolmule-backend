// queries/modifiedMark.queries.js

module.exports = {
  // The leaf assessments a cell stands for: itself, or a category's children.
  // $1 class_id, $2 assessment_id
  selectTargets: `
    SELECT assessment_id, COALESCE(is_published, FALSE) AS is_published
    FROM assessments
    WHERE class_id = $1
      AND (assessment_id = $2 OR parent_assessment_id = $2)
      AND is_parent = FALSE`,

  // $1 student_id, $2 assessment_id[], $3 label|null, $4 created_by
  upsert: `
    INSERT INTO modified_marks (student_id, assessment_id, label, created_by)
    SELECT $1, t.assessment_id, $3, $4 FROM unnest($2::uuid[]) AS t(assessment_id)
    ON CONFLICT (student_id, assessment_id)
    DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()
    RETURNING student_id, assessment_id, label`,

  // $1 student_id, $2 assessment_id[]
  remove: `
    DELETE FROM modified_marks WHERE student_id = $1 AND assessment_id = ANY($2::uuid[])`,
};
