// ============================================================
// JK/SK Grading System - Database Queries
// ============================================================

// -- Skill Domains & Skills --

const getSkillDomainsByDocumentType = `
  SELECT
    d.domain_id,
    d.document_type,
    d.name AS domain_name,
    d.sort_order AS domain_sort_order,
    s.skill_id,
    s.name AS skill_name,
    s.description AS skill_description,
    s.sort_order AS skill_sort_order
  FROM jksk_skill_domains d
  LEFT JOIN jksk_skills s ON d.domain_id = s.domain_id
  WHERE d.document_type = $1 AND d.school = $2
  ORDER BY d.sort_order, s.sort_order
`;

// -- Domain CRUD --

const createDomain = `
  INSERT INTO jksk_skill_domains (document_type, name, sort_order, school)
  VALUES ($1, $2, $3, $4)
  RETURNING *
`;

const updateDomain = `
  UPDATE jksk_skill_domains
  SET name = $2, sort_order = $3
  WHERE domain_id = $1
  RETURNING *
`;

const deleteDomain = `
  DELETE FROM jksk_skill_domains WHERE domain_id = $1
`;

// -- Skill CRUD --

const createSkill = `
  INSERT INTO jksk_skills (domain_id, name, description, sort_order)
  VALUES ($1, $2, $3, $4)
  RETURNING *
`;

const updateSkill = `
  UPDATE jksk_skills
  SET name = $2, description = $3, sort_order = $4
  WHERE skill_id = $1
  RETURNING *
`;

const deleteSkill = `
  DELETE FROM jksk_skills WHERE skill_id = $1
`;

// -- Skill Assessments (D/B/I/N or BG/DV/NI ratings) --

const getSkillAssessmentsForStudent = `
  SELECT
    sa.id,
    sa.student_id,
    sa.skill_id,
    sa.term,
    sa.rating,
    sa.assessed_by,
    sa.updated_at,
    s.name AS skill_name,
    s.description AS skill_description,
    d.domain_id,
    d.name AS domain_name,
    d.document_type
  FROM jksk_skill_assessments sa
  JOIN jksk_skills s ON sa.skill_id = s.skill_id
  JOIN jksk_skill_domains d ON s.domain_id = d.domain_id
  WHERE sa.student_id = $1 AND sa.term = $2 AND d.document_type = $3
  ORDER BY d.sort_order, s.sort_order
`;

const upsertSkillAssessment = `
  INSERT INTO jksk_skill_assessments (student_id, skill_id, term, rating, school, assessed_by)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (student_id, skill_id, term)
  DO UPDATE SET
    rating = EXCLUDED.rating,
    assessed_by = EXCLUDED.assessed_by,
    updated_at = NOW()
  RETURNING *
`;

// -- Learning Skills (E/G/S/N) --

const getLearningSkillsForStudent = `
  SELECT
    id,
    student_id,
    term,
    skill_name,
    rating,
    updated_at
  FROM jksk_learning_skills
  WHERE student_id = $1 AND term = $2
  ORDER BY skill_name
`;

const upsertLearningSkill = `
  INSERT INTO jksk_learning_skills (student_id, term, skill_name, rating, school)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (student_id, term, skill_name)
  DO UPDATE SET
    rating = EXCLUDED.rating,
    updated_at = NOW()
  RETURNING *
`;

// -- Domain Comments --

const getDomainCommentsForStudent = `
  SELECT
    dc.id,
    dc.student_id,
    dc.domain_id,
    dc.term,
    dc.comment,
    dc.updated_at,
    d.name AS domain_name
  FROM jksk_domain_comments dc
  JOIN jksk_skill_domains d ON dc.domain_id = d.domain_id
  WHERE dc.student_id = $1 AND dc.term = $2
  ORDER BY d.sort_order
`;

const upsertDomainComment = `
  INSERT INTO jksk_domain_comments (student_id, domain_id, term, comment, school)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (student_id, domain_id, term)
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
  FROM jksk_teacher_assistants
  WHERE student_id = $1 AND term = $2
`;

const upsertTeacherAssistant = `
  INSERT INTO jksk_teacher_assistants (student_id, teacher_assistant_name, term, school)
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
  FROM jksk_progress_report_comments
  WHERE student_id = $1 AND term = $2
  ORDER BY section_type
`;

const upsertProgressReportComment = `
  INSERT INTO jksk_progress_report_comments (student_id, term, section_type, comment, school)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (student_id, term, section_type)
  DO UPDATE SET
    comment = EXCLUDED.comment,
    updated_at = NOW()
  RETURNING *
`;

// -- Bulk queries for all students in a grade/school --

const getSkillAssessmentsForStudents = `
  SELECT
    sa.id,
    sa.student_id,
    sa.skill_id,
    sa.term,
    sa.rating,
    sa.assessed_by,
    sa.updated_at
  FROM jksk_skill_assessments sa
  JOIN jksk_skills s ON sa.skill_id = s.skill_id
  JOIN jksk_skill_domains d ON s.domain_id = d.domain_id
  WHERE sa.student_id = ANY($1) AND sa.term = $2 AND d.document_type = $3
`;

const getLearningSkillsForStudents = `
  SELECT
    id,
    student_id,
    term,
    skill_name,
    rating
  FROM jksk_learning_skills
  WHERE student_id = ANY($1) AND term = $2
`;

const getDomainCommentsForStudents = `
  SELECT
    dc.id,
    dc.student_id,
    dc.domain_id,
    dc.term,
    dc.comment,
    d.name AS domain_name
  FROM jksk_domain_comments dc
  JOIN jksk_skill_domains d ON dc.domain_id = d.domain_id
  WHERE dc.student_id = ANY($1) AND dc.term = $2
`;

module.exports = {
  getSkillDomainsByDocumentType,
  createDomain,
  updateDomain,
  deleteDomain,
  createSkill,
  updateSkill,
  deleteSkill,
  getSkillAssessmentsForStudent,
  upsertSkillAssessment,
  getLearningSkillsForStudent,
  upsertLearningSkill,
  getDomainCommentsForStudent,
  upsertDomainComment,
  getTeacherAssistant,
  upsertTeacherAssistant,
  getSkillAssessmentsForStudents,
  getLearningSkillsForStudents,
  getDomainCommentsForStudents,
  getProgressReportCommentsForStudent,
  upsertProgressReportComment
};
