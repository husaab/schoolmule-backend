-- ============================================================
-- Report Template Designer: a school's own report card / progress report
-- layouts (reportkit TemplateDoc JSON), their published versions, which one
-- prints for which grades and terms, and the per-student values of a
-- template's extra fields.
--
--   report_templates             one designed template; the draft is edited
--                                in place (draft_rev = optimistic concurrency)
--   report_template_versions     an immutable published snapshot; a printed
--                                report points at the version it used
--   report_template_assignments  "grades X, terms Y print template T (or
--                                built-in default K)"; lower priority wins
--   report_field_values          extra field values per student/doc/term
--
-- report_cards / progress_reports gain the template version, built-in key,
-- engine version and render warnings of the PDF stored for that row (all
-- NULL for a report the legacy generator printed).
--
-- DEPLOY ORDER: 1) this migration  2) backend  3) frontend. The backend reads
-- these tables on every report generation once REPORT_ENGINE is new/shadow,
-- and the designer API needs them from the start.
--
-- Additive only and safe to re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS report_templates (
  template_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school               school NOT NULL,
  doc_type             TEXT NOT NULL CONSTRAINT report_templates_doc_type_check
                         CHECK (doc_type IN ('report_card', 'progress_report')),
  name                 TEXT NOT NULL CONSTRAINT report_templates_name_check
                         CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  -- The built-in default it was copied from (reportkit DEFAULT_TEMPLATES key).
  base_key             TEXT,
  draft_doc            JSONB NOT NULL,
  draft_rev            INT NOT NULL DEFAULT 1,
  published_version_id UUID,
  archived_at          TIMESTAMPTZ,
  created_by           UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by           UUID REFERENCES users(user_id) ON DELETE SET NULL
);

-- An archived template frees its name.
CREATE UNIQUE INDEX IF NOT EXISTS report_templates_school_name_key
  ON report_templates (school, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS report_template_versions (
  version_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    UUID NOT NULL CONSTRAINT report_template_versions_template_id_fkey
                   REFERENCES report_templates(template_id) ON DELETE RESTRICT,
  version_no     INT NOT NULL,
  doc            JSONB NOT NULL,
  doc_sha256     TEXT,
  engine_version INT,
  note           TEXT,
  published_by   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_template_versions_template_version_key UNIQUE (template_id, version_no)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_templates_published_version_id_fkey') THEN
    ALTER TABLE report_templates
      ADD CONSTRAINT report_templates_published_version_id_fkey
      FOREIGN KEY (published_version_id) REFERENCES report_template_versions(version_id);
  END IF;
END $$;

-- A published version is what printed reports point at: its content never
-- changes. Deleting a whole never-used template (versions first) is allowed.
CREATE OR REPLACE FUNCTION report_template_versions_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.doc IS DISTINCT FROM OLD.doc
     OR NEW.doc_sha256 IS DISTINCT FROM OLD.doc_sha256
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
    RAISE EXCEPTION 'report_template_versions are immutable (version %)', OLD.version_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_report_template_versions_immutable ON report_template_versions;
CREATE TRIGGER trg_report_template_versions_immutable
  BEFORE UPDATE ON report_template_versions
  FOR EACH ROW EXECUTE FUNCTION report_template_versions_immutable();

CREATE TABLE IF NOT EXISTS report_template_assignments (
  assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school        school NOT NULL,
  doc_type      TEXT NOT NULL CONSTRAINT report_template_assignments_doc_type_check
                  CHECK (doc_type IN ('report_card', 'progress_report')),
  template_id   UUID CONSTRAINT report_template_assignments_template_id_fkey
                  REFERENCES report_templates(template_id) ON DELETE RESTRICT,
  default_key   TEXT,
  -- NULL = every grade / every term. Terms are names ('Term 2'), matched
  -- case-insensitively.
  grades        TEXT[],
  terms         TEXT[],
  priority      INT NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT report_template_assignments_target_check
    CHECK ((template_id IS NULL) <> (default_key IS NULL)),
  CONSTRAINT report_template_assignments_grades_check
    CHECK (grades IS NULL OR grades <@ ARRAY['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8']::TEXT[])
);

CREATE INDEX IF NOT EXISTS report_template_assignments_school_doc_idx
  ON report_template_assignments (school, doc_type);
CREATE INDEX IF NOT EXISTS report_template_assignments_template_idx
  ON report_template_assignments (template_id) WHERE template_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS report_field_values (
  school     school NOT NULL,
  student_id UUID NOT NULL CONSTRAINT report_field_values_student_id_fkey
               REFERENCES students_all(student_id) ON DELETE CASCADE,
  doc_type   TEXT NOT NULL CONSTRAINT report_field_values_doc_type_check
               CHECK (doc_type IN ('report_card', 'progress_report')),
  term       TEXT NOT NULL,
  field_key  TEXT NOT NULL,
  value      TEXT,
  updated_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, doc_type, term, field_key)
);

-- What printed each stored report (NULL = the legacy generator).
ALTER TABLE report_cards ADD COLUMN IF NOT EXISTS template_version_id UUID;
ALTER TABLE report_cards ADD COLUMN IF NOT EXISTS template_key TEXT;
ALTER TABLE report_cards ADD COLUMN IF NOT EXISTS engine_version INT;
ALTER TABLE report_cards ADD COLUMN IF NOT EXISTS render_warnings JSONB;
ALTER TABLE progress_reports ADD COLUMN IF NOT EXISTS template_version_id UUID;
ALTER TABLE progress_reports ADD COLUMN IF NOT EXISTS template_key TEXT;
ALTER TABLE progress_reports ADD COLUMN IF NOT EXISTS engine_version INT;
ALTER TABLE progress_reports ADD COLUMN IF NOT EXISTS render_warnings JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_cards_template_version_id_fkey') THEN
    ALTER TABLE report_cards
      ADD CONSTRAINT report_cards_template_version_id_fkey
      FOREIGN KEY (template_version_id) REFERENCES report_template_versions(version_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'progress_reports_template_version_id_fkey') THEN
    ALTER TABLE progress_reports
      ADD CONSTRAINT progress_reports_template_version_id_fkey
      FOREIGN KEY (template_version_id) REFERENCES report_template_versions(version_id);
  END IF;
END $$;

-- Backend-only tables, same posture as the other app tables.
ALTER TABLE report_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_template_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_field_values ENABLE ROW LEVEL SECURITY;

-- Al Haadi's Term 2 report card (grades 1-8) is the three-row T1/T2/Final
-- layout. Until the 'report-card-t1t2final' built-in ships in reportkit the
-- resolver skips this row and the legacy Al Haadi T2 generator keeps printing.
DO $$
BEGIN
  -- Nested, so the enum literal is only ever cast when the label exists.
  IF EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'school' AND e.enumlabel = 'ALHAADIACADEMY'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM report_template_assignments
      WHERE school::text = 'ALHAADIACADEMY' AND doc_type = 'report_card' AND default_key = 'report-card-t1t2final'
    ) THEN
      INSERT INTO report_template_assignments (school, doc_type, default_key, grades, terms, priority)
      VALUES ('ALHAADIACADEMY', 'report_card', 'report-card-t1t2final',
              ARRAY['1', '2', '3', '4', '5', '6', '7', '8'], ARRAY['Term 2'], 50);
    END IF;
  END IF;
END $$;

COMMIT;
