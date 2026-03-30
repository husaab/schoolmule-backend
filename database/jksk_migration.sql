-- ============================================================
-- JK/SK Grading System - Database Migration
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Skill Domains (top-level groupings like "Language and Communication Skills")
CREATE TABLE IF NOT EXISTS jksk_skill_domains (
  domain_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type   TEXT NOT NULL CHECK (document_type IN ('progress_report', 'report_card')),
  name            TEXT NOT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_type, name, school)
);

-- 2. Skills within domains (e.g., "Speaks clearly and fluently")
CREATE TABLE IF NOT EXISTS jksk_skills (
  skill_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id       UUID NOT NULL REFERENCES jksk_skill_domains(domain_id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain_id, name)
);

-- 3. Skill assessments (the actual D/B/I/N or BG/DV/NI ratings)
CREATE TABLE IF NOT EXISTS jksk_skill_assessments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  skill_id        UUID NOT NULL REFERENCES jksk_skills(skill_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  rating          TEXT,
  school          school NOT NULL,
  assessed_by     UUID REFERENCES users(user_id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, skill_id, term)
);

-- 4. Learning Skills (E/G/S/N section on full report card only)
CREATE TABLE IF NOT EXISTS jksk_learning_skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  skill_name      TEXT NOT NULL,
  rating          TEXT CHECK (rating IN ('E', 'G', 'S', 'N')),
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term, skill_name)
);

-- 5. Domain comments (narrative per domain, report card only)
CREATE TABLE IF NOT EXISTS jksk_domain_comments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  domain_id       UUID NOT NULL REFERENCES jksk_skill_domains(domain_id) ON DELETE CASCADE,
  term            TEXT NOT NULL,
  comment         TEXT,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, domain_id, term)
);

-- 6. Teacher assistants (optional per student per term)
CREATE TABLE IF NOT EXISTS jksk_teacher_assistants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  teacher_assistant_name TEXT,
  term            TEXT NOT NULL,
  school          school NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_jksk_skill_assessments_student_term
  ON jksk_skill_assessments(student_id, term);
CREATE INDEX IF NOT EXISTS idx_jksk_learning_skills_student_term
  ON jksk_learning_skills(student_id, term);
CREATE INDEX IF NOT EXISTS idx_jksk_domain_comments_student_term
  ON jksk_domain_comments(student_id, term);
CREATE INDEX IF NOT EXISTS idx_jksk_skills_domain
  ON jksk_skills(domain_id);
