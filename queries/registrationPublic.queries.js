const registrationPublicQueries = {
  selectSchoolBySlug: `
    SELECT school_id, school_code, name, slug
    FROM schools
    WHERE slug = $1
  `,

  selectPublishedForm: `
    SELECT f.*,
      COALESCE(
        json_agg(
          json_build_object(
            'fieldId', ff.field_id,
            'fieldType', ff.field_type,
            'label', ff.label,
            'placeholder', ff.placeholder,
            'isRequired', ff.is_required,
            'options', ff.options,
            'payment', ff.payment_config,
            'sortOrder', ff.sort_order
          ) ORDER BY ff.sort_order
        ) FILTER (WHERE ff.field_id IS NOT NULL),
        '[]'
      ) AS fields
    FROM registration_forms f
    LEFT JOIN registration_form_fields ff ON f.form_id = ff.form_id
    WHERE f.school = $1 AND f.slug = $2 AND f.status = 'published'
    GROUP BY f.form_id
  `,

  selectFormFieldsForValidation: `
    SELECT field_id, field_type, label, is_required, options, payment_config
    FROM registration_form_fields
    WHERE form_id = $1
    ORDER BY sort_order ASC
  `,

  insertSubmission: `
    INSERT INTO registration_form_submissions (form_id, school, answers, ip_address, student_id, submitted_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `,

  /**
   * A signed-in parent's children at a school, in its current year ($3), or
   * one of them ($4). Never archived or deleted students.
   */
  selectParentChildren: `
    SELECT DISTINCT s.student_id, s.name, s.grade::text AS grade
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id
    WHERE ps.parent_id = $1 AND s.school = $2
      AND ($3::uuid IS NULL OR s.school_year_id = $3)
      AND ($4::uuid IS NULL OR s.student_id = $4)
      AND COALESCE(s.is_archived, false) = false
    ORDER BY s.name
  `,
};

module.exports = registrationPublicQueries;
