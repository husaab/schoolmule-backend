-- ============================================================
-- SchoolMule Test Database Schema
-- Generated from production query files and migration SQL
-- ============================================================

-- Enums
CREATE TYPE school AS ENUM ('ALHAADIACADEMY', 'PLAYGROUND');
CREATE TYPE attendance_status AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- ─── Tier 0: Foundation Tables (no FKs) ──────────────────────

CREATE TABLE schools (
  school_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_code            school NOT NULL UNIQUE,
  name                   TEXT NOT NULL,
  slug                   VARCHAR(100) UNIQUE,
  address                TEXT,
  phone                  TEXT,
  email                  TEXT,
  timezone               TEXT,
  academic_year_start_date DATE,
  academic_year_end_date DATE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  user_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  TEXT NOT NULL,
  username               TEXT NOT NULL,
  password               TEXT NOT NULL,
  first_name             TEXT NOT NULL,
  last_name              TEXT NOT NULL,
  school                 school NOT NULL,
  role                   TEXT NOT NULL,
  email_token            TEXT,
  is_verified            BOOLEAN DEFAULT FALSE,
  is_verified_school     BOOLEAN DEFAULT FALSE,
  is_archived            BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at            TIMESTAMPTZ,
  archived_by            UUID REFERENCES users(user_id) ON DELETE SET NULL,
  declined_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT users_duplicate_email_key UNIQUE(email)
);

-- School years (school-year scoping; from school_years_migration.sql)
CREATE TABLE school_years (
  school_year_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school               public.school NOT NULL,
  school_id            UUID NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  label                VARCHAR(9) NOT NULL,
  start_date           DATE NOT NULL,
  end_date             DATE NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT false,
  created_from_year_id UUID REFERENCES school_years(school_year_id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_id, label)
);

CREATE UNIQUE INDEX school_years_one_active_per_school
  ON school_years (school_id) WHERE is_active;

-- Mirrors the production backfill in school_years_migration.sql: every
-- registered school gets an active "2025-2026" year automatically. The
-- resolveSchoolYear middleware (mounted globally) 400s writes for a school
-- with no active year, and integration tests insert schools directly via
-- SQL (bypassing any signup flow), so without this trigger every existing
-- write-path integration test would need its own school_years seeding.
CREATE OR REPLACE FUNCTION seed_default_school_year() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
  VALUES (
    NEW.school_code,
    NEW.school_id,
    '2025-2026',
    COALESCE(NEW.academic_year_start_date, DATE '2025-09-01'),
    COALESCE(NEW.academic_year_end_date, DATE '2026-06-30'),
    TRUE
  )
  ON CONFLICT (school_id, label) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_seed_default_school_year
  AFTER INSERT ON schools
  FOR EACH ROW EXECUTE FUNCTION seed_default_school_year();

CREATE TABLE terms (
  term_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 school NOT NULL,
  school_id              UUID REFERENCES schools(school_id),
  name                   TEXT NOT NULL,
  start_date             DATE NOT NULL,
  end_date               DATE NOT NULL,
  academic_year          TEXT,
  is_active              BOOLEAN DEFAULT FALSE,
  school_year_id         UUID REFERENCES school_years(school_year_id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Tier 1: Tables referencing foundation ───────────────────

-- ─── Registration forms (registration_forms_migration.sql,
--     registration_statuses_migration.sql) ─────────────────────
-- Declared before `students` because students.source_submission_id
-- references registration_form_submissions (registration_import_migration.sql).

CREATE TABLE registration_statuses (
  status_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school      school NOT NULL,
  key         VARCHAR(40) NOT NULL,
  label       VARCHAR(60) NOT NULL,
  color       VARCHAR(20) NOT NULL DEFAULT 'slate',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_builtin  BOOLEAN NOT NULL DEFAULT false,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school, key)
);

CREATE INDEX idx_registration_statuses_school
  ON registration_statuses (school, sort_order);
CREATE UNIQUE INDEX idx_registration_statuses_one_default
  ON registration_statuses (school) WHERE is_default;

CREATE TABLE registration_forms (
  form_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school            school NOT NULL,
  title             VARCHAR(255) NOT NULL,
  slug              VARCHAR(255) NOT NULL,
  description       TEXT,
  banner_image_path TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'published', 'closed')),
  created_by        UUID NOT NULL REFERENCES users(user_id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at      TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  UNIQUE(school, slug)
);

CREATE INDEX idx_registration_forms_school ON registration_forms(school);
CREATE INDEX idx_registration_forms_school_slug ON registration_forms(school, slug);
CREATE INDEX idx_registration_forms_status ON registration_forms(status);

