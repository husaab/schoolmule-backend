// queries/studentCustomFields.queries.js
//
// The school's list of student custom fields (student_custom_fields). Every
// statement is scoped to the caller's school, so an id from another school
// matches nothing.

const FIELD_COLUMNS = `
  f.field_id, f.school, f.label, f.field_type, f.options, f.sort_order,
  f.created_at, f.updated_at, f.deleted_at
`;

// A new field goes last in the school's order.
// $1 school, $2 label, $3 field_type, $4 options (JSON text or null), $5 created_by
const INSERT_FIELD = `
    INSERT INTO student_custom_fields AS f (school, label, field_type, options, sort_order, created_by)
    VALUES (
      $1, $2, $3, $4::jsonb,
      (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM student_custom_fields WHERE school = $1 AND deleted_at IS NULL),
      $5
    )`;

const studentCustomFieldsQueries = {
  // The fields in use, in the order the school put them. $1 school
  selectLiveFields: `
    SELECT ${FIELD_COLUMNS}
    FROM student_custom_fields f
    WHERE f.school = $1 AND f.deleted_at IS NULL
    ORDER BY f.sort_order, f.created_at, f.field_id
  `,

  // Deleted fields, newest first, with who deleted them. $1 school
  selectDeletedFields: `
    SELECT ${FIELD_COLUMNS},
      NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS deleted_by_name
    FROM student_custom_fields f
    LEFT JOIN users u ON u.user_id = f.deleted_by
    WHERE f.school = $1 AND f.deleted_at IS NOT NULL
    ORDER BY f.deleted_at DESC
  `,

  // $1 field_id, $2 school
  selectFieldById: `
    SELECT ${FIELD_COLUMNS}
    FROM student_custom_fields f
    WHERE f.field_id = $1 AND f.school = $2
  `,

  // $1 school
  countLiveFields: `
    SELECT COUNT(*)::int AS count
    FROM student_custom_fields
    WHERE school = $1 AND deleted_at IS NULL
  `,

  insertField: `${INSERT_FIELD}
    RETURNING ${FIELD_COLUMNS}
  `,

  // The forms import's "new field from this question": the field of that
  // name, made now if the school has none. `created` says which happened.
  getOrCreateField: `${INSERT_FIELD}
    ON CONFLICT (school, lower(btrim(label))) WHERE deleted_at IS NULL
    DO UPDATE SET label = f.label
    RETURNING ${FIELD_COLUMNS}, (xmax = 0) AS created
  `,

  // Name and, for a dropdown, choices. A null leaves that part as it is.
  // $1 field_id, $2 school, $3 label, $4 options (JSON text or null)
  updateField: `
    UPDATE student_custom_fields f
    SET label      = COALESCE($3, f.label),
        options    = COALESCE($4::jsonb, f.options),
        updated_at = NOW()
    WHERE f.field_id = $1 AND f.school = $2 AND f.deleted_at IS NULL
    RETURNING ${FIELD_COLUMNS}
  `,

  // The order the admin dragged them into. $1 school, $2 field ids in order
  reorderFields: `
    UPDATE student_custom_fields f
    SET sort_order = o.position - 1, updated_at = NOW()
    FROM unnest($2::uuid[]) WITH ORDINALITY AS o(field_id, position)
    WHERE f.field_id = o.field_id AND f.school = $1 AND f.deleted_at IS NULL
  `,

  // Delete only hides the field: the values stay on the students, and restore
  // brings both back. $1 field_id, $2 school, $3 deleted_by
  softDeleteField: `
    UPDATE student_custom_fields f
    SET deleted_at = NOW(), deleted_by = $3, updated_at = NOW()
    WHERE f.field_id = $1 AND f.school = $2 AND f.deleted_at IS NULL
    RETURNING ${FIELD_COLUMNS}
  `,

  // Back at the end of the list. $1 field_id, $2 school
  restoreField: `
    UPDATE student_custom_fields f
    SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW(),
        sort_order = (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM student_custom_fields
                      WHERE school = $2 AND deleted_at IS NULL)
    WHERE f.field_id = $1 AND f.school = $2 AND f.deleted_at IS NOT NULL
    RETURNING ${FIELD_COLUMNS}
  `,

  // What deleting would hide: this year's students holding a value, and the
  // forms whose import feeds the field. $1 field_id, $2 school, $3 school_year_id
  selectFieldUsage: `
    SELECT
      (SELECT COUNT(*)::int FROM students s
        WHERE s.school = $2 AND s.school_year_id = $3
          AND s.custom_fields -> 'values' ? $1::text) AS student_count,
      (SELECT COUNT(DISTINCT m.form_id)::int FROM registration_field_mappings m
        JOIN registration_forms rf ON rf.form_id = m.form_id
        WHERE m.custom_field_id = $1::uuid AND rf.school = $2) AS form_count
  `,
};

module.exports = studentCustomFieldsQueries;
