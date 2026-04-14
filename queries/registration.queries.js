const registrationQueries = {
  // ─── Forms ────────────────────────────────────────────────────────────

  selectFormsBySchool: `
    SELECT f.*,
      (SELECT COUNT(*) FROM registration_form_submissions s
       WHERE s.form_id = f.form_id AND s.status = 'new') AS new_submissions_count
    FROM registration_forms f
    WHERE f.school = $1
    ORDER BY f.created_at DESC
  `,

  selectFormById: `
    SELECT f.*,
      (SELECT COUNT(*) FROM registration_form_submissions s
       WHERE s.form_id = f.form_id AND s.status = 'new') AS new_submissions_count
    FROM registration_forms f
    WHERE f.form_id = $1 AND f.school = $2
  `,

  selectFormWithFields: `
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
    WHERE f.form_id = $1 AND f.school = $2
    GROUP BY f.form_id
  `,

  insertForm: `
    INSERT INTO registration_forms (school, title, slug, description, status, created_by)
    VALUES ($1, $2, $3, $4, 'draft', $5)
    RETURNING *
  `,

  updateForm: `
    UPDATE registration_forms
    SET title = $1, slug = $2, description = $3, updated_at = NOW()
    WHERE form_id = $4 AND school = $5
    RETURNING *
  `,

  updateFormStatus: `
    UPDATE registration_forms
    SET status = $1,
        published_at = CASE WHEN $4 = 'published' THEN NOW() ELSE published_at END,
        closed_at = CASE WHEN $5 = 'closed' THEN NOW() ELSE closed_at END,
        updated_at = NOW()
    WHERE form_id = $2 AND school = $3
    RETURNING *
  `,

  updateFormBanner: `
    UPDATE registration_forms
    SET banner_image_path = $1, updated_at = NOW()
    WHERE form_id = $2 AND school = $3
    RETURNING *
  `,

  deleteForm: `
    DELETE FROM registration_forms
    WHERE form_id = $1 AND school = $2 AND status = 'draft'
    RETURNING *
  `,

  checkSlugExists: `
    SELECT form_id FROM registration_forms
    WHERE school = $1 AND slug = $2 AND form_id != $3
    LIMIT 1
  `,

  // ─── Fields ───────────────────────────────────────────────────────────

  deleteFieldsByFormId: `
    DELETE FROM registration_form_fields WHERE form_id = $1
  `,

  deleteFieldsByIds: `
    DELETE FROM registration_form_fields
    WHERE form_id = $1 AND field_id = ANY($2)
  `,

  updateField: `
    UPDATE registration_form_fields
    SET field_type = $1, label = $2, placeholder = $3, is_required = $4, options = $5, sort_order = $6
    WHERE field_id = $7 AND form_id = $8
    RETURNING *
  `,

  insertField: `
    INSERT INTO registration_form_fields
      (form_id, field_type, label, placeholder, is_required, options, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `,

  selectFieldsByFormId: `
    SELECT * FROM registration_form_fields
    WHERE form_id = $1
    ORDER BY sort_order ASC
  `,

  // ─── Submissions ──────────────────────────────────────────────────────

  selectSubmissions: `
    SELECT * FROM registration_form_submissions
    WHERE form_id = $1
    ORDER BY submitted_at DESC
    LIMIT $2 OFFSET $3
  `,

  selectSubmissionsFiltered: `
    SELECT * FROM registration_form_submissions
    WHERE form_id = $1
      AND ($2::varchar IS NULL OR status = $2)
      AND ($3::timestamptz IS NULL OR submitted_at >= $3)
      AND ($4::timestamptz IS NULL OR submitted_at <= $4)
    ORDER BY submitted_at DESC
    LIMIT $5 OFFSET $6
  `,

  countSubmissionsFiltered: `
    SELECT COUNT(*) FROM registration_form_submissions
    WHERE form_id = $1
      AND ($2::varchar IS NULL OR status = $2)
      AND ($3::timestamptz IS NULL OR submitted_at >= $3)
      AND ($4::timestamptz IS NULL OR submitted_at <= $4)
  `,

  selectSubmissionById: `
    SELECT * FROM registration_form_submissions
    WHERE submission_id = $1
  `,

  updateSubmissionStatus: `
    UPDATE registration_form_submissions
    SET status = $1
    WHERE submission_id = $2
    RETURNING *
  `,

  selectSubmissionsForExport: `
    SELECT * FROM registration_form_submissions
    WHERE form_id = $1
      AND ($2::varchar IS NULL OR status = $2)
      AND ($3::timestamptz IS NULL OR submitted_at >= $3)
      AND ($4::timestamptz IS NULL OR submitted_at <= $4)
    ORDER BY submitted_at DESC
  `,

  deleteSubmission: `
    DELETE FROM registration_form_submissions
    WHERE submission_id = $1
    RETURNING *
  `,

  countNewSubmissionsBySchool: `
    SELECT COUNT(*) AS count
    FROM registration_form_submissions s
    JOIN registration_forms f ON s.form_id = f.form_id
    WHERE f.school = $1 AND s.status = 'new'
  `,
};

module.exports = registrationQueries;
