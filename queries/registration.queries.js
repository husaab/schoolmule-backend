const registrationQueries = {
  // ─── Forms ────────────────────────────────────────────────────────────

  selectFormsBySchool: `
    SELECT f.*,
      (SELECT COUNT(*) FROM registration_form_submissions s
       WHERE s.form_id = f.form_id AND s.status = 'new') AS new_submissions_count
    FROM registration_forms f
    WHERE f.school = $1 AND ($2::uuid IS NULL OR f.created_by = $2::uuid)
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
            'payment', ff.payment_config,
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
    SET field_type = $1, label = $2, placeholder = $3, is_required = $4, options = $5, sort_order = $6, payment_config = $9
    WHERE field_id = $7 AND form_id = $8
    RETURNING *
  `,

  insertField: `
    INSERT INTO registration_form_fields
      (form_id, field_type, label, placeholder, is_required, options, sort_order, payment_config)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

  // selectSubmissionsFiltered is now built dynamically in the controller
  // because the ORDER BY clause must vary based on sort parameters
  // (specifically for radio fields that need array_position-based natural sort).
  // See buildSubmissionsQuery() in registration.controller.js

  // Filtered submission counts are built dynamically in the controller (see
  // buildSubmissionsWhere in registration.controller.js) so the count matches
  // the field-value filters applied to the list query.

  // All three of the below are school-scoped through the parent form. Without
  // that join a user from any school could read, restatus, or delete another
  // school's submission just by knowing its UUID.
  selectSubmissionById: `
    SELECT s.*,
      (SELECT name FROM students WHERE student_id = s.imported_student_id) AS imported_student_name,
      (SELECT jsonb_build_object('name', st.name, 'grade', st.grade::text) FROM students_all st
        WHERE st.student_id = s.student_id) AS linked_student,
      (SELECT jsonb_build_object(
          'chargeId', c.charge_id, 'status', c.status, 'amountCents', c.amount_cents,
          'amountPaidCents', c.amount_paid_cents, 'amountRefundedCents', c.amount_refunded_cents,
          'chosenMethod', c.chosen_method, 'disputeStatus', c.dispute_status, 'livemode', c.livemode,
          'lastPayment', (SELECT jsonb_build_object('kind', p.kind, 'cardBrand', p.card_brand, 'cardLast4', p.card_last4, 'wallet', p.wallet)
                            FROM charge_payments p
                           WHERE p.charge_id = c.charge_id AND p.kind IN ('card','cash','cheque','other') AND p.status = 'succeeded'
                           ORDER BY p.created_at DESC LIMIT 1))
         FROM charges c WHERE c.submission_id = s.submission_id) AS payment
    FROM registration_form_submissions s
    JOIN registration_forms f ON s.form_id = f.form_id
    WHERE s.submission_id = $1 AND f.school = $2
  `,

  updateSubmissionStatus: `
    UPDATE registration_form_submissions s
    SET status = $1
    FROM registration_forms f
    WHERE s.submission_id = $2
      AND s.form_id = f.form_id
      AND f.school = $3
    RETURNING s.*
  `,

  // School-scoped via the parent form so a user can only edit submissions
  // belonging to their own school.
  updateSubmissionAnswers: `
    UPDATE registration_form_submissions s
    SET answers = $1
    FROM registration_forms f
    WHERE s.submission_id = $2
      AND s.form_id = f.form_id
      AND f.school = $3
    RETURNING s.*
  `,

  // selectSubmissionsForExport is also built dynamically in the controller
  // for the same reason as selectSubmissionsFiltered.

  deleteSubmission: `
    DELETE FROM registration_form_submissions s
    USING registration_forms f
    WHERE s.submission_id = $1
      AND s.form_id = f.form_id
      AND f.school = $2
    RETURNING s.*
  `,

  countNewSubmissionsBySchool: `
    SELECT COUNT(*) AS count
    FROM registration_form_submissions s
    JOIN registration_forms f ON s.form_id = f.form_id
    WHERE f.school = $1 AND s.status = 'new' AND ($2::uuid IS NULL OR f.created_by = $2::uuid)
  `,
};

module.exports = registrationQueries;
