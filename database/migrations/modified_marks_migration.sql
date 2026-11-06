-- ============================================================
-- Modified marks (2026-11-06).
--
-- One student wrote a different version of an assessment, usually built on
-- earlier grade level skills. The score stays real and counts in the student's
-- own grade; families see "Modified" and the label beside it, and the mark
-- stays out of that one column's class average.
--
-- This is its own table on purpose. student_assessments rows are deleted when a
-- column goes back to draft (moveCellsToDrafts, holdCellsAsDrafts), and a new
-- status would hide the number. Score writes never touch this table.
--
-- Stored on leaf assessments only: marking a category writes one row per child.
-- The flag only shows on a real mark (utils/modifiedMark.js).
--
-- Additive only; safe to re-run. Apply before the backend that reads it: the
-- analytics matrix queries read this table.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS modified_marks (
  student_id    UUID NOT NULL REFERENCES students_all(student_id) ON DELETE CASCADE,
  assessment_id UUID NOT NULL REFERENCES assessments(assessment_id) ON DELETE CASCADE,
  label         TEXT CONSTRAINT modified_marks_label_length CHECK (label IS NULL OR char_length(label) <= 80),
  created_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, assessment_id)
);

CREATE INDEX IF NOT EXISTS modified_marks_assessment ON modified_marks (assessment_id);

-- Like every table here: RLS on with no policies, so only the backend's own
-- role reads it and Supabase's public API can't.
ALTER TABLE modified_marks ENABLE ROW LEVEL SECURITY;

COMMIT;
