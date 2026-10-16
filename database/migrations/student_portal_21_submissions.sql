-- ============================================================
-- Student portal, phase 2: turn-in. One submission per student × item,
-- created lazily on first open or turn-in. "Assigned" and "Missing" are
-- derived at read time; the draft score lives here until Publish (D3).
--
-- Controller applies after review (then student_portal_21b_submissions_bucket.sql).
-- Additive: two new tables, nothing on main reads or writes them. Safe to re-run.
-- ============================================================
BEGIN;
CREATE TABLE IF NOT EXISTS classwork_submissions (
  submission_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES classwork_items(item_id) ON DELETE CASCADE,
  student_id          UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  opened_at           TIMESTAMPTZ,
  turned_in_at        TIMESTAMPTZ,
  first_turned_in_at  TIMESTAMPTZ,
  is_late             BOOLEAN NOT NULL DEFAULT FALSE,
  text_answer         TEXT,
  text_saved_at       TIMESTAMPTZ,
  draft_score         NUMERIC(10, 2),
  draft_status        TEXT CHECK (draft_status IN ('graded', 'missing', 'excused')),
  feedback            TEXT,
  feedback_saved_at   TIMESTAMPTZ,
  graded_by           UUID REFERENCES users(user_id) ON DELETE SET NULL,
  published_at        TIMESTAMPTZ,
  published_by        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_classwork_submission UNIQUE (item_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_classwork_submissions_student ON classwork_submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_classwork_submissions_review ON classwork_submissions(item_id) WHERE turned_in_at IS NOT NULL AND published_at IS NULL;
ALTER TABLE classwork_submissions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS submission_files (
  file_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID NOT NULL REFERENCES classwork_submissions(submission_id) ON DELETE CASCADE,
  file_path      TEXT NOT NULL,   -- bucket classwork-submissions, <SCHOOL>/<item_id>/<student_id>/<uuid><ext>
  file_name      TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INT NOT NULL,
  uploaded_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_submission_files_submission ON submission_files(submission_id);
ALTER TABLE submission_files ENABLE ROW LEVEL SECURITY;
COMMIT;
