// File: src/queries/assessment.queries.js

const assessmentQueries = {
  //
  // 1) GET /assessments/:id
  //    → Fetch a single assessment by its UUID
  //
  selectAssessmentById: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at,
      parent_assessment_id,
      is_parent,
      sort_order,
      max_score,
      weight_points,
      date
    FROM assessments
    WHERE assessment_id = $1
  `,

  //
  // 2) GET /assessments/class/:classId
  //    → List all assessments for a given class
  //
  selectAssessmentsByClass: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at,
      parent_assessment_id,
      is_parent,
      sort_order,
      max_score,
      weight_points,
      date
    FROM assessments
    WHERE class_id = $1
    ORDER BY 
      CASE WHEN parent_assessment_id IS NULL THEN assessment_id ELSE parent_assessment_id END,
      is_parent DESC,
      sort_order ASC,
      created_at ASC
  `,

  //
  // 3) POST /assessments
  //    → Create a new assessment
  //
  createAssessment: `
    INSERT INTO assessments (
      class_id,
      name,
      weight_percent,
      parent_assessment_id,
      is_parent,
      sort_order,
      max_score,
      weight_points,
      date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
  `,

  //
  // (Optional) PATCH /assessments/:id
  //    → Update any field of an existing assessment
  //
  updateAssessmentById: `
    UPDATE assessments
    SET
      class_id        = COALESCE($1, class_id),
      name            = COALESCE($2, name),
      weight_percent  = COALESCE($3, weight_percent),
      parent_assessment_id = COALESCE($4, parent_assessment_id),
      is_parent       = COALESCE($5, is_parent),
      sort_order      = COALESCE($6, sort_order),
      max_score       = COALESCE($7, max_score),
      weight_points   = COALESCE($8, weight_points),
      date            = COALESCE($9, date),
      last_modified_at = NOW()
    WHERE assessment_id = $10
    RETURNING *
  `,

  //
  // (Optional) DELETE /assessments/:id
  //    → Delete an assessment by its UUID
  //
  deleteAssessmentById: `
    DELETE FROM assessments
    WHERE assessment_id = $1
  `,

  // Get child assessments for a parent assessment
  selectChildAssessments: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at,
      parent_assessment_id,
      is_parent,
      sort_order,
      max_score,
      weight_points,
      date
    FROM assessments
    WHERE parent_assessment_id = $1
    ORDER BY sort_order ASC, created_at ASC
  `,

  // Create multiple child assessments in one operation
  createChildAssessments: `
    INSERT INTO assessments (
      class_id,
      name,
      weight_percent,
      parent_assessment_id,
      is_parent,
      sort_order
    ) VALUES`,

  // Get only parent assessments for a class (no children)
  selectParentAssessmentsByClass: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at,
      parent_assessment_id,
      is_parent,
      sort_order,
      date
    FROM assessments
    WHERE class_id = $1 AND (parent_assessment_id IS NULL)
    ORDER BY is_parent DESC, created_at ASC
  `,

  // Batch update multiple assessments
  batchUpdateAssessments: `
    UPDATE assessments
    SET
      name = CASE 
        WHEN assessment_id = ANY($1::uuid[]) THEN 
          (SELECT val FROM unnest($1::uuid[], $2::text[]) AS t(id, val) WHERE t.id = assessment_id)
        ELSE name
      END,
      weight_percent = CASE 
        WHEN assessment_id = ANY($1::uuid[]) THEN 
          (SELECT val FROM unnest($1::uuid[], $3::numeric[]) AS t(id, val) WHERE t.id = assessment_id)
        ELSE weight_percent
      END,
      weight_points = CASE 
        WHEN assessment_id = ANY($1::uuid[]) THEN 
          (SELECT val FROM unnest($1::uuid[], $4::numeric[]) AS t(id, val) WHERE t.id = assessment_id)
        ELSE weight_points
      END,
      max_score = CASE 
        WHEN assessment_id = ANY($1::uuid[]) THEN 
          (SELECT val FROM unnest($1::uuid[], $5::numeric[]) AS t(id, val) WHERE t.id = assessment_id)
        ELSE max_score
      END,
      sort_order = CASE 
        WHEN assessment_id = ANY($1::uuid[]) THEN 
          (SELECT val FROM unnest($1::uuid[], $6::integer[]) AS t(id, val) WHERE t.id = assessment_id)
        ELSE sort_order
      END,
      date = CASE 
        WHEN assessment_id = ANY($1::uuid[]) THEN 
          (SELECT val FROM unnest($1::uuid[], $7::date[]) AS t(id, val) WHERE t.id = assessment_id)
        ELSE date
      END,
      last_modified_at = NOW()
    WHERE assessment_id = ANY($1::uuid[])
    RETURNING *
  `,

  // Updated grade calculation that handles parent assessments with point-based system
  selectFinalGradesByStudent: `
    WITH assessment_scores AS (
      -- Get direct scores for child assessments and standalone assessments
      SELECT 
        a.assessment_id,
        a.parent_assessment_id,
        COALESCE(a.weight_points, a.weight_percent, 0) as weight_points,
        a.max_score,
        a.is_parent,
        c.subject,
        COALESCE(sa.score, 0) as raw_score
      FROM assessments a
      JOIN classes c ON c.class_id = a.class_id
      JOIN class_students cs ON cs.class_id = c.class_id
      LEFT JOIN student_assessments sa ON sa.assessment_id = a.assessment_id AND sa.student_id = $1
      WHERE cs.student_id = $1
    ),
    parent_scores AS (
      -- Calculate scores for parent assessments as weighted average of children
      SELECT 
        p.assessment_id,
        p.subject,
        p.weight_points,
        COALESCE(
          SUM(
            (c.raw_score / NULLIF(c.max_score, 0)) * c.weight_points
          ) / NULLIF(SUM(c.weight_points), 0) * 100,
          0
        ) as calculated_percentage
      FROM assessment_scores p
      JOIN assessment_scores c ON c.parent_assessment_id = p.assessment_id
      WHERE p.is_parent = true
      GROUP BY p.assessment_id, p.subject, p.weight_points
    ),
    final_scores AS (
      -- Combine standalone assessments and parent assessments
      SELECT 
        subject, 
        weight_points, 
        (raw_score / NULLIF(max_score, 0)) * 100 as percentage_score
      FROM assessment_scores 
      WHERE parent_assessment_id IS NULL AND is_parent = false
      
      UNION ALL
      
      SELECT subject, weight_points, calculated_percentage as percentage_score
      FROM parent_scores
    )
    SELECT 
      subject AS subject_name,
      SUM(percentage_score * (weight_points / 100.0)) AS final_grade
    FROM final_scores
    GROUP BY subject
    ORDER BY subject
  `
}

module.exports = assessmentQueries
