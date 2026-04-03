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

CREATE TABLE tuition_plans (
  plan_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 school NOT NULL,
  grade                  TEXT NOT NULL,
  amount                 NUMERIC(10, 2) NOT NULL,
  frequency              TEXT NOT NULL,
  effective_from         DATE NOT NULL,
  effective_to           DATE,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW()
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

CREATE TABLE schedules (
  schedule_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school                 school NOT NULL,
  grade                  TEXT NOT NULL,
  day_of_week            TEXT NOT NULL,
  start_time             TIME NOT NULL,
  end_time               TIME NOT NULL,
  subject                TEXT,
  teacher_name           TEXT,
  is_lunch               BOOLEAN DEFAULT FALSE,
  lunch_supervisor       TEXT,
  week_start_date        DATE NOT NULL,
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

CREATE TABLE messages (
  message_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id              UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  school                 school NOT NULL,
  subject                TEXT NOT NULL,
  body                   TEXT,
  sender_name            TEXT,
  recipient_name         TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE feedback (
  feedback_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id              UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  sender_name            TEXT,
  recipient_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_name         TEXT,
  school                 school NOT NULL,
  subject                TEXT,
  body                   TEXT,
  assessment_name        TEXT,
  score                  NUMERIC,
  weight_percentage      NUMERIC,
  course_name            TEXT,
  student_id             UUID REFERENCES students(student_id) ON DELETE CASCADE,
  student_name           TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW()
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

CREATE TABLE tuition_invoices (
  invoice_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                UUID REFERENCES tuition_plans(plan_id),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  student_name           TEXT,
  student_grade          TEXT,
  parent_id              UUID REFERENCES users(user_id),
  parent_name            TEXT,
  parent_email           TEXT,
  parent_number          TEXT,
  period_start           DATE,
  period_end             DATE,
  amount_due             NUMERIC(10, 2),
  date_due               DATE,
  amount_paid            NUMERIC(10, 2) DEFAULT 0,
  date_paid              DATE,
  issued_at              TIMESTAMPTZ,
  status                 TEXT DEFAULT 'draft',
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  last_modified_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tuition_invoice_comments (
  comment_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id             UUID NOT NULL REFERENCES tuition_invoices(invoice_id) ON DELETE CASCADE,
  commenter_id           UUID REFERENCES users(user_id),
  commenter_name         TEXT,
  comment                TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
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

-- ─── JKSK Tables ─────────────────────────────────────────────

CREATE TABLE jksk_skill_domains (
  domain_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type          TEXT NOT NULL CHECK (document_type IN ('progress_report', 'report_card')),
  name                   TEXT NOT NULL,
  sort_order             INT DEFAULT 0,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_type, name, school)
);

CREATE TABLE jksk_skills (
  skill_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id              UUID NOT NULL REFERENCES jksk_skill_domains(domain_id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  description            TEXT,
  sort_order             INT DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain_id, name)
);

CREATE TABLE jksk_skill_assessments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  skill_id               UUID NOT NULL REFERENCES jksk_skills(skill_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  rating                 TEXT,
  school                 school NOT NULL,
  assessed_by            UUID REFERENCES users(user_id),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, skill_id, term)
);

CREATE TABLE jksk_learning_skills (
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

CREATE TABLE jksk_domain_comments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  domain_id              UUID NOT NULL REFERENCES jksk_skill_domains(domain_id) ON DELETE CASCADE,
  term                   TEXT NOT NULL,
  comment                TEXT,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, domain_id, term)
);

CREATE TABLE jksk_teacher_assistants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id             UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  teacher_assistant_name TEXT,
  term                   TEXT NOT NULL,
  school                 school NOT NULL,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(student_id, term)
);

CREATE TABLE jksk_progress_report_comments (
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

-- ─── Indexes ─────────────────────────────────────────────────

CREATE INDEX idx_classes_school ON classes(school);
CREATE INDEX idx_classes_teacher_id ON classes(teacher_id);
CREATE INDEX idx_students_school ON students(school);
CREATE INDEX idx_assessments_class_id ON assessments(class_id);
CREATE INDEX idx_student_assessments_student ON student_assessments(student_id);
CREATE INDEX idx_tuition_invoices_student ON tuition_invoices(student_id);
CREATE INDEX idx_tuition_invoices_school ON tuition_invoices(school);
CREATE INDEX idx_parent_students_student ON parent_students(student_id);
CREATE INDEX idx_parent_students_parent ON parent_students(parent_id);
CREATE INDEX idx_terms_school ON terms(school);
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_recipient ON messages(recipient_id);
CREATE INDEX idx_feedback_sender ON feedback(sender_id);
CREATE INDEX idx_feedback_recipient ON feedback(recipient_id);
CREATE INDEX idx_jksk_skill_assessments_student_term ON jksk_skill_assessments(student_id, term);
CREATE INDEX idx_jksk_learning_skills_student_term ON jksk_learning_skills(student_id, term);
CREATE INDEX idx_jksk_domain_comments_student_term ON jksk_domain_comments(student_id, term);
CREATE INDEX idx_jksk_skills_domain ON jksk_skills(domain_id);
CREATE INDEX idx_class_teachers_teacher_id ON class_teachers(teacher_id);
