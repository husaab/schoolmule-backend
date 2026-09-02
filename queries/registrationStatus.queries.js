// queries/registrationStatus.queries.js
//
// The per-school submission status vocabulary. Statuses are shared by every
// form in a school, so all of these scope on the caller's school rather than
// on a form.

const registrationStatusQueries = {
  // Seeds the built-in vocabulary for a school that has none yet. Submissions
  // default to the 'new' key, which the composite FK requires to exist, so a
  // newly-onboarded school would otherwise reject its first submission.
  // Idempotent: existing keys are left exactly as the school edited them.
  seedBuiltinsForSchool: `
    INSERT INTO registration_statuses (school, key, label, color, sort_order, is_builtin, is_default)
    SELECT $1, v.key, v.label, v.color, v.sort_order, true, v.is_default
    FROM (VALUES
      ('new',      'New',      'cyan',    0, true),
      ('reviewed', 'Reviewed', 'emerald', 1, false),
      ('waitlist', 'Waitlist', 'amber',   2, false),
      ('archived', 'Archived', 'slate',   3, false)
    ) AS v(key, label, color, sort_order, is_default)
    ON CONFLICT (school, key) DO NOTHING
  `,

  selectStatusesBySchool: `
    SELECT status_id, school, key, label, color, sort_order, is_builtin, is_default
    FROM registration_statuses
    WHERE school = $1
    ORDER BY sort_order ASC, label ASC
  `,

  selectStatusByKey: `
    SELECT status_id, school, key, label, color, sort_order, is_builtin, is_default
    FROM registration_statuses
    WHERE school = $1 AND key = $2
  `,

  selectStatusById: `
    SELECT status_id, school, key, label, color, sort_order, is_builtin, is_default
    FROM registration_statuses
    WHERE status_id = $1 AND school = $2
  `,

  insertStatus: `
    INSERT INTO registration_statuses (school, key, label, color, sort_order)
    VALUES ($1, $2, $3, $4,
      COALESCE((SELECT MAX(sort_order) + 1 FROM registration_statuses WHERE school = $1), 0))
    RETURNING *
  `,

  // Only label and colour are editable. The key is deliberately immutable:
  // submissions store it, and the built-in 'new' key is what the sidebar badge
  // counts, so letting it change would silently break both.
  updateStatus: `
    UPDATE registration_statuses
    SET label = $3, color = $4, updated_at = now()
    WHERE status_id = $1 AND school = $2
    RETURNING *
  `,

  deleteStatus: `
    DELETE FROM registration_statuses
    WHERE status_id = $1 AND school = $2 AND is_builtin = false
    RETURNING *
  `,

  // Drives the "N submissions use this status" guard before a delete.
  countSubmissionsWithStatus: `
    SELECT COUNT(*) AS count
    FROM registration_form_submissions
    WHERE school = $1 AND status = $2
  `,

  // Bulk reassignment used when deleting a status that is still in use.
  reassignSubmissions: `
    UPDATE registration_form_submissions
    SET status = $3
    WHERE school = $1 AND status = $2
  `,

  // Persists a drag-reorder. Applied one row at a time inside a transaction.
  updateSortOrder: `
    UPDATE registration_statuses
    SET sort_order = $3, updated_at = now()
    WHERE status_id = $1 AND school = $2
  `,
};

module.exports = registrationStatusQueries;
