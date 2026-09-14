-- Schedule planner v7 — backfill teacher account links into published schedules.
-- Run this migration against your Supabase PostgreSQL database. Safe to re-run.
--
-- Publishing snapshots each planner teacher's linked account into
-- planner_schedule_sessions.teacher_user_id. Teachers linked AFTER a schedule
-- was published therefore saw nothing on their dashboard until the admin
-- republished. updateTeacher now writes link changes through to the published
-- snapshot; this one-time update repairs sessions published before that.

BEGIN;

UPDATE planner_schedule_sessions pss
SET teacher_user_id = pt.user_id
FROM planner_teachers pt, planner_schedules ps
WHERE pss.planner_teacher_id = pt.planner_teacher_id
  AND ps.schedule_id = pss.schedule_id
  AND ps.status = 'published'
  AND pss.teacher_user_id IS DISTINCT FROM pt.user_id;

COMMIT;
