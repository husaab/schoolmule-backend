// queries/reportTemplates.queries.js
//
// Report Template Designer (controllers/reportTemplates.controller.js), the
// template resolver (services/reportEngine/templates/resolve.js) and the
// engine's report bookkeeping (services/reportEngine/generate.js). Every
// statement that takes an id also takes the school, so another school's id
// reads as missing.

// One template row as the designer lists it: no docs, only whether the draft
// differs from what is published (compared in Postgres, so the docs never
// leave the database for a list).
const SUMMARY_COLUMNS = `
    t.template_id, t.name, t.doc_type, t.base_key, t.draft_rev, t.updated_at,
    t.published_version_id, v.version_no AS published_version_no, v.published_at,
    (v.version_id IS NULL OR v.doc IS DISTINCT FROM t.draft_doc) AS has_unpublished_changes,
    (SELECT COUNT(*)::int FROM report_template_assignments a WHERE a.template_id = t.template_id) AS assigned_count`;

// $1 school
const listTemplates = `
    SELECT ${SUMMARY_COLUMNS}
    FROM report_templates t
    LEFT JOIN report_template_versions v ON v.version_id = t.published_version_id
    WHERE t.school = $1 AND t.archived_at IS NULL
    ORDER BY t.doc_type, lower(t.name)
  `;

// $1 template_id, $2 school
const selectTemplateSummary = `
    SELECT ${SUMMARY_COLUMNS}
    FROM report_templates t
    LEFT JOIN report_template_versions v ON v.version_id = t.published_version_id
    WHERE t.template_id = $1 AND t.school = $2 AND t.archived_at IS NULL
  `;

// $1 template_id, $2 school: the summary plus both docs.
const selectTemplateDetail = `
    SELECT ${SUMMARY_COLUMNS}, t.draft_doc, v.doc AS published_doc
    FROM report_templates t
    LEFT JOIN report_template_versions v ON v.version_id = t.published_version_id
    WHERE t.template_id = $1 AND t.school = $2 AND t.archived_at IS NULL
  `;

// $1 template_id, $2 school
const selectTemplateDraft = `
    SELECT template_id, doc_type, name, draft_doc, draft_rev, published_version_id
    FROM report_templates
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL
  `;

// $1 school, $2 doc_type, $3 name, $4 base_key, $5 draft_doc, $6 user_id
const insertTemplate = `
    INSERT INTO report_templates (school, doc_type, name, base_key, draft_doc, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $6)
    RETURNING template_id
  `;

// Optimistic concurrency: only the revision the editor loaded is replaced.
// $1 template_id, $2 school, $3 draft_doc, $4 user_id, $5 expected draft_rev
const updateDraftIfRev = `
    UPDATE report_templates
    SET draft_doc = $3, draft_rev = draft_rev + 1, updated_at = NOW(), updated_by = $4
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL AND draft_rev = $5
    RETURNING draft_rev
  `;

// Restore / discard: replace the draft whatever its revision.
// $1 template_id, $2 school, $3 draft_doc, $4 user_id
const replaceDraft = `
    UPDATE report_templates
    SET draft_doc = $3, draft_rev = draft_rev + 1, updated_at = NOW(), updated_by = $4
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL
    RETURNING draft_rev, draft_doc
  `;

// $1 template_id, $2 school, $3 name, $4 user_id
const renameTemplate = `
    UPDATE report_templates
    SET name = $3, updated_at = NOW(), updated_by = $4
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL
    RETURNING template_id
  `;

// $1 template_id
const countAssignmentsForTemplate = `
    SELECT COUNT(*)::int AS count FROM report_template_assignments WHERE template_id = $1
  `;

// Has any stored report been printed from one of this template's versions? $1 template_id
const templateVersionsUsed = `
    SELECT EXISTS (
      SELECT 1 FROM report_cards rc
      JOIN report_template_versions v ON v.version_id = rc.template_version_id
      WHERE v.template_id = $1
    ) OR EXISTS (
      SELECT 1 FROM progress_reports pr
      JOIN report_template_versions v ON v.version_id = pr.template_version_id
      WHERE v.template_id = $1
    ) AS used
  `;

