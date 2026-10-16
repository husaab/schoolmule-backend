-- ============================================================
-- Student portal, phase 0: student accounts, per-year login links,
-- parental consent and the school's classroom settings. Additive only.
-- Apply AFTER student_portal_00_role_enum.sql. Safe to re-run.
-- ============================================================
BEGIN;

-- The student's own address (school Google account), typed by the office
-- before an account exists. Copied to users.email when invited.
ALTER TABLE students ADD COLUMN IF NOT EXISTS student_email TEXT;
CREATE INDEX IF NOT EXISTS idx_students_student_email ON students (LOWER(student_email)) WHERE student_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS student_accounts (
  user_id                 UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  school                  school NOT NULL,
  qr_secret_hash          TEXT,
  qr_issued_at            TIMESTAMPTZ,
  qr_voided_at            TIMESTAMPTZ,
  consent_by              UUID REFERENCES users(user_id) ON DELETE SET NULL,
  consent_at              TIMESTAMPTZ,
  consent_notice_version  TEXT,
  created_by              UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE student_accounts ENABLE ROW LEVEL SECURITY;

-- One login ↔ one student row per school year. Copied at rollover beside
-- parent_students so the login survives the yearly student-row copy.
CREATE TABLE IF NOT EXISTS student_account_links (
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  school_year_id  UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  linked_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, school_year_id),
  CONSTRAINT uq_student_account_links_student UNIQUE (student_id)
);
ALTER TABLE student_account_links ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS school_classroom_settings (
  school                         school PRIMARY KEY,
  enabled                        BOOLEAN NOT NULL DEFAULT FALSE,
  login_from_grade               TEXT NOT NULL DEFAULT '1'
    CHECK (login_from_grade IN ('JK','SK','1','2','3','4','5','6','7','8')),
  qr_until_grade                 TEXT NOT NULL DEFAULT '3'
    CHECK (qr_until_grade IN ('JK','SK','1','2','3','4','5','6','7','8')),
  -- NULL turns student email off for every grade.
  student_email_from_grade       TEXT DEFAULT '1'
    CHECK (student_email_from_grade IS NULL OR student_email_from_grade IN ('JK','SK','1','2','3','4','5','6','7','8')),
  parents_read_private_comments  BOOLEAN NOT NULL DEFAULT TRUE,
  summary_dow                    SMALLINT NOT NULL DEFAULT 5 CHECK (summary_dow BETWEEN 0 AND 6),
  student_photos                 BOOLEAN NOT NULL DEFAULT FALSE,
  consent_notice_version         TEXT NOT NULL DEFAULT '2026-10',
  updated_by                     UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE school_classroom_settings ENABLE ROW LEVEL SECURITY;

-- The registration import can now map a form field to the student's own
-- email ('studentEmail'). Widen the target_field CHECK: the same constraint
-- name (Postgres's default for the inline CHECK in
-- registration_import_migration.sql) with a superset of its values.
ALTER TABLE registration_field_mappings
  DROP CONSTRAINT IF EXISTS registration_field_mappings_target_field_check;
ALTER TABLE registration_field_mappings
  ADD CONSTRAINT registration_field_mappings_target_field_check CHECK (target_field IN (
    'name', 'grade', 'oen', 'dateOfBirth', 'medicalNotes', 'address',
    'healthCardNumber', 'emergencyContact',
    'motherName', 'motherEmail', 'motherPhone',
    'fatherName', 'fatherEmail', 'fatherPhone',
    'studentEmail'
  ));

COMMIT;
