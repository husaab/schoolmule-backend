// controllers/reportSubjectLayout.controller.js
//
// Report templates → Subject headings: the school's headings on grades 1-8
// progress reports, in print order, with the subjects under each and the
// class names each subject covers (services/reportEngine/subjectLayout.js).
//
//   GET    /api/report-templates/subject-layout  → { sections, updatedAt, classSubjects }
//   PUT    /api/report-templates/subject-layout  { sections } → the saved layout
//   DELETE /api/report-templates/subject-layout  → back to A to Z with no headings
//
// classSubjects: the subjects of the school's grades 1-8 classes in the
// selected school year, so the page can show which ones no heading covers.

const db = require('../config/database');
const logger = require('../logger');
const { readSubjectLayout } = require('../services/reportEngine/subjectLayout');

// Bare JSON, like the rest of /api/report-templates.
const ok = (res, data) => res.status(200).json(data);
const fail = (res, status, message) => res.status(status).json({ status: 'failed', message });

const SELECT_LAYOUT = 'SELECT sections, updated_at FROM report_subject_layouts WHERE school = $1';
const SELECT_CLASS_SUBJECTS = `
  SELECT DISTINCT btrim(c.subject) AS subject
  FROM classes c
  WHERE c.school = $1
    AND ($2::uuid IS NULL OR c.school_year_id = $2::uuid)
    AND c.grade::text NOT IN ('JK', 'SK')
    AND c.archived_at IS NULL
    AND btrim(c.subject) <> ''
  ORDER BY 1
`;
const UPSERT_LAYOUT = `
  INSERT INTO report_subject_layouts (school, sections, updated_by, updated_at)
  VALUES ($1, $2::jsonb, $3, NOW())
  ON CONFLICT (school) DO UPDATE
    SET sections = EXCLUDED.sections, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  RETURNING sections, updated_at
`;
const DELETE_LAYOUT = 'DELETE FROM report_subject_layouts WHERE school = $1';

const yearOf = (req) => (req.schoolYear && req.schoolYear.schoolYearId) || null;
const reply = (row) => ({ sections: (row && row.sections) || [], updatedAt: (row && row.updated_at) || null });

const getSubjectLayout = async (req, res) => {
  try {
    const [layout, subjects] = await Promise.all([
      db.query(SELECT_LAYOUT, [req.user.school]),
      db.query(SELECT_CLASS_SUBJECTS, [req.user.school, yearOf(req)]),
    ]);
    return ok(res, { ...reply(layout.rows[0]), classSubjects: subjects.rows.map((r) => r.subject) });
  } catch (err) {
    logger.error({ err }, 'Failed to load the subject headings');
    return fail(res, 500, "The subject headings couldn't be loaded");
  }
};

const putSubjectLayout = async (req, res) => {
  const read = readSubjectLayout(req.body && req.body.sections);
  if (read.error) return fail(res, 400, read.error);
  try {
    const { rows } = await db.query(UPSERT_LAYOUT, [req.user.school, JSON.stringify(read.value), req.user.userId]);
    return ok(res, reply(rows[0]));
  } catch (err) {
    logger.error({ err }, 'Failed to save the subject headings');
    return fail(res, 500, "The subject headings couldn't be saved");
  }
};

const deleteSubjectLayout = async (req, res) => {
  try {
    await db.query(DELETE_LAYOUT, [req.user.school]);
    return ok(res, reply(null));
  } catch (err) {
    logger.error({ err }, 'Failed to remove the subject headings');
    return fail(res, 500, "The subject headings couldn't be removed");
  }
};

module.exports = { getSubjectLayout, putSubjectLayout, deleteSubjectLayout };
