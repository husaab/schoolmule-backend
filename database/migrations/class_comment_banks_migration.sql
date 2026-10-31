-- Standard progress comments per class (2026-10-31). A class's teachers keep
-- one standard sentence per Core Standards level (exceeding, meeting,
-- workingTowards, notMeeting) and per Work Habits rating (E, G, S, N), plus
-- the mark cut-offs that suggest a level. The Progress Comments tab builds a
-- student's comment from them. A class with no row uses SchoolMule's starter
-- set, which lives in the web's src/lib/commentBank.ts.
--
-- Duplicate class and the school-year rollover copy the row to the new class.
--
-- Run BEFORE deploying the backend that serves /api/comment-banks. Idempotent.

CREATE TABLE IF NOT EXISTS class_comment_banks (
  class_id       UUID PRIMARY KEY REFERENCES classes(class_id) ON DELETE CASCADE,
  core_standards JSONB NOT NULL,
  work_habits    JSONB NOT NULL,
  cutoffs        JSONB NOT NULL,
  updated_by     UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
