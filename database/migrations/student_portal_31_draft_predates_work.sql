-- ============================================================
-- Student portal, post-review fix (Fable I1): a teacher's draft grade made
-- before the student took the work back (unsubmit) or turned it in again is
-- held. classwork_submissions.draft_predates_work is set when the student
-- unsubmits or turns in while the submission holds an unpublished draft
-- (a draft score or status, or feedback); the draft itself is never dropped.
-- While it is set the work is back in "To grade" and no Publish copies the
-- draft into the gradebook. The teacher's next save of the score, status or
-- feedback (grading view, grid, Mark missing, Excuse) clears it.
--
-- Controller applies after review, BEFORE the backend that reads it (every
-- grading and student-work query selects the column). Run after
-- student_portal_30_quizzes.sql.
--
-- Additive only: one defaulted column on classwork_submissions (every
-- existing row gets FALSE, i.e. nothing held). Nothing on main reads or
-- writes classwork_submissions. No existing constraint changes. Safe to
-- re-run.
-- ============================================================
BEGIN;
-- Give up rather than queue every classwork request behind a long transaction.
SET LOCAL lock_timeout = '5s';
ALTER TABLE classwork_submissions ADD COLUMN IF NOT EXISTS draft_predates_work BOOLEAN NOT NULL DEFAULT FALSE;
COMMIT;
