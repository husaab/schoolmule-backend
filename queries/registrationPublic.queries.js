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
    SELECT field_id, field_type, label, is_required, options
    FROM registration_form_fields
    WHERE form_id = $1
    ORDER BY sort_order ASC
  `,

  insertSubmission: `
    INSERT INTO registration_form_submissions (form_id, school, answers, ip_address)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `,
};

module.exports = registrationPublicQueries;