// $1 template_id, $2 school, $3 user_id
const archiveTemplate = `
    UPDATE report_templates
    SET archived_at = NOW(), updated_at = NOW(), updated_by = $3
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL
    RETURNING template_id
  `;

// Hard delete, in a transaction: unlink, versions, then the template.
const unlinkPublishedVersion = `UPDATE report_templates SET published_version_id = NULL WHERE template_id = $1`;
const deleteTemplateVersions = `DELETE FROM report_template_versions WHERE template_id = $1`;
const deleteTemplate = `DELETE FROM report_templates WHERE template_id = $1 AND school = $2 RETURNING template_id`;

// ── publishing ──

// $1 template_id, $2 school: lock the row while the version number is taken.
const lockTemplate = `
    SELECT template_id FROM report_templates
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL
    FOR UPDATE
  `;

// $1 template_id, $2 doc, $3 doc_sha256, $4 engine_version, $5 note, $6 user_id
const insertVersion = `
    INSERT INTO report_template_versions (template_id, version_no, doc, doc_sha256, engine_version, note, published_by)
    VALUES (
      $1,
      (SELECT COALESCE(MAX(version_no), 0) + 1 FROM report_template_versions WHERE template_id = $1),
      $2, $3, $4, $5, $6
    )
    RETURNING version_id, version_no, published_at
  `;

// $1 template_id, $2 version_id, $3 user_id
const setPublishedVersion = `
    UPDATE report_templates
    SET published_version_id = $2, updated_at = NOW(), updated_by = $3
    WHERE template_id = $1
  `;

// $1 template_id, $2 school
const listVersions = `
    SELECT v.version_id, v.version_no, v.note, v.published_at, v.engine_version,
           (v.version_id = t.published_version_id) AS is_published,
           NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(u.first_name), ''), NULLIF(TRIM(u.last_name), ''))), '') AS published_by_name,
           u.username AS published_by_username
    FROM report_template_versions v
    JOIN report_templates t ON t.template_id = v.template_id
    LEFT JOIN users u ON u.user_id = v.published_by
    WHERE v.template_id = $1 AND t.school = $2 AND t.archived_at IS NULL
    ORDER BY v.version_no DESC
  `;

// $1 version_id, $2 template_id, $3 school
const selectVersionDoc = `
    SELECT v.version_id, v.doc
    FROM report_template_versions v
    JOIN report_templates t ON t.template_id = v.template_id
    WHERE v.version_id = $1 AND v.template_id = $2 AND t.school = $3 AND t.archived_at IS NULL
  `;

// The resolver: the published doc of a winning assignment. $1 version_id
const selectPublishedDoc = `SELECT doc FROM report_template_versions WHERE version_id = $1`;

// ── assignments ──

// Every assignment of a school (one doc type, or both when $2 is NULL), with
// what the resolver needs to know about a template target. No docs.
// $1 school, $2 doc_type | NULL
const listAssignments = `
    SELECT a.assignment_id, a.doc_type, a.template_id, a.default_key, a.grades, a.terms,
           a.priority, a.created_at,
           t.name AS template_name, t.published_version_id, t.archived_at AS template_archived_at
    FROM report_template_assignments a
    LEFT JOIN report_templates t ON t.template_id = a.template_id
    WHERE a.school = $1 AND ($2::text IS NULL OR a.doc_type = $2)
    ORDER BY a.doc_type, a.priority, a.created_at DESC
  `;

// $1 assignment_id, $2 school
const selectAssignment = `
    SELECT a.assignment_id, a.doc_type, a.template_id, a.default_key, a.grades, a.terms,
           a.priority, a.created_at,
           t.name AS template_name, t.published_version_id, t.archived_at AS template_archived_at
    FROM report_template_assignments a
    LEFT JOIN report_templates t ON t.template_id = a.template_id
    WHERE a.assignment_id = $1 AND a.school = $2
  `;

