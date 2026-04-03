// ============================================================
// SK Grading System - Database Queries
// ============================================================

// -- Subjects & Standards --

const getSubjectsByDocumentType = `
  SELECT
    s.subject_id,
    s.document_type,
    s.name AS subject_name,
    s.sort_order AS subject_sort_order,
    st.standard_id,
    st.name AS standard_name,
    st.description AS standard_description,
    st.sort_order AS standard_sort_order
  FROM sk_subjects s
  LEFT JOIN sk_standards st ON s.subject_id = st.subject_id
  WHERE s.document_type = $1 AND s.school = $2
  ORDER BY s.sort_order, st.sort_order
`;

// -- Subject CRUD --

const createSubject = `
  INSERT INTO sk_subjects (document_type, name, sort_order, school)
  VALUES ($1, $2, $3, $4)
  RETURNING *
`;

const updateSubject = `
  UPDATE sk_subjects
  SET name = $2, sort_order = $3
  WHERE subject_id = $1
  RETURNING *
`;

const deleteSubject = `
  DELETE FROM sk_subjects WHERE subject_id = $1
`;

// -- Standard CRUD --

const createStandard = `
  INSERT INTO sk_standards (subject_id, name, description, sort_order)
  VALUES ($1, $2, $3, $4)
  RETURNING *
`;

const updateStandard = `
  UPDATE sk_standards
  SET name = $2, description = $3, sort_order = $4
  WHERE standard_id = $1
  RETURNING *
`;

const deleteStandard = `
  DELETE FROM sk_standards WHERE standard_id = $1
`;

// -- Standard Assessments (E/P/DV/EM/NI/N/A or E/G/S/NI/NA ratings) --

const getStandardAssessmentsForStudent = `
  SELECT
    sa.id,
    sa.student_id,
    sa.standard_id,
    sa.term,
    sa.rating,
    sa.assessed_by,
    sa.updated_at,
    st.name AS standard_name,
    st.description AS standard_description,
    s.subject_id,
    s.name AS subject_name,
    s.document_type
  FROM sk_standard_assessments sa
  JOIN sk_standards st ON sa.standard_id = st.standard_id
  JOIN sk_subjects s ON st.subject_id = s.subject_id
  WHERE sa.student_id = $1 AND sa.term = $2 AND s.document_type = $3
  ORDER BY s.sort_order, st.sort_order
`;

const upsertStandardAssessment = `
  INSERT INTO sk_standard_assessments (student_id, standard_id, term, rating, school, assessed_by)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (student_id, standard_id, term)
  DO UPDATE SET
    rating = EXCLUDED.rating,
    assessed_by = EXCLUDED.assessed_by,
    updated_at = NOW()
  RETURNING *
`;

// -- Subject Comments --

const getSubjectCommentsForStudent = `
  SELECT
    sc.id,
    sc.student_id,
    sc.subject_id,
    sc.term,
    sc.comment,
    sc.updated_at,
    s.name AS subject_name
  FROM sk_subject_comments sc
  JOIN sk_subjects s ON sc.subject_id = s.subject_id
  WHERE sc.student_id = $1 AND sc.term = $2
  ORDER BY s.sort_order
`;

const upsertSubjectComment = `
  INSERT INTO sk_subject_comments (student_id, subject_id, term, comment, school)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (student_id, subject_id, term)
  DO UPDATE SET
    comment = EXCLUDED.comment,
    updated_at = NOW()
  RETURNING *
`;

// -- Teacher Assistants --

const getTeacherAssistant = `
  SELECT
    id,
    student_id,
    teacher_assistant_name,
    term
  FROM sk_teacher_assistants
  WHERE student_id = $1 AND term = $2
`;

const upsertTeacherAssistant = `
  INSERT INTO sk_teacher_assistants (student_id, teacher_assistant_name, term, school)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (student_id, term)
  DO UPDATE SET
    teacher_assistant_name = EXCLUDED.teacher_assistant_name
  RETURNING *
`;

// -- Progress Report Comments (Academic Achievement / Socio-Emotional) --

const getProgressReportCommentsForStudent = `
  SELECT
    id,
    student_id,
    term,
    section_type,
    comment,
    updated_at
  FROM sk_progress_report_comments
  WHERE student_id = $1 AND term = $2
  ORDER BY section_type
`;

const upsertProgressReportComment = `
  INSERT INTO sk_progress_report_comments (student_id, term, section_type, comment, school)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (student_id, term, section_type)
  DO UPDATE SET
    comment = EXCLUDED.comment,
    updated_at = NOW()
  RETURNING *
`;

// -- Bulk queries for all students in a grade/school --

const getStandardAssessmentsForStudents = `
  SELECT
    sa.id,
    sa.student_id,
    sa.standard_id,
    sa.term,
    sa.rating,
    sa.assessed_by,
    sa.updated_at
  FROM sk_standard_assessments sa
  JOIN sk_standards st ON sa.standard_id = st.standard_id
  JOIN sk_subjects s ON st.subject_id = s.subject_id
  WHERE sa.student_id = ANY($1) AND sa.term = $2 AND s.document_type = $3
`;

const getSubjectCommentsForStudents = `
  SELECT
    sc.id,
    sc.student_id,
    sc.subject_id,
    sc.term,
    sc.comment,
    s.name AS subject_name
  FROM sk_subject_comments sc
  JOIN sk_subjects s ON sc.subject_id = s.subject_id
  WHERE sc.student_id = ANY($1) AND sc.term = $2
`;

module.exports = {
  getSubjectsByDocumentType,
  createSubject,
  updateSubject,
  deleteSubject,
  createStandard,
  updateStandard,
  deleteStandard,
  getStandardAssessmentsForStudent,
  upsertStandardAssessment,
  getSubjectCommentsForStudent,
  upsertSubjectComment,
  getTeacherAssistant,
  upsertTeacherAssistant,
  getProgressReportCommentsForStudent,
  upsertProgressReportComment,
  getStandardAssessmentsForStudents,
  getSubjectCommentsForStudents
};
