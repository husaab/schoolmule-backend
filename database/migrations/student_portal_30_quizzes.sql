-- ============================================================
-- Student portal, phase 3 (Task 23): quizzes. Questions per quiz item, one
-- attempt per student (v1), autosaved answers with the machine's points and
-- a per-answer teacher override. Effective points are
-- COALESCE(teacher_points, auto_points), so a regrade never wipes an override.
-- classwork_submissions.score_set_by_teacher marks a quiz score a teacher
-- typed (grading view or grid): the quiz never overwrites it (fix round 1).
--
-- Controller applies after review, BEFORE the backend that reads it (the
-- student's work rows count a quiz's questions). Run after
-- student_portal_23_classroom_emails.sql.
--
-- Additive only: four defaulted columns (three on classwork_items, one on
-- classwork_submissions; every existing row gets after_review / no shuffle /
-- no answers shown / not set by a teacher) and three new tables that the
-- code on main never reads or writes. No existing constraint changes. Safe
-- to re-run.
-- ============================================================
BEGIN;
-- Give up rather than queue every classwork request behind a long transaction.
SET LOCAL lock_timeout = '5s';
ALTER TABLE classwork_items ADD COLUMN IF NOT EXISTS quiz_release TEXT NOT NULL DEFAULT 'after_review'
  CHECK (quiz_release IN ('after_review', 'on_submit'));
ALTER TABLE classwork_items ADD COLUMN IF NOT EXISTS quiz_shuffle BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE classwork_items ADD COLUMN IF NOT EXISTS quiz_show_answers BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS quiz_questions (
  question_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         UUID NOT NULL REFERENCES classwork_items(item_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('one', 'many', 'short', 'long')),
  prompt          TEXT NOT NULL,
  image_path      TEXT,
  options         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{ "id": "a", "text": "Nucleus" }]
  correct         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["b"]
  accepted        TEXT[] NOT NULL DEFAULT '{}',
  points          NUMERIC(6, 2) NOT NULL DEFAULT 1 CHECK (points >= 0),
  partial_credit  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quiz_questions_item ON quiz_questions(item_id, sort_order);
ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS quiz_attempts (
  attempt_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         UUID NOT NULL REFERENCES classwork_items(item_id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  question_order  UUID[] NOT NULL DEFAULT '{}',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at    TIMESTAMPTZ,
  auto_score      NUMERIC(8, 2),
  CONSTRAINT uq_quiz_attempt UNIQUE (item_id, student_id)        -- one attempt in v1
);
ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS quiz_answers (
  answer_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id      UUID NOT NULL REFERENCES quiz_attempts(attempt_id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES quiz_questions(question_id) ON DELETE CASCADE,
  answer          JSONB,                    -- one {"choice":"b"} · many {"choices":["a","c"]} · short/long {"text":"…"}
  auto_points     NUMERIC(6, 2),            -- NULL for written answers
  teacher_points  NUMERIC(6, 2),
  teacher_note    TEXT,
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  graded_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  graded_at       TIMESTAMPTZ,
  CONSTRAINT uq_quiz_answer UNIQUE (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_quiz_answers_question ON quiz_answers(question_id);
ALTER TABLE quiz_answers ENABLE ROW LEVEL SECURITY;

ALTER TABLE classwork_submissions ADD COLUMN IF NOT EXISTS score_set_by_teacher BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;