CREATE TABLE registration_form_fields (
  field_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id           UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  field_type        VARCHAR(20) NOT NULL
                      CHECK (field_type IN ('text', 'email', 'phone', 'date', 'select', 'radio', 'textarea')),
  label             VARCHAR(255) NOT NULL,
  placeholder       VARCHAR(255),
  is_required       BOOLEAN NOT NULL DEFAULT false,
  options           JSONB,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_registration_form_fields_form_id ON registration_form_fields(form_id);
CREATE INDEX idx_registration_form_fields_sort_order ON registration_form_fields(form_id, sort_order);

-- Status is a composite FK to registration_statuses (school, key) rather than
-- a CHECK constraint (registration_statuses_migration.sql). The imported_*
-- columns are added after `students` exists, below.
CREATE TABLE registration_form_submissions (
  submission_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id           UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  school            school NOT NULL,
  answers           JSONB NOT NULL,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address        INET,
  status            VARCHAR(20) NOT NULL DEFAULT 'new',
  CONSTRAINT registration_form_submissions_status_fkey
    FOREIGN KEY (school, status)
    REFERENCES registration_statuses (school, key)
    ON UPDATE CASCADE
);

CREATE INDEX idx_submissions_form_id ON registration_form_submissions(form_id);
CREATE INDEX idx_submissions_school ON registration_form_submissions(school);
CREATE INDEX idx_submissions_submitted_at ON registration_form_submissions(submitted_at);
CREATE INDEX idx_submissions_status ON registration_form_submissions(status);
CREATE INDEX idx_submissions_form_status ON registration_form_submissions(form_id, status);

CREATE TABLE students (
  student_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  school                 school NOT NULL,
  homeroom_teacher_id    UUID REFERENCES users(user_id),
  grade                  TEXT NOT NULL,
  oen                    TEXT,
  mother_name            TEXT,
  mother_email           TEXT,
  mother_number          TEXT,
  father_name            TEXT,
  father_email           TEXT,
  father_number          TEXT,
  emergency_contact      TEXT,
  -- registration_import_migration.sql: profile fields + import back-link
  date_of_birth          DATE,
  medical_notes          TEXT,
  address                TEXT,
  health_card_number     TEXT,
  source_submission_id   UUID REFERENCES registration_form_submissions(submission_id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW(),
  is_archived            BOOLEAN DEFAULT FALSE,
  archived_at            TIMESTAMPTZ,
  archived_by            UUID REFERENCES users(user_id),
  school_year_id         UUID REFERENCES school_years(school_year_id),
  previous_student_id    UUID REFERENCES students(student_id)
);

CREATE INDEX idx_students_source_submission
  ON students (source_submission_id)
  WHERE source_submission_id IS NOT NULL;

-- registration_import_migration.sql: forward import tracking + field mappings
ALTER TABLE registration_form_submissions
  ADD COLUMN imported_student_id UUID REFERENCES students(student_id) ON DELETE SET NULL,
  ADD COLUMN imported_at TIMESTAMPTZ,
  ADD COLUMN imported_by UUID REFERENCES users(user_id) ON DELETE SET NULL;

CREATE INDEX idx_submissions_imported_student
  ON registration_form_submissions (imported_student_id)
  WHERE imported_student_id IS NOT NULL;
CREATE INDEX idx_submissions_form_not_imported
  ON registration_form_submissions (form_id)
  WHERE imported_student_id IS NULL;

CREATE TABLE registration_field_mappings (
  mapping_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id      UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  field_id     UUID NOT NULL REFERENCES registration_form_fields(field_id) ON DELETE CASCADE,
  target_field VARCHAR(40) NOT NULL CHECK (target_field IN (
    'name', 'grade', 'oen', 'dateOfBirth', 'medicalNotes', 'address',
    'healthCardNumber', 'emergencyContact',
    'motherName', 'motherEmail', 'motherPhone',
    'fatherName', 'fatherEmail', 'fatherPhone'
  )),
  value_map    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (form_id, field_id),
  UNIQUE (form_id, target_field)
);

CREATE INDEX idx_field_mappings_form ON registration_field_mappings (form_id);

CREATE TABLE password_reset_tokens (
  token                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE classes (
  class_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 school NOT NULL,
  grade                  TEXT NOT NULL,
  subject                TEXT NOT NULL,
  teacher_name           TEXT NOT NULL,
  teacher_id             UUID NOT NULL REFERENCES users(user_id),
  term_id                UUID REFERENCES terms(term_id),
  term_name              TEXT,
  school_year_id         UUID REFERENCES school_years(school_year_id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE school_assets (
  school_id              UUID PRIMARY KEY REFERENCES schools(school_id) ON DELETE CASCADE,
  school_code            school NOT NULL,
  logo_path              TEXT,
  principal_signature_path TEXT,
  school_stamp_path      TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE staff (
  staff_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 school NOT NULL,
  full_name              TEXT NOT NULL,
  staff_role             TEXT NOT NULL,
  teaching_assignments   TEXT,
  homeroom_grade         TEXT,
  email                  TEXT,
  phone                  TEXT,
  preferred_contact      TEXT,
  phone_contact_hours    TEXT,
  email_contact_hours    TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE patch_notes (
  patch_note_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL,
  version                TEXT,
  category               TEXT,
  target_roles           TEXT[] NOT NULL,
  image_url              TEXT,
  published_at           TIMESTAMPTZ NOT NULL,
  auto_dismiss_at        TIMESTAMPTZ,
  created_by             UUID REFERENCES users(user_id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Tier 2: Tables referencing Tier 1 ──────────────────────

CREATE TABLE class_students (
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (class_id, student_id)
);

CREATE TABLE class_teachers (
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  teacher_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (class_id, teacher_id)
);

CREATE TABLE assessments (
  assessment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  weight_percent         NUMERIC(5, 2),
  weight_points          NUMERIC(10, 2),
  parent_assessment_id   UUID REFERENCES assessments(assessment_id) ON DELETE CASCADE,
  is_parent              BOOLEAN DEFAULT FALSE,
  sort_order             INT DEFAULT 0,
  max_score              NUMERIC(10, 2),
  date                   DATE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE student_assessments (
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  assessment_id          UUID NOT NULL REFERENCES assessments(assessment_id) ON DELETE CASCADE,
  score                  NUMERIC(10, 2),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (student_id, assessment_id)
);

CREATE TABLE student_excluded_assessments (
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  assessment_id          UUID NOT NULL REFERENCES assessments(assessment_id) ON DELETE CASCADE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (student_id, class_id, assessment_id)
);

CREATE TABLE general_attendance (
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  attendance_date        DATE NOT NULL,
  status                 attendance_status,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (student_id, attendance_date)
);

CREATE TABLE class_attendance (
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  attendance_date        DATE NOT NULL,
  status                 attendance_status,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (class_id, student_id, attendance_date)
);

CREATE TABLE teacher_attendance (
  teacher_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  attendance_date        DATE NOT NULL,
  status                 TEXT,
  school                 school NOT NULL,
  notes                  TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (teacher_id, attendance_date)
);

CREATE TABLE parent_students (
  parent_student_link_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  parent_id              UUID REFERENCES users(user_id) ON DELETE SET NULL,
  parent_name            TEXT,
  parent_email           TEXT,
  parent_number          TEXT,
  relation               TEXT,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE report_cards (
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  student_name           TEXT,
  grade                  TEXT,
  file_path              TEXT,
  generated_at           TIMESTAMPTZ DEFAULT NOW(),
  school                 school NOT NULL,
  email_sent             BOOLEAN DEFAULT FALSE,
  email_sent_at          TIMESTAMPTZ,
  email_sent_by          UUID REFERENCES users(user_id),
  PRIMARY KEY (student_id, term)
);

CREATE TABLE report_card_feedback (
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  work_habits            TEXT,
  behavior               TEXT,
  comment                TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (student_id, class_id, term)
);

CREATE TABLE progress_reports (
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  student_name           TEXT,
  grade                  TEXT,
  file_path              TEXT,
  generated_at           TIMESTAMPTZ DEFAULT NOW(),
  school                 school NOT NULL,
  email_sent             BOOLEAN DEFAULT FALSE,
  email_sent_at          TIMESTAMPTZ,
  email_sent_by          UUID REFERENCES users(user_id),
  PRIMARY KEY (student_id, term)
);

CREATE TABLE progress_report_feedback (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  class_id               UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  core_standards         TEXT,
  work_habit             TEXT,
  behavior               TEXT,
  comment                TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, class_id, term)
);

CREATE TABLE report_emails (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type            TEXT NOT NULL,
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  sent_by                UUID REFERENCES users(user_id),
  email_addresses        TEXT[],
  custom_header          TEXT,
  custom_message         TEXT,
  file_path              TEXT,
  sent_at                TIMESTAMPTZ DEFAULT NOW(),
  cc_addresses           TEXT[],
  school                 school NOT NULL
);

CREATE TABLE patch_note_dismissals (
  user_id                UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  last_seen_patch_note_id UUID REFERENCES patch_notes(patch_note_id),
  dismissed_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ─── JK Tables (Junior Kindergarten) ─────────────────────────

CREATE TABLE jk_skill_domains (
  domain_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type          TEXT NOT NULL CHECK (document_type IN ('progress_report', 'report_card')),
  name                   TEXT NOT NULL,
  sort_order             INT DEFAULT 0,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_type, name, school)
);

CREATE TABLE jk_skills (
  skill_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id              UUID NOT NULL REFERENCES jk_skill_domains(domain_id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  description            TEXT,
  sort_order             INT DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain_id, name)
);

CREATE TABLE jk_skill_assessments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  skill_id               UUID NOT NULL REFERENCES jk_skills(skill_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  rating                 TEXT,
  school                 school NOT NULL,
  assessed_by            UUID REFERENCES users(user_id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, skill_id, term)
);

CREATE TABLE jk_learning_skills (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  skill_name             TEXT NOT NULL,
  rating                 TEXT CHECK (rating IN ('E', 'G', 'S', 'N')),
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term, skill_name)
);

CREATE TABLE jk_domain_comments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  domain_id              UUID NOT NULL REFERENCES jk_skill_domains(domain_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  comment                TEXT,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, domain_id, term)
);

CREATE TABLE jk_teacher_assistants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  teacher_assistant_name TEXT,
  term                   TEXT NOT NULL,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term)
);

CREATE TABLE jk_progress_report_comments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  section_type           TEXT NOT NULL CHECK (section_type IN ('academic_achievement', 'socio_emotional')),
  comment                TEXT,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term, section_type)
);

-- ─── SK Tables (Senior Kindergarten) ─────────────────────────

CREATE TABLE sk_subjects (
  subject_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type          TEXT NOT NULL CHECK (document_type IN ('progress_report', 'report_card')),
  name                   TEXT NOT NULL,
  sort_order             INT NOT NULL DEFAULT 0,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_type, name, school)
);

CREATE TABLE sk_standards (
  standard_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id             UUID NOT NULL REFERENCES sk_subjects(subject_id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  description            TEXT,
  sort_order             INT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(subject_id, name)
);

CREATE TABLE sk_standard_assessments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  standard_id            UUID NOT NULL REFERENCES sk_standards(standard_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  rating                 TEXT,
  school                 school NOT NULL,
  assessed_by            UUID REFERENCES users(user_id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, standard_id, term)
);

CREATE TABLE sk_subject_comments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  subject_id             UUID NOT NULL REFERENCES sk_subjects(subject_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  comment                TEXT,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, subject_id, term)
);

CREATE TABLE sk_teacher_assistants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  teacher_assistant_name TEXT,
  term                   TEXT NOT NULL,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term)
);

CREATE TABLE sk_progress_report_comments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  section_type           TEXT NOT NULL,
  comment                TEXT,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term, section_type)
);

