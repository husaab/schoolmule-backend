-- ============================================================
-- JK/SK Progress Report Comments - Database Migration
-- Adds two narrative comment sections for progress reports:
--   - academic_achievement
--   - socio_emotional
-- Run this in Supabase SQL Editor AFTER jksk_migration.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS jksk_progress_report_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  section_type    TEXT NOT NULL CHECK (section_type IN ('academic_achievement', 'socio_emotional')),
  comment         TEXT,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term, section_type)
);

CREATE INDEX IF NOT EXISTS idx_jksk_progress_report_comments_student_term
  ON jksk_progress_report_comments(student_id, term);
