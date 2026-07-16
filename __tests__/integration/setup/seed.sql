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
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT users_duplicate_email_key UNIQUE(email)
);

CREATE TABLE terms (
  term_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 school NOT NULL,
  school_id              UUID REFERENCES schools(school_id),
  name                   TEXT NOT NULL,
  start_date             DATE NOT NULL,
  end_date               DATE NOT NULL,
  academic_year          TEXT,
  is_active              BOOLEAN DEFAULT FALSE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Tier 1: Tables referencing foundation ───────────────────

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
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW(),
  is_archived            BOOLEAN DEFAULT FALSE,
  archived_at            TIMESTAMPTZ,
  archived_by            UUID REFERENCES users(user_id)
);

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
  school                   school NOT NULL UNIQUE,
  school_id                UUID REFERENCES schools(school_id),
  default_duration_minutes SMALLINT NOT NULL DEFAULT 40 CHECK (default_duration_minutes BETWEEN 5 AND 480),
  snap_minutes             SMALLINT NOT NULL DEFAULT 5 CHECK (snap_minutes IN (1, 5, 10, 15)),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  allowed_days       JSONB NOT NULL DEFAULT '[1,2,3,4,5]'::jsonb,
  excluded_windows   JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, display_name)
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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, name)
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
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, name)
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
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(school, day_of_week)
);

-- Fixed blocks (lunch, prayer, recess); NULL class_group_id = school-wide
CREATE TABLE IF NOT EXISTS planner_fixed_blocks (
  fixed_block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         school NOT NULL,
  school_id      UUID REFERENCES schools(school_id),
  class_group_id UUID REFERENCES planner_class_groups(class_group_id) ON DELETE CASCADE,
  label          VARCHAR(255) NOT NULL,
  day_of_week    SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min      SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min        SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_schedules_school ON planner_schedules(school);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_planner_published_per_school
  ON planner_schedules(school) WHERE status = 'published';

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
  end_min            SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440)
);
CREATE INDEX IF NOT EXISTS idx_pss_schedule ON planner_schedule_sessions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_pss_teacher ON planner_schedule_sessions(teacher_user_id, day_of_week);