-- ─── Indexes ─────────────────────────────────────────────────

CREATE INDEX idx_classes_school ON classes(school);
CREATE INDEX idx_classes_teacher_id ON classes(teacher_id);
CREATE INDEX idx_students_school ON students(school);
CREATE INDEX idx_assessments_class_id ON assessments(class_id);
CREATE INDEX idx_student_assessments_student ON student_assessments(student_id);
CREATE INDEX idx_parent_students_student ON parent_students(student_id);
CREATE INDEX idx_parent_students_parent ON parent_students(parent_id);
CREATE INDEX idx_terms_school ON terms(school);
CREATE INDEX idx_jk_skill_assessments_student_term ON jk_skill_assessments(student_id, term);
CREATE INDEX idx_jk_learning_skills_student_term ON jk_learning_skills(student_id, term);
CREATE INDEX idx_jk_domain_comments_student_term ON jk_domain_comments(student_id, term);
CREATE INDEX idx_jk_skills_domain ON jk_skills(domain_id);
CREATE INDEX idx_jk_progress_report_comments_student_term ON jk_progress_report_comments(student_id, term);
CREATE INDEX idx_sk_standard_assessments_student_term ON sk_standard_assessments(student_id, term);
CREATE INDEX idx_sk_subject_comments_student_term ON sk_subject_comments(student_id, term);
CREATE INDEX idx_sk_standards_subject ON sk_standards(subject_id);
CREATE INDEX idx_sk_progress_report_comments_student_term ON sk_progress_report_comments(student_id, term);
CREATE INDEX idx_class_teachers_teacher_id ON class_teachers(teacher_id);
-- School Calendar Feature Migration
-- Run this migration against your Supabase PostgreSQL database

CREATE TABLE IF NOT EXISTS school_calendar_events (
  event_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           public.school NOT NULL,
  school_id        UUID REFERENCES schools(school_id),
  title            VARCHAR(255) NOT NULL,
  category         VARCHAR(20) NOT NULL DEFAULT 'event'
                     CHECK (category IN ('event', 'holiday', 'pa-day', 'exam', 'other')),
  start_date       DATE NOT NULL,
  end_date         DATE,
  is_school_closed BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT,
  school_year_id   UUID REFERENCES school_years(school_year_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT end_date_after_start CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_school_date
  ON school_calendar_events(school, start_date);
-- Agenda Editor Feature Migration
-- Run this migration against your Supabase PostgreSQL database
-- Requires: school_calendar_migration.sql (Days to Remember pull from school_calendar_events)
-- Also create a private storage bucket named 'agendas' in Supabase.

CREATE TABLE IF NOT EXISTS agendas (
  agenda_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school               public.school NOT NULL,
  school_id            UUID REFERENCES schools(school_id),
  academic_year        VARCHAR(9) NOT NULL,
  title                VARCHAR(255) NOT NULL DEFAULT 'Student Agenda',
  start_month          SMALLINT NOT NULL DEFAULT 9 CHECK (start_month BETWEEN 1 AND 12),
  end_month            SMALLINT NOT NULL DEFAULT 6 CHECK (end_month BETWEEN 1 AND 12),
  footer_text          TEXT,
  include_notes_page   BOOLEAN NOT NULL DEFAULT true,
  evaluation_subjects  JSONB NOT NULL DEFAULT '[]'::jsonb,
  status               VARCHAR(20) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'generating', 'generated', 'failed')),
  generated_file_path  TEXT,
  generated_page_count INTEGER,
  generated_at         TIMESTAMPTZ,
  generation_error     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, academic_year)
);

