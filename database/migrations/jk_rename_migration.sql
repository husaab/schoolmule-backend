-- ============================================================
-- Rename jksk_* tables to jk_* (JK-only system)
-- Run this in Supabase SQL Editor
-- Preserves all existing data and FK constraints
-- ============================================================

-- Drop old indexes first (they reference old table names)
DROP INDEX IF EXISTS idx_jksk_skill_assessments_student_term;
DROP INDEX IF EXISTS idx_jksk_learning_skills_student_term;
DROP INDEX IF EXISTS idx_jksk_domain_comments_student_term;
DROP INDEX IF EXISTS idx_jksk_skills_domain;
DROP INDEX IF EXISTS idx_jksk_progress_report_comments_student_term;

-- Rename tables
ALTER TABLE jksk_skill_domains RENAME TO jk_skill_domains;
ALTER TABLE jksk_skills RENAME TO jk_skills;
ALTER TABLE jksk_skill_assessments RENAME TO jk_skill_assessments;
ALTER TABLE jksk_learning_skills RENAME TO jk_learning_skills;
ALTER TABLE jksk_domain_comments RENAME TO jk_domain_comments;
ALTER TABLE jksk_teacher_assistants RENAME TO jk_teacher_assistants;
ALTER TABLE jksk_progress_report_comments RENAME TO jk_progress_report_comments;

-- Recreate indexes with new names
CREATE INDEX IF NOT EXISTS idx_jk_skill_assessments_student_term
  ON jk_skill_assessments(student_id, term);
CREATE INDEX IF NOT EXISTS idx_jk_learning_skills_student_term
  ON jk_learning_skills(student_id, term);
CREATE INDEX IF NOT EXISTS idx_jk_domain_comments_student_term
  ON jk_domain_comments(student_id, term);
CREATE INDEX IF NOT EXISTS idx_jk_skills_domain
  ON jk_skills(domain_id);
CREATE INDEX IF NOT EXISTS idx_jk_progress_report_comments_student_term
  ON jk_progress_report_comments(student_id, term);
