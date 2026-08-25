-- Schedule Planner v4: homeroom spare rules.
--
-- A "spare" is a free period-slot strictly BETWEEN a teacher's first and last
-- session on a day (a gap). Free time before their first session or after their
-- last does not count -- under an any-free-period reading the rule is
-- arithmetically impossible here (a teacher with 21 of 30 slots has 9 free
-- periods a week against a 5/week ceiling).
--
-- Both columns are nullable and opt-in per teacher: NULL = rule not applied,
-- which is the behaviour every existing row keeps.

ALTER TABLE planner_teachers
  ADD COLUMN IF NOT EXISTS max_spares_per_day SMALLINT,
  ADD COLUMN IF NOT EXISTS avoid_adjacent_spares BOOLEAN;

-- Hard cap: at most N gap-slots on any day the teacher teaches. Enforced by
-- validator.js (SPARE_CAP_VIOLATION), the CP-SAT model, and the JS solver.
COMMENT ON COLUMN planner_teachers.max_spares_per_day IS
  'Max free period-slots strictly between the first and last session of a day. NULL = unlimited.';

-- Soft preference: penalise consecutive gap-slots in the CP-SAT objective
-- ("no back-to-back spares unless impossible without"). Not enforced by
-- validator.js -- a schedule that breaks it is still valid, just worse.
COMMENT ON COLUMN planner_teachers.avoid_adjacent_spares IS
  'Prefer schedules without two consecutive gap-slots. Soft (CP-SAT objective), never a hard constraint.';

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard it to keep the whole
-- migration re-runnable like the ADD COLUMN statements above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'planner_teachers_max_spares_per_day_nonneg'
      AND conrelid = 'planner_teachers'::regclass
  ) THEN
    ALTER TABLE planner_teachers
      ADD CONSTRAINT planner_teachers_max_spares_per_day_nonneg
      CHECK (max_spares_per_day IS NULL OR max_spares_per_day >= 0);
  END IF;
END $$;