CREATE INDEX IF NOT EXISTS idx_agendas_school ON agendas(school);

CREATE TABLE IF NOT EXISTS agenda_months (
  agenda_month_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_id       UUID NOT NULL REFERENCES agendas(agenda_id) ON DELETE CASCADE,
  month           SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  quotes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agenda_id, month)
);

CREATE TABLE IF NOT EXISTS agenda_custom_pages (
  page_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agenda_id    UUID NOT NULL REFERENCES agendas(agenda_id) ON DELETE CASCADE,
  anchor       VARCHAR(10) NOT NULL CHECK (anchor IN ('intro', 'month', 'closing')),
  anchor_month SMALLINT CHECK (anchor_month BETWEEN 1 AND 12),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  title        VARCHAR(255),
  file_path    TEXT NOT NULL,
  file_type    VARCHAR(10) NOT NULL CHECK (file_type IN ('pdf', 'image')),
  mime_type    VARCHAR(100),
  page_count   INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT anchor_month_required CHECK (anchor <> 'month' OR anchor_month IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_agenda_custom_pages_agenda
  ON agenda_custom_pages(agenda_id, anchor, anchor_month, sort_order);

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS fit_mode VARCHAR(10) NOT NULL DEFAULT 'contain'
  CHECK (fit_mode IN ('contain', 'cover'));

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS zoom NUMERIC(5,3) NOT NULL DEFAULT 1
  CHECK (zoom >= 0.2 AND zoom <= 4);
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS offset_x NUMERIC(6,4) NOT NULL DEFAULT 0
  CHECK (offset_x >= -1 AND offset_x <= 1);
ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS offset_y NUMERIC(6,4) NOT NULL DEFAULT 0
  CHECK (offset_y >= -1 AND offset_y <= 1);

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS zoom_y NUMERIC(5,3)
  CHECK (zoom_y IS NULL OR (zoom_y >= 0.2 AND zoom_y <= 4));

ALTER TABLE agendas
  ADD COLUMN IF NOT EXISTS theme JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ─── Schedule Planner (from schedule_planner_migration.sql) ─────────

-- Per-school planner defaults (one row per school)
CREATE TABLE IF NOT EXISTS planner_settings (
  planner_settings_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                   school NOT NULL,
  school_id                UUID REFERENCES schools(school_id),
  default_duration_minutes SMALLINT NOT NULL DEFAULT 40 CHECK (default_duration_minutes BETWEEN 5 AND 480),
  snap_minutes             SMALLINT NOT NULL DEFAULT 5 CHECK (snap_minutes IN (1, 5, 10, 15)),
  school_year_id           UUID REFERENCES school_years(school_year_id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT planner_settings_school_year_key UNIQUE (school, school_year_id)
);

-- Teacher profiles for the planner (user/staff links optional)
CREATE TABLE IF NOT EXISTS planner_teachers (
  planner_teacher_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school             school NOT NULL,
  school_id          UUID REFERENCES schools(school_id),
  user_id            UUID REFERENCES users(user_id) ON DELETE SET NULL,
  staff_id           UUID REFERENCES staff(staff_id) ON DELETE SET NULL,
  display_name       VARCHAR(255) NOT NULL,
  is_full_time       BOOLEAN NOT NULL DEFAULT true,
  max_weekly_minutes INTEGER CHECK (max_weekly_minutes IS NULL OR max_weekly_minutes > 0),
  daily_spare_minutes SMALLINT CHECK (daily_spare_minutes IS NULL OR daily_spare_minutes > 0),
  allowed_days       JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  excluded_windows   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes              TEXT,
  school_year_id     UUID REFERENCES school_years(school_year_id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, school_year_id, display_name)
);
CREATE INDEX IF NOT EXISTS idx_planner_teachers_school ON planner_teachers(school);
CREATE INDEX IF NOT EXISTS idx_planner_teachers_user ON planner_teachers(user_id);

-- Shared rooms (gym, lab, prayer hall)
CREATE TABLE IF NOT EXISTS planner_rooms (
  room_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school        school NOT NULL,
  school_id     UUID REFERENCES schools(school_id),
  name          VARCHAR(255) NOT NULL,
  capacity_note VARCHAR(255),
  school_year_id UUID REFERENCES school_years(school_year_id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, school_year_id, name)
);
CREATE INDEX IF NOT EXISTS idx_planner_rooms_school ON planner_rooms(school);

-- Homeroom cohorts being scheduled (planner-owned, not the classes table)
CREATE TABLE IF NOT EXISTS planner_class_groups (
  class_group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         school NOT NULL,
  school_id      UUID REFERENCES schools(school_id),
  name           VARCHAR(255) NOT NULL,
  grade          VARCHAR(20),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  school_year_id UUID REFERENCES school_years(school_year_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, school_year_id, name)
);
CREATE INDEX IF NOT EXISTS idx_planner_class_groups_school ON planner_class_groups(school);

-- Course requirements per class group
CREATE TABLE IF NOT EXISTS planner_courses (
  course_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                school NOT NULL,
  school_id             UUID REFERENCES schools(school_id),
  class_group_id        UUID NOT NULL REFERENCES planner_class_groups(class_group_id) ON DELETE CASCADE,
  name                  VARCHAR(255) NOT NULL,
  sessions_per_week     SMALLINT NOT NULL CHECK (sessions_per_week BETWEEN 1 AND 20),
  duration_minutes      SMALLINT CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 5 AND 480),
  max_per_day           SMALLINT NOT NULL DEFAULT 1 CHECK (max_per_day BETWEEN 1 AND 20),
  assigned_teacher_id   UUID REFERENCES planner_teachers(planner_teacher_id) ON DELETE SET NULL,
  candidate_teacher_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_room_id      UUID REFERENCES planner_rooms(room_id) ON DELETE SET NULL,
  school_year_id        UUID REFERENCES school_years(school_year_id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_courses_group ON planner_courses(class_group_id);
CREATE INDEX IF NOT EXISTS idx_planner_courses_school ON planner_courses(school);

-- Per-day fillable time ranges (minutes from midnight, ISO weekday 1=Mon)
CREATE TABLE IF NOT EXISTS planner_day_templates (
  day_template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  school_id       UUID REFERENCES schools(school_id),
  day_of_week     SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  fillable_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
  school_year_id  UUID REFERENCES school_years(school_year_id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, school_year_id, day_of_week)
);

-- Fixed blocks (lunch, prayer, recess); empty class_group_ids = school-wide,
-- otherwise a JSONB array of the class_group_ids it applies to
CREATE TABLE IF NOT EXISTS planner_fixed_blocks (
  fixed_block_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  school_id       UUID REFERENCES schools(school_id),
  class_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  label          VARCHAR(255) NOT NULL,
  day_of_week    SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min      SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min        SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  school_year_id UUID REFERENCES school_years(school_year_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_fixed_blocks_school ON planner_fixed_blocks(school, day_of_week);

-- Named schedule drafts + the one published schedule per school.
-- sessions: [{courseId, courseName, classGroupId, teacherId, roomId,
--             day, startMin, endMin, pinned}]
CREATE TABLE IF NOT EXISTS planner_schedules (
  schedule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  school_id       UUID REFERENCES schools(school_id),
  name            VARCHAR(255) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  sessions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  diagnostics     JSONB,
  config_snapshot JSONB,
  share_token     UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  published_at    TIMESTAMPTZ,
  school_year_id  UUID REFERENCES school_years(school_year_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_schedules_school ON planner_schedules(school);
-- One published schedule per (school, year), not per school, so publishing
-- in a new year doesn't collide with an older year's published schedule.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_planner_published_per_school_year
  ON planner_schedules(school, school_year_id) WHERE status = 'published';

-- Materialized on publish so the teacher widget and public page hit
-- indexed rows instead of scanning JSONB
CREATE TABLE IF NOT EXISTS planner_schedule_sessions (
  session_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        UUID NOT NULL REFERENCES planner_schedules(schedule_id) ON DELETE CASCADE,
  school             school NOT NULL,
  school_id          UUID REFERENCES schools(school_id),
  class_group_id     UUID REFERENCES planner_class_groups(class_group_id) ON DELETE SET NULL,
  class_group_name   VARCHAR(255) NOT NULL,
  course_name        VARCHAR(255) NOT NULL,
  planner_teacher_id UUID REFERENCES planner_teachers(planner_teacher_id) ON DELETE SET NULL,
  teacher_user_id    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  teacher_name       VARCHAR(255) NOT NULL,
  room_name          VARCHAR(255),
  day_of_week        SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min          SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min            SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  school_year_id     UUID REFERENCES school_years(school_year_id)
);
CREATE INDEX IF NOT EXISTS idx_pss_schedule ON planner_schedule_sessions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_pss_teacher ON planner_schedule_sessions(teacher_user_id, day_of_week);

-- ─── Schedule Planner v3 (from schedule_planner_v3_migration.sql) ───────

ALTER TABLE planner_teachers
  ADD COLUMN IF NOT EXISTS max_days_per_week SMALLINT
  CHECK (max_days_per_week IS NULL OR max_days_per_week BETWEEN 1 AND 7);

-- ─── Schedule Planner v4 (from schedule_planner_v4_migration.sql) ───────

ALTER TABLE planner_teachers
  ADD COLUMN IF NOT EXISTS max_spares_per_day SMALLINT
  CHECK (max_spares_per_day IS NULL OR max_spares_per_day >= 0),
  ADD COLUMN IF NOT EXISTS avoid_adjacent_spares BOOLEAN;

-- ─── Schedule Planner v5 (from schedule_planner_v5_migration.sql) ───────

ALTER TABLE planner_courses
  ADD COLUMN IF NOT EXISTS max_repeat_days SMALLINT
  CHECK (max_repeat_days IS NULL OR max_repeat_days >= 0);

CREATE TABLE IF NOT EXISTS planner_period_rules (
  rule_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         school NOT NULL,
  school_id      UUID REFERENCES schools(school_id),
  school_year_id UUID REFERENCES school_years(school_year_id),
  teacher_id     UUID NOT NULL REFERENCES planner_teachers(planner_teacher_id) ON DELETE CASCADE,
  class_group_id UUID REFERENCES planner_class_groups(class_group_id) ON DELETE CASCADE,
  kind           VARCHAR(10) NOT NULL CHECK (kind IN ('teach', 'free')),
  start_min      SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min        SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  min_per_week   SMALLINT NOT NULL CHECK (min_per_week BETWEEN 1 AND 7),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teach_rules_need_class CHECK (kind != 'teach' OR class_group_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_planner_period_rules_school
  ON planner_period_rules(school, school_year_id);

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS show_page_number BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS stamp_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS page_from INTEGER NOT NULL DEFAULT 0
  CHECK (page_from >= 0);

ALTER TABLE agenda_custom_pages
  ADD COLUMN IF NOT EXISTS excluded_pages JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ─── Schedule Planner v6 (from schedule_planner_v6_migration.sql) ───────

CREATE TABLE IF NOT EXISTS planner_schedule_fixed_blocks (
  snapshot_block_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        UUID NOT NULL REFERENCES planner_schedules(schedule_id) ON DELETE CASCADE,
  school             school NOT NULL,
  school_id          UUID REFERENCES schools(school_id),
  class_group_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  label              VARCHAR(255) NOT NULL,
  day_of_week        SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min          SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min            SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  school_year_id     UUID REFERENCES school_years(school_year_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_psfb_schedule ON planner_schedule_fixed_blocks(schedule_id);

-- ─── Assessment Publishing (from assessment_publish_migration.sql) ─────

ALTER TABLE assessments ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(user_id);
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS publication_batch_id UUID;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS parent_comment TEXT;
CREATE INDEX IF NOT EXISTS idx_assessments_class_published ON assessments(class_id, is_published);

CREATE TABLE IF NOT EXISTS assessment_publication_batches (
  batch_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id              UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  school                school NOT NULL,
  action                VARCHAR(10) NOT NULL CHECK (action IN ('publish', 'unpublish')),
  assessment_ids        UUID[] NOT NULL,
  batch_comment         TEXT,
  triggered_by          UUID REFERENCES users(user_id),
  student_warning_count INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_publication_batches_class
  ON assessment_publication_batches(class_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assessment_publication_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES assessment_publication_batches(batch_id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  sent_by         UUID REFERENCES users(user_id),
  email_addresses JSONB NOT NULL,
  assessment_ids  UUID[] NOT NULL,
  school          school NOT NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message   TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assessment_publication_emails_batch
  ON assessment_publication_emails(batch_id);

CREATE TABLE IF NOT EXISTS ai_weekly_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  week_start   DATE NOT NULL,
  content      TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, week_start)
);

ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Mirrors staff_work_schedules_migration.sql + staff_pay_schedules_migration.sql
CREATE TABLE IF NOT EXISTS staff_work_schedules (
  user_id       UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  school        school NOT NULL,
  work_days     SMALLINT[] CHECK (
    work_days IS NULL OR (cardinality(work_days) > 0 AND work_days <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[])
  ),
  hours_per_day NUMERIC(4,2) CHECK (hours_per_day > 0 AND hours_per_day <= 24),
  updated_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_work_schedules_not_empty CHECK (work_days IS NOT NULL OR hours_per_day IS NOT NULL)
);

-- Mirrors staff_pay_schedules_migration.sql
CREATE TABLE IF NOT EXISTS staff_pay_schedules (
  school                   school PRIMARY KEY,
  frequency                TEXT NOT NULL CHECK (frequency IN ('MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'WEEKLY')),
  pay_day_of_month         SMALLINT CHECK (pay_day_of_month BETWEEN 1 AND 31),
  second_pay_day_of_month  SMALLINT CHECK (second_pay_day_of_month BETWEEN 1 AND 31),
  anchor_pay_date          DATE,
  default_hours_per_day    NUMERIC(4,2) NOT NULL DEFAULT 7.5 CHECK (default_hours_per_day > 0 AND default_hours_per_day <= 24),
  work_day_start           TIME,
  updated_by               UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT staff_pay_schedules_shape CHECK (
    (frequency = 'MONTHLY'      AND pay_day_of_month IS NOT NULL) OR
    (frequency = 'SEMI_MONTHLY' AND pay_day_of_month IS NOT NULL AND second_pay_day_of_month IS NOT NULL
                                AND second_pay_day_of_month <> pay_day_of_month) OR
    (frequency IN ('BIWEEKLY', 'WEEKLY') AND anchor_pay_date IS NOT NULL)
  )
);

ALTER TABLE teacher_attendance
  ADD COLUMN IF NOT EXISTS hours NUMERIC(4,2) CHECK (hours >= 0 AND hours <= 24);

-- ─── Finance / QuickBooks (from finance_qbo_migration.sql) ─────────────


-- ─── Connection: one QBO company (realm) per school, one school per realm ───
CREATE TABLE IF NOT EXISTS finance_qbo_connections (
  connection_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                  school NOT NULL UNIQUE,
  realm_id                TEXT NOT NULL UNIQUE CHECK (realm_id ~ '^[0-9]+$'),
  company_name            TEXT,
  -- AES-256-GCM under QBO_TOKEN_ENC_KEY. Never logged, never returned by the API.
  refresh_token           TEXT,
  refresh_token_version   INTEGER NOT NULL DEFAULT 0,
  access_token            TEXT,
  access_token_expires_at TIMESTAMPTZ,
  status                  VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','needs_reconnect','disconnected')),
  -- Per-school knobs: QBO item ids, backfill start, subsidy note prefixes, grant label.
  settings                JSONB NOT NULL DEFAULT '{}'::jsonb,
  cdc_cursor              TIMESTAMPTZ,
  backfill_completed_at   TIMESTAMPTZ,
  last_success_at         TIMESTAMPTZ,
  last_error              TEXT,
  consecutive_failures    INTEGER NOT NULL DEFAULT 0,
  alerted_at              TIMESTAMPTZ,
  connected_by            UUID REFERENCES users(user_id) ON DELETE SET NULL,
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school, realm_id)
);

-- ─── Families (SchoolMule side, per school year) ───
CREATE TABLE IF NOT EXISTS families (
  family_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                   school NOT NULL,
  school_year_id           UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  is_subsidy               BOOLEAN NOT NULL DEFAULT false,
  is_teacher               BOOLEAN NOT NULL DEFAULT false,
  expected_monthly_parent  NUMERIC(12,2),
  expected_monthly_subsidy NUMERIC(12,2),
  notes                    TEXT,
  roster_family_no         INTEGER,
  created_by               UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school, family_id)                          -- target of the school-carrying FK below
);
CREATE INDEX IF NOT EXISTS idx_families_year ON families (school, school_year_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_families_roster_no
  ON families (school, school_year_id, roster_family_no) WHERE roster_family_no IS NOT NULL;

-- Which QBO customer bills the family, with date ranges so a mid-year switch
-- keeps old invoices attached and a re-used customer is never double counted.
CREATE TABLE IF NOT EXISTS family_customer_links (
  link_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL,
  family_id        UUID NOT NULL,
  -- Denormalized from the family: families are per year, so "one open link per
  -- customer" must be per year too, or last year's links block this year's.
  school_year_id   UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  qbo_customer_id  TEXT NOT NULL CHECK (qbo_customer_id ~ '^[0-9]+$'),
  effective_from   DATE NOT NULL,
  effective_to     DATE,
  created_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A link can only point at a family of the same school.
  FOREIGN KEY (school, family_id) REFERENCES families(school, family_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcl_open_per_family
  ON family_customer_links (family_id) WHERE effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fcl_open_per_customer
  ON family_customer_links (school, school_year_id, qbo_customer_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_fcl_customer ON family_customer_links (school, qbo_customer_id);

-- Students are per-year rows, so UNIQUE(student_id) = one family per student per year.
CREATE TABLE IF NOT EXISTS family_students (
  family_id   UUID NOT NULL REFERENCES families(family_id) ON DELETE CASCADE,
  student_id  UUID NOT NULL UNIQUE REFERENCES students(student_id) ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, student_id)
);

-- A student can only join a family of its own school and school year. The
-- insert SQL enforces this too; the trigger is defense in depth for the
-- seeder and rollover paths that write SQL directly.
CREATE OR REPLACE FUNCTION trg_family_students_same_year_fn() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM students s JOIN families f ON f.family_id = NEW.family_id
    WHERE s.student_id = NEW.student_id
      AND s.school = f.school AND s.school_year_id = f.school_year_id
  ) THEN
    RAISE EXCEPTION 'student % is not in the same school and school year as family %', NEW.student_id, NEW.family_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_family_students_same_year ON family_students;
CREATE TRIGGER trg_family_students_same_year
  BEFORE INSERT OR UPDATE ON family_students
  FOR EACH ROW EXECUTE FUNCTION trg_family_students_same_year_fn();

CREATE TABLE IF NOT EXISTS family_contacts (
  contact_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID NOT NULL REFERENCES families(family_id) ON DELETE CASCADE,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  relation    VARCHAR(20) CHECK (relation IS NULL OR relation IN ('mother','father','guardian','other')),
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  user_id     UUID REFERENCES users(user_id) ON DELETE SET NULL,
  source      VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('roster','student_record','manual')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (name IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_contacts_email   ON family_contacts (family_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_family_contacts_primary ON family_contacts (family_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_family_contacts_email ON family_contacts (lower(email));
CREATE INDEX IF NOT EXISTS idx_family_contacts_user  ON family_contacts (user_id) WHERE user_id IS NOT NULL;

-- Append-only history of link/contact changes. No FK on family_id so it survives deletion.
CREATE TABLE IF NOT EXISTS family_link_audit (
  audit_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school              school NOT NULL,
  school_year_id      UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  family_id           UUID,
  family_name         TEXT NOT NULL,
  action              VARCHAR(30) NOT NULL CHECK (action IN (
                        'family_create','family_update','family_delete',
                        'customer_link','customer_unlink',
                        'student_add','student_remove',
                        'contact_add','contact_update','contact_remove',
                        'invoice_kind_override','seed')),
  old_qbo_customer_id TEXT,
  new_qbo_customer_id TEXT,
  student_id          UUID,
  invoice_qbo_id      TEXT,
  details             JSONB,
  actor_user_id       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_link_audit_family ON family_link_audit (school, family_id, created_at DESC);

-- ─── QBO cache (read-only mirror; latest raw payload kept on each row) ───
CREATE TABLE IF NOT EXISTS qbo_customers (
  school               school NOT NULL,
  realm_id             TEXT NOT NULL,
  qbo_id               TEXT NOT NULL CHECK (qbo_id ~ '^[0-9]+$'),
  display_name         TEXT NOT NULL,
  fully_qualified_name TEXT,
  parent_qbo_id        TEXT,
  is_sub_customer      BOOLEAN NOT NULL DEFAULT false,
  active               BOOLEAN NOT NULL DEFAULT true,
  balance              NUMERIC(12,2),               -- display only; NEVER used in math
  emails               TEXT[] NOT NULL DEFAULT '{}',
  phone                TEXT,
  sync_token           INTEGER,
  last_updated_time    TIMESTAMPTZ NOT NULL,
  deleted_at           TIMESTAMPTZ,
  raw                  JSONB NOT NULL,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school, qbo_id),
  FOREIGN KEY (school, realm_id) REFERENCES finance_qbo_connections(school, realm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qbo_customers_name   ON qbo_customers (school, lower(display_name));
CREATE INDEX IF NOT EXISTS idx_qbo_customers_emails ON qbo_customers USING GIN (emails);

CREATE TABLE IF NOT EXISTS qbo_invoices (
  school             school NOT NULL,
  realm_id           TEXT NOT NULL,
  qbo_id             TEXT NOT NULL CHECK (qbo_id ~ '^[0-9]+$'),
  doc_number         TEXT,
  customer_qbo_id    TEXT NOT NULL,
  txn_date           DATE NOT NULL,
  due_date           DATE,
  month_key          DATE GENERATED ALWAYS AS (make_date(extract(year from txn_date)::int, extract(month from txn_date)::int, 1)) STORED,
  total_amt          NUMERIC(12,2) NOT NULL,
  balance            NUMERIC(12,2) NOT NULL,
  email_status       VARCHAR(20),
  private_note       TEXT,
  customer_memo      TEXT,
  recurring_ref      TEXT,
  sync_token         INTEGER,
  last_updated_time  TIMESTAMPTZ NOT NULL,
  is_voided          BOOLEAN NOT NULL DEFAULT false,
  deleted_at         TIMESTAMPTZ,
  -- Classification: derived on every upsert; a manual override wins.
  kind_auto          VARCHAR(20) NOT NULL CHECK (kind_auto IN ('parent','subsidy_grant','subsidy_school','other')),
  kind_override      VARCHAR(20) CHECK (kind_override IN ('parent','subsidy_grant','subsidy_school','other')),
  kind               VARCHAR(20) GENERATED ALWAYS AS (COALESCE(kind_override, kind_auto)) STORED,
  override_by        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  override_at        TIMESTAMPTZ,
  raw                JSONB NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school, qbo_id),
  FOREIGN KEY (school, realm_id) REFERENCES finance_qbo_connections(school, realm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qbo_invoices_customer_month ON qbo_invoices (school, customer_qbo_id, month_key);
CREATE INDEX IF NOT EXISTS idx_qbo_invoices_month ON qbo_invoices (school, month_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_qbo_invoices_open  ON qbo_invoices (school, due_date) WHERE balance > 0 AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS qbo_invoice_lines (
  school          school NOT NULL,
  invoice_qbo_id  TEXT NOT NULL,
  line_num        INTEGER NOT NULL,
  line_id         TEXT,
  detail_type     TEXT,
  description     TEXT,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  item_ref        TEXT,
  item_name       TEXT,
  qty             NUMERIC(12,4),
  unit_price      NUMERIC(12,2),
  student_hint    TEXT,
  PRIMARY KEY (school, invoice_qbo_id, line_num),
  FOREIGN KEY (school, invoice_qbo_id) REFERENCES qbo_invoices(school, qbo_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS qbo_payments (
  school             school NOT NULL,
  realm_id           TEXT NOT NULL,
  qbo_id             TEXT NOT NULL CHECK (qbo_id ~ '^[0-9]+$'),
  customer_qbo_id    TEXT NOT NULL,
  txn_date           DATE NOT NULL,
  total_amt          NUMERIC(12,2) NOT NULL,
  unapplied_amt      NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method     TEXT,
  payment_ref_num    TEXT,
  private_note       TEXT,
  deposit_account    TEXT,
  sync_token         INTEGER,
  last_updated_time  TIMESTAMPTZ NOT NULL,
  deleted_at         TIMESTAMPTZ,
  raw                JSONB NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school, qbo_id),
  FOREIGN KEY (school, realm_id) REFERENCES finance_qbo_connections(school, realm_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qbo_payments_customer ON qbo_payments (school, customer_qbo_id, txn_date);

-- Payment.Line[].LinkedTxn where TxnType = 'Invoice'. Rebuilt per payment on
-- every upsert. No FK to qbo_invoices: the invoice may be outside the window.
CREATE TABLE IF NOT EXISTS qbo_payment_applications (
  school          school NOT NULL,
  payment_qbo_id  TEXT NOT NULL,
  invoice_qbo_id  TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  PRIMARY KEY (school, payment_qbo_id, invoice_qbo_id),
  FOREIGN KEY (school, payment_qbo_id) REFERENCES qbo_payments(school, qbo_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qpa_invoice ON qbo_payment_applications (school, invoice_qbo_id);

-- ─── Sync outbox + run log ───
CREATE TABLE IF NOT EXISTS finance_sync_jobs (
  job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  kind            VARCHAR(20) NOT NULL CHECK (kind IN ('backfill','cdc','manual')),
  state           VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  claimed_at      TIMESTAMPTZ,                    -- lease: a stale 'running' claim is reclaimed
  failed_at       TIMESTAMPTZ,                    -- when the job gave up; drives the retry cooldown
  requested_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live job per school regardless of kind, so a Sync-now during the
-- scheduled tick coalesces and a running backfill suppresses cdc enqueues.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_sync_jobs_live  ON finance_sync_jobs (school) WHERE state IN ('pending','running');
CREATE INDEX IF NOT EXISTS idx_finance_sync_jobs_ready ON finance_sync_jobs (next_attempt_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS finance_sync_runs (
  run_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school             school NOT NULL,
  job_id             UUID,
  kind               VARCHAR(20) NOT NULL CHECK (kind IN ('backfill','cdc','manual')),
  mode               VARCHAR(20) NOT NULL CHECK (mode IN ('full','cdc')),
  status             VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed')),
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ,
  cursor_from        TIMESTAMPTZ,
  cursor_to          TIMESTAMPTZ,
  customers_upserted INTEGER NOT NULL DEFAULT 0,
  invoices_upserted  INTEGER NOT NULL DEFAULT 0,
  payments_upserted  INTEGER NOT NULL DEFAULT 0,
  deleted_flagged    INTEGER NOT NULL DEFAULT 0,
  api_calls          INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  triggered_by       UUID REFERENCES users(user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_sync_runs_school ON finance_sync_runs (school, started_at DESC);



-- messaging_migration.sql: parent–teacher conversations + email outbox
--
--


CREATE TABLE IF NOT EXISTS conversations (
  conversation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL,
  student_id       UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  class_id         UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  assessment_id    UUID REFERENCES assessments(assessment_id) ON DELETE SET NULL,
  title            TEXT NOT NULL,                 -- snapshot of the assessment name
  status           VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by       UUID REFERENCES users(user_id),
  resolved_by      UUID REFERENCES users(user_id),
  resolved_at      TIMESTAMPTZ,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_anchor
  ON conversations(student_id, class_id, assessment_id) WHERE assessment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_class   ON conversations(class_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_student ON conversations(student_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_school  ON conversations(school, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  message_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  sender_role      VARCHAR(10) NOT NULL,          -- PARENT | TEACHER | ADMIN, snapshot
  kind             VARCHAR(10) NOT NULL DEFAULT 'message' CHECK (kind IN ('message','system')),
  body             TEXT NOT NULL,                 -- plain text; system lines are English text
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_attachments (
  attachment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  file_path        TEXT NOT NULL,                 -- <SCHOOL>/<conversation_id>/<message_id>/<uuid>.<ext>
  file_name        TEXT NOT NULL,                 -- original name, for display
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  last_read_at     TIMESTAMPTZ,
  last_emailed_at  TIMESTAMPTZ,
  muted            BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_email_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  school           school NOT NULL,
  send_after       TIMESTAMPTZ NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_email_jobs_pending
  ON message_email_jobs(conversation_id, recipient_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_message_email_jobs_due ON message_email_jobs(send_after) WHERE status = 'pending';


-- messaging_phase2_migration.sql: general conversations + guardian invites


ALTER TABLE conversations ALTER COLUMN class_id DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'assessment'
  CHECK (kind IN ('assessment','general'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_conversations_anchor') THEN
    ALTER TABLE conversations ADD CONSTRAINT chk_conversations_anchor
      CHECK (class_id IS NOT NULL OR teacher_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_teacher
  ON conversations(teacher_id, last_message_at DESC) WHERE teacher_id IS NOT NULL;

ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invite_reminded_at TIMESTAMPTZ;
ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invite_conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE SET NULL;



-- announcements_migration.sql: announcements, attachments, reads, email outbox


CREATE TABLE IF NOT EXISTS announcements (
  announcement_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL,
  school_year_id   UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  scope            VARCHAR(8) NOT NULL CHECK (scope IN ('class','grade','school')),
  class_id         UUID REFERENCES classes(class_id) ON DELETE CASCADE,
  grade            TEXT,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  author_id        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  author_role      VARCHAR(10) NOT NULL,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pinned_until     DATE,
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID REFERENCES users(user_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_announcements_scope CHECK (
    (scope = 'class'  AND class_id IS NOT NULL) OR
    (scope = 'grade'  AND grade IS NOT NULL) OR
    (scope = 'school'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_school_year ON announcements(school, school_year_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_class ON announcements(class_id) WHERE class_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS announcement_attachments (
  attachment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  file_path        TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_announcement_attachments_announcement ON announcement_attachments(announcement_id);

-- Per-user state only; a row's existence grants nothing.
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  read_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);

-- One row per (announcement, email). recipient_id is NULL for email-only guardians.
CREATE TABLE IF NOT EXISTS announcement_email_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  recipient_id     UUID REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_email  TEXT NOT NULL,
  kind             VARCHAR(8) NOT NULL CHECK (kind IN ('account','invite','signup')),
  school           school NOT NULL,
  send_after       TIMESTAMPTZ NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_announcement_email_jobs_recipient
  ON announcement_email_jobs(announcement_id, LOWER(recipient_email));
CREATE INDEX IF NOT EXISTS idx_announcement_email_jobs_due ON announcement_email_jobs(send_after) WHERE status = 'pending';