// $1 school, $2 doc_type, $3 template_id, $4 default_key, $5 grades, $6 terms, $7 priority, $8 user_id
const insertAssignment = `
    INSERT INTO report_template_assignments (school, doc_type, template_id, default_key, grades, terms, priority, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING assignment_id
  `;

// $1 assignment_id, $2 school, $3 doc_type, $4 template_id, $5 default_key, $6 grades, $7 terms, $8 priority
const updateAssignment = `
    UPDATE report_template_assignments
    SET doc_type = $3, template_id = $4, default_key = $5, grades = $6, terms = $7, priority = $8
    WHERE assignment_id = $1 AND school = $2
    RETURNING assignment_id
  `;

// $1 assignment_id, $2 school
const deleteAssignment = `
    DELETE FROM report_template_assignments WHERE assignment_id = $1 AND school = $2 RETURNING assignment_id
  `;

// A template an assignment may point at. $1 template_id, $2 school
const selectAssignableTemplate = `
    SELECT template_id, doc_type, name FROM report_templates
    WHERE template_id = $1 AND school = $2 AND archived_at IS NULL
  `;

// ── terms and students ──

// The school's term names for the selected year (all years when $2 is NULL).
// $1 school, $2 school_year_id | NULL
const selectTermNames = `
    SELECT name FROM (
      SELECT DISTINCT ON (lower(btrim(name))) btrim(name) AS name, start_date
      FROM terms
      WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
      ORDER BY lower(btrim(name)), start_date
    ) x
    ORDER BY start_date, name
  `;

// $1 school
const selectAllTermNames = `
    SELECT name FROM (
      SELECT DISTINCT ON (lower(btrim(name))) btrim(name) AS name, start_date
      FROM terms WHERE school = $1
      ORDER BY lower(btrim(name)), start_date
    ) x
    ORDER BY start_date, name
  `;

// The school's active term name in the selected year. $1 school, $2 school_year_id | NULL
const selectActiveTermName = `
    SELECT name FROM terms
    WHERE school = $1 AND is_active = TRUE AND ($2::uuid IS NULL OR school_year_id = $2)
    ORDER BY start_date DESC LIMIT 1
  `;

// Current students for previews: the selected year, not archived.
// $1 school, $2 school_year_id | NULL, $3 grade | NULL, $4 name pattern | NULL
const searchStudents = `
    SELECT student_id, name, grade::text AS grade
    FROM students
    WHERE school = $1
      AND is_archived = FALSE
      AND ($2::uuid IS NULL OR school_year_id = $2)
      AND ($3::text IS NULL OR grade::text = $3)
      AND ($4::text IS NULL OR name ILIKE $4)
    ORDER BY name
    LIMIT 50
  `;

// Every current student of one grade (field values). $1 school, $2 school_year_id | NULL, $3 grade
const selectStudentsInGrade = `
    SELECT student_id, name, grade::text AS grade
    FROM students
    WHERE school = $1
      AND is_archived = FALSE
      AND ($2::uuid IS NULL OR school_year_id = $2)
      AND grade::text = $3
    ORDER BY name
  `;

// A student of the caller's school. $1 student_id, $2 school
const selectSchoolStudent = `
    SELECT student_id, name, grade::text AS grade, school
    FROM students
    WHERE student_id = $1 AND school = $2
  `;

// ── extra field values ──

// $1 student_id, $2 doc_type, $3 term
const selectFieldValues = `
    SELECT field_key, value FROM report_field_values
    WHERE student_id = $1 AND doc_type = $2 AND term = $3
  `;

// $1 student_ids[], $2 doc_type, $3 term
const selectFieldValuesForStudents = `
    SELECT student_id, field_key, value FROM report_field_values
    WHERE student_id = ANY($1::uuid[]) AND doc_type = $2 AND term = $3
  `;

