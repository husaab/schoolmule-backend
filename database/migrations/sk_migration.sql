-- ============================================================
-- SK (Senior Kindergarten) Grading System - Database Migration
-- Run this in Supabase SQL Editor
-- Completely separate from JK system
-- ============================================================

-- 1. Subjects (top-level groupings like "Mathematics", "English/Language Arts")
CREATE TABLE IF NOT EXISTS sk_subjects (
  subject_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type   TEXT NOT NULL CHECK (document_type IN ('progress_report', 'report_card')),
  name            TEXT NOT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_type, name, school)
);

-- 2. Standards (curriculum standards within a subject)
CREATE TABLE IF NOT EXISTS sk_standards (
  standard_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id      UUID NOT NULL REFERENCES sk_subjects(subject_id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(subject_id, name)
);

-- 3. Standard assessments (E/P/DV/EM/NI/NA or E/G/S/NI/NA ratings)
CREATE TABLE IF NOT EXISTS sk_standard_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  standard_id     UUID NOT NULL REFERENCES sk_standards(standard_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  rating          TEXT,
  school          school NOT NULL,
  assessed_by     UUID REFERENCES users(user_id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, standard_id, term)
);

-- 4. Subject comments (Strengths/Next Steps narrative per subject)
CREATE TABLE IF NOT EXISTS sk_subject_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  subject_id      UUID NOT NULL REFERENCES sk_subjects(subject_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  comment         TEXT,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, subject_id, term)
);

-- 5. Teacher assistants (optional per student per term)
CREATE TABLE IF NOT EXISTS sk_teacher_assistants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  teacher_assistant_name TEXT,
  term            TEXT NOT NULL,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term)
);

-- 6. Progress report comments (narrative sections)
CREATE TABLE IF NOT EXISTS sk_progress_report_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  section_type    TEXT NOT NULL,
  comment         TEXT,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term, section_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sk_standard_assessments_student_term
  ON sk_standard_assessments(student_id, term);
CREATE INDEX IF NOT EXISTS idx_sk_subject_comments_student_term
  ON sk_subject_comments(student_id, term);
CREATE INDEX IF NOT EXISTS idx_sk_standards_subject
  ON sk_standards(subject_id);
CREATE INDEX IF NOT EXISTS idx_sk_progress_report_comments_student_term
  ON sk_progress_report_comments(student_id, term);