// $1 school, $2 student_id, $3 doc_type, $4 term, $5 field_key, $6 value, $7 user_id
const upsertFieldValue = `
    INSERT INTO report_field_values (school, student_id, doc_type, term, field_key, value, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (student_id, doc_type, term, field_key) DO UPDATE
    SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;

// $1 student_id, $2 doc_type, $3 term, $4 field_key
const deleteFieldValue = `
    DELETE FROM report_field_values
    WHERE student_id = $1 AND doc_type = $2 AND term = $3 AND field_key = $4
  `;

// ── engine report bookkeeping (generate.js) ──

// The legacy upsertGeneratedReportCard (queries/reportCard.queries.js) plus
// what printed it. $1..$6 as legacy, $7 template_version_id, $8 template_key,
// $9 engine_version, $10 render_warnings
const upsertEngineReportCard = `
    INSERT INTO report_cards (student_id, term, student_name, file_path, grade, school,
                              template_version_id, template_key, engine_version, render_warnings)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (student_id, term) DO UPDATE
    SET file_path = EXCLUDED.file_path,
        grade = EXCLUDED.grade,
        school = EXCLUDED.school,
        generated_at = now(),
        template_version_id = EXCLUDED.template_version_id,
        template_key = EXCLUDED.template_key,
        engine_version = EXCLUDED.engine_version,
        render_warnings = EXCLUDED.render_warnings
  `;

// The legacy createProgressReport (queries/progressReports.queries.js) plus
// what printed it. $1 student_id, $2 term, $3 student_name, $4 grade,
// $5 file_path, $6 school, $7..$10 as above
const upsertEngineProgressReport = `
    INSERT INTO progress_reports (student_id, term, student_name, grade, file_path, school,
                                  template_version_id, template_key, engine_version, render_warnings)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (student_id, term)
    DO UPDATE SET
      student_name = EXCLUDED.student_name,
      grade = EXCLUDED.grade,
      file_path = EXCLUDED.file_path,
      school = EXCLUDED.school,
      generated_at = NOW(),
      template_version_id = EXCLUDED.template_version_id,
      template_key = EXCLUDED.template_key,
      engine_version = EXCLUDED.engine_version,
      render_warnings = EXCLUDED.render_warnings
    RETURNING *
  `;

// The legacy generator printed this row: forget any engine provenance an
// earlier engine run left on it. $1 student_id, $2 term
const clearEngineReportCard = `
    UPDATE report_cards
    SET template_version_id = NULL, template_key = NULL, engine_version = NULL, render_warnings = NULL
    WHERE student_id = $1 AND term = $2 AND (template_version_id IS NOT NULL OR template_key IS NOT NULL OR engine_version IS NOT NULL)
  `;
const clearEngineProgressReport = `
    UPDATE progress_reports
    SET template_version_id = NULL, template_key = NULL, engine_version = NULL, render_warnings = NULL
    WHERE student_id = $1 AND term = $2 AND (template_version_id IS NOT NULL OR template_key IS NOT NULL OR engine_version IS NOT NULL)
  `;

module.exports = {
  listTemplates,
  selectTemplateSummary,
  selectTemplateDetail,
  selectTemplateDraft,
  insertTemplate,
  updateDraftIfRev,
  replaceDraft,
  renameTemplate,
  countAssignmentsForTemplate,
  templateVersionsUsed,
  archiveTemplate,
  unlinkPublishedVersion,
  deleteTemplateVersions,
  deleteTemplate,
  lockTemplate,
  insertVersion,
  setPublishedVersion,
  listVersions,
  selectVersionDoc,
  selectPublishedDoc,
  listAssignments,
  selectAssignment,
  insertAssignment,
  updateAssignment,
  deleteAssignment,
  selectAssignableTemplate,
  selectTermNames,
  selectAllTermNames,
  selectActiveTermName,
  searchStudents,
  selectStudentsInGrade,
  selectSchoolStudent,
  selectFieldValues,
  selectFieldValuesForStudents,
  upsertFieldValue,
  deleteFieldValue,
  upsertEngineReportCard,
  upsertEngineProgressReport,
  clearEngineReportCard,
  clearEngineProgressReport,
};
