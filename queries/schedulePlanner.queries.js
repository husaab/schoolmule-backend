// SQL for the Schedule Planner: per-school config entities, drafts, and the
// published-schedule session materialization.

// ─── Settings ────────────────────────────────────────────────────────────

const selectSettings = `
  SELECT * FROM planner_settings WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
`;

const upsertSettings = `
  INSERT INTO planner_settings (school, school_id, default_duration_minutes, snap_minutes, school_year_id)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (school, school_year_id) DO UPDATE
    SET default_duration_minutes = EXCLUDED.default_duration_minutes,
        snap_minutes = EXCLUDED.snap_minutes,
        updated_at = NOW()
  RETURNING *
`;

// ─── Teachers ────────────────────────────────────────────────────────────

const selectTeachersBySchool = `
  SELECT * FROM planner_teachers
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY display_name
`;

const selectTeacherById = `
  SELECT * FROM planner_teachers WHERE planner_teacher_id = $1 AND school = $2
`;

// Another planner teacher in the same school year already linked to an account.
// $4 excludes the teacher being edited (NULL when creating).
const selectOtherTeacherLinkedToUser = `
  SELECT planner_teacher_id, display_name FROM planner_teachers
  WHERE school = $1 AND user_id = $2
    AND ($3::uuid IS NULL OR school_year_id = $3)
    AND ($4::uuid IS NULL OR planner_teacher_id <> $4)
  LIMIT 1
`;

const insertTeacher = `
  INSERT INTO planner_teachers
    (school, school_id, user_id, staff_id, display_name, is_full_time,
     max_weekly_minutes, daily_spare_minutes, max_days_per_week,
     allowed_days, excluded_windows, notes, school_year_id,
     max_spares_per_day, avoid_adjacent_spares)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
  RETURNING *
`;

// The account link is also written through to the published snapshot, so a
// teacher linked (or unlinked) after publishing sees the change immediately
// instead of waiting for the admin to republish.
const updateTeacher = `
  WITH updated AS (
    UPDATE planner_teachers
    SET user_id = $1, staff_id = $2, display_name = $3, is_full_time = $4,
        max_weekly_minutes = $5, daily_spare_minutes = $6, max_days_per_week = $7,
        allowed_days = $8::jsonb, excluded_windows = $9::jsonb, notes = $10,
        max_spares_per_day = $11, avoid_adjacent_spares = $12, updated_at = NOW()
    WHERE planner_teacher_id = $13 AND school = $14
    RETURNING *
  ), synced AS (
    UPDATE planner_schedule_sessions pss
    SET teacher_user_id = updated.user_id
    FROM updated, planner_schedules ps
    WHERE pss.planner_teacher_id = updated.planner_teacher_id
      AND ps.schedule_id = pss.schedule_id
      AND ps.status = 'published'
      AND pss.teacher_user_id IS DISTINCT FROM updated.user_id
  )
  SELECT * FROM updated
`;

// ─── Period rules ────────────────────────────────────────────────────────

const selectPeriodRulesBySchool = `
  SELECT * FROM planner_period_rules
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY start_min, created_at
`;

const selectPeriodRuleById = `
  SELECT * FROM planner_period_rules WHERE rule_id = $1 AND school = $2
`;

const insertPeriodRule = `
  INSERT INTO planner_period_rules
    (school, school_id, school_year_id, teacher_id, class_group_id, kind,
     start_min, end_min, min_per_week)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  RETURNING *
`;

const updatePeriodRule = `
  UPDATE planner_period_rules
  SET teacher_id = $1, class_group_id = $2, kind = $3, start_min = $4,
      end_min = $5, min_per_week = $6, updated_at = NOW()
  WHERE rule_id = $7 AND school = $8
  RETURNING *
`;

const deletePeriodRule = `
  DELETE FROM planner_period_rules WHERE rule_id = $1 AND school = $2 RETURNING *
`;

const deleteTeacher = `
  DELETE FROM planner_teachers WHERE planner_teacher_id = $1 AND school = $2 RETURNING *
`;

// ─── Rooms ───────────────────────────────────────────────────────────────

const selectRoomsBySchool = `
  SELECT * FROM planner_rooms
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY name
`;

const selectRoomById = `
  SELECT * FROM planner_rooms WHERE room_id = $1 AND school = $2
`;

const insertRoom = `
  INSERT INTO planner_rooms (school, school_id, name, capacity_note, school_year_id)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING *
`;

const updateRoom = `
  UPDATE planner_rooms
  SET name = $1, capacity_note = $2, updated_at = NOW()
  WHERE room_id = $3 AND school = $4
  RETURNING *
`;

const deleteRoom = `
  DELETE FROM planner_rooms WHERE room_id = $1 AND school = $2 RETURNING *
`;

// ─── Class groups ────────────────────────────────────────────────────────

const selectClassGroupsBySchool = `
  SELECT * FROM planner_class_groups
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY sort_order, name
`;

const selectClassGroupById = `
  SELECT * FROM planner_class_groups WHERE class_group_id = $1 AND school = $2
`;

const insertClassGroup = `
  INSERT INTO planner_class_groups (school, school_id, name, grade, sort_order, school_year_id)
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING *
`;

const updateClassGroup = `
  UPDATE planner_class_groups
  SET name = $1, grade = $2, sort_order = $3, updated_at = NOW()
  WHERE class_group_id = $4 AND school = $5
  RETURNING *
`;

const deleteClassGroup = `
  DELETE FROM planner_class_groups WHERE class_group_id = $1 AND school = $2 RETURNING *
`;

// ─── Courses ─────────────────────────────────────────────────────────────

const selectCoursesBySchool = `
  SELECT * FROM planner_courses
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY name
`;

const selectCourseById = `
  SELECT * FROM planner_courses WHERE course_id = $1 AND school = $2
`;

const insertCourse = `
  INSERT INTO planner_courses
    (school, school_id, class_group_id, name, sessions_per_week, duration_minutes,
     max_per_day, assigned_teacher_id, candidate_teacher_ids, required_room_id, school_year_id,
     max_repeat_days)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
  RETURNING *
`;

const updateCourse = `
  UPDATE planner_courses
  SET name = $1, sessions_per_week = $2, duration_minutes = $3, max_per_day = $4,
      assigned_teacher_id = $5, candidate_teacher_ids = $6::jsonb,
      required_room_id = $7, max_repeat_days = $8, updated_at = NOW()
  WHERE course_id = $9 AND school = $10
  RETURNING *
`;

const deleteCourse = `
  DELETE FROM planner_courses WHERE course_id = $1 AND school = $2 RETURNING *
`;

// ─── Day templates ───────────────────────────────────────────────────────

const selectDayTemplatesBySchool = `
  SELECT * FROM planner_day_templates
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY day_of_week
`;

const deleteDayTemplatesBySchool = `
  DELETE FROM planner_day_templates WHERE school = $1 AND school_year_id = $2
`;

const insertDayTemplate = `
  INSERT INTO planner_day_templates (school, school_id, day_of_week, fillable_ranges, school_year_id)
  VALUES ($1, $2, $3, $4::jsonb, $5)
  RETURNING *
`;

// ─── Fixed blocks ────────────────────────────────────────────────────────

const selectFixedBlocksBySchool = `
  SELECT * FROM planner_fixed_blocks
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY day_of_week, start_min
`;

const insertFixedBlock = `
  INSERT INTO planner_fixed_blocks
    (school, school_id, class_group_ids, label, day_of_week, start_min, end_min, school_year_id)
  VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
  RETURNING *
`;

const updateFixedBlock = `
  UPDATE planner_fixed_blocks
  SET class_group_ids = $1::jsonb, label = $2, day_of_week = $3, start_min = $4,
      end_min = $5, updated_at = NOW()
  WHERE fixed_block_id = $6 AND school = $7
  RETURNING *
`;

const deleteFixedBlock = `
  DELETE FROM planner_fixed_blocks WHERE fixed_block_id = $1 AND school = $2 RETURNING *
`;

const deleteFixedBlocksBySchoolYear = `
  DELETE FROM planner_fixed_blocks WHERE school = $1 AND school_year_id = $2
`;

const selectFixedBlockById = `
  SELECT * FROM planner_fixed_blocks WHERE fixed_block_id = $1 AND school = $2
`;

// ─── Schedules (drafts + published) ──────────────────────────────────────

// Schools are all in Ontario; go-live dates and effective dates are local days.
const TORONTO_TODAY = `(NOW() AT TIME ZONE 'America/Toronto')::date`;

const selectSchedulesBySchool = `
  SELECT schedule_id, school, name, status, share_token, published_at, created_at, updated_at,
         source_schedule_id, go_live_on, go_live_status, go_live_error, effective_from, effective_to,
         (bell_times IS NOT NULL) AS has_bell_times
  FROM planner_schedules
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
  ORDER BY updated_at DESC
`;

const selectScheduleById = `
  SELECT * FROM planner_schedules WHERE schedule_id = $1 AND school = $2
`;

const insertSchedule = `
  INSERT INTO planner_schedules (school, school_id, name, sessions, diagnostics, config_snapshot, school_year_id)
  VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
  RETURNING *
`;

const updateSchedule = `
  UPDATE planner_schedules
  SET name = $1, sessions = $2::jsonb, diagnostics = $3::jsonb, updated_at = NOW()
  WHERE schedule_id = $4 AND school = $5
  RETURNING *
`;

const deleteSchedule = `
  DELETE FROM planner_schedules WHERE schedule_id = $1 AND school = $2 RETURNING *
`;

// ─── Copy with new times + go-live dates ─────────────────────────────────

const insertRetimedSchedule = `
  INSERT INTO planner_schedules
    (school, school_id, name, sessions, bell_times, source_schedule_id, go_live_on, go_live_status, school_year_id)
  VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::date,
          CASE WHEN $7::date IS NULL THEN NULL ELSE 'pending' END, $8)
  RETURNING *
`;

// Setting a date (again) also clears a failed attempt, which is the Retry.
const setScheduleGoLive = `
  UPDATE planner_schedules
  SET go_live_on = $3::date,
      go_live_status = CASE WHEN $3::date IS NULL THEN NULL ELSE 'pending' END,
      go_live_attempts = 0, go_live_error = NULL, updated_at = NOW()
  WHERE schedule_id = $1 AND school = $2 AND status = 'draft'
  RETURNING *
`;

// A worker that died mid-publish leaves 'running'; hand the row back.
const resetStaleGoLive = `
  UPDATE planner_schedules
  SET go_live_status = 'pending', updated_at = NOW()
  WHERE go_live_status = 'running' AND updated_at < NOW() - INTERVAL '15 minutes'
`;

const claimDueGoLive = `
  UPDATE planner_schedules ps
  SET go_live_status = 'running', go_live_attempts = ps.go_live_attempts + 1, updated_at = NOW()
  WHERE ps.schedule_id IN (
    SELECT schedule_id FROM planner_schedules
    WHERE go_live_status = 'pending' AND status = 'draft' AND go_live_on <= ${TORONTO_TODAY}
    ORDER BY go_live_on
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING schedule_id, school, school_year_id, name, go_live_on, go_live_attempts
`;

// The day a draft is set to replace the live schedule, if one is.
const selectPendingGoLive = `
  SELECT to_char(go_live_on, 'YYYY-MM-DD') AS go_live_on
  FROM planner_schedules
  WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
    AND go_live_status IN ('pending', 'running')
  LIMIT 1
`;

const recordGoLiveFailure = `
  UPDATE planner_schedules
  SET go_live_status = $2, go_live_error = $3, updated_at = NOW()
  WHERE schedule_id = $1
`;

// ─── Publish + materialized sessions ─────────────────────────────────────

// Publishing one school's schedules is serialized (Publish button vs. the
// go-live worker).
const lockPlannerPublish = `SELECT pg_advisory_xact_lock(hashtext('planner_publish:' || $1::text))`;

const selectScheduleForUpdate = `
  SELECT * FROM planner_schedules WHERE schedule_id = $1 AND school = $2 FOR UPDATE
`;

const selectSchoolId = `SELECT school_id FROM schools WHERE school_code = $1`;

// $3 = the schedule being published, which stays published (a republish).
// $4 = the live bell times: the replaced schedule keeps them, so publishing it
// again later restores them. Its finished go-live is history (effective_*),
// so a new one can be set.
const demotePublishedSchedules = `
  UPDATE planner_schedules
  SET status = 'draft', updated_at = NOW(), bell_times = $4::jsonb,
      effective_to = GREATEST(${TORONTO_TODAY} - 1, COALESCE(effective_from, ${TORONTO_TODAY} - 1)),
      go_live_on = NULL, go_live_status = NULL, go_live_attempts = 0, go_live_error = NULL
  WHERE school = $1 AND school_year_id = $2 AND status = 'published' AND schedule_id <> $3
  RETURNING schedule_id
`;

// Once live, the year's config is this schedule's bell times, so its own
// copy is cleared (bellTimes.js). A pending go-live is done either way.
const markSchedulePublished = `
  UPDATE planner_schedules
  SET effective_from = CASE WHEN status = 'published' THEN COALESCE(effective_from, ${TORONTO_TODAY})
                            ELSE ${TORONTO_TODAY} END,
      status = 'published', published_at = NOW(), updated_at = NOW(),
      effective_to = NULL, bell_times = NULL,
      go_live_status = CASE WHEN go_live_on IS NULL THEN NULL ELSE 'done' END,
      go_live_error = NULL
  WHERE schedule_id = $1 AND school = $2
  RETURNING *
`;

const deleteSessionsForSchedule = `
  DELETE FROM planner_schedule_sessions WHERE schedule_id = $1
`;

const insertScheduleSession = `
  INSERT INTO planner_schedule_sessions
    (schedule_id, school, school_id, class_group_id, class_group_name, course_name,
     planner_teacher_id, teacher_user_id, teacher_name, room_name,
     day_of_week, start_min, end_min, school_year_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
`;

const selectMySessions = `
  SELECT pss.*
  FROM planner_schedule_sessions pss
  JOIN planner_schedules ps ON ps.schedule_id = pss.schedule_id
  WHERE pss.teacher_user_id = $1 AND ps.school = $2 AND ps.status = 'published'
    AND ($3::uuid IS NULL OR pss.school_year_id = $3)
  ORDER BY pss.day_of_week, pss.start_min
`;

// Every session of the published schedule — the admin's whole-school view.
const selectSchoolSessions = `
  SELECT pss.*
  FROM planner_schedule_sessions pss
  JOIN planner_schedules ps ON ps.schedule_id = pss.schedule_id
  WHERE ps.school = $1 AND ps.status = 'published'
    AND ($2::uuid IS NULL OR pss.school_year_id = $2)
  ORDER BY pss.day_of_week, pss.start_min, pss.teacher_name
`;

const selectPublicSchedule = `
  SELECT ps.schedule_id, ps.name AS schedule_name, ps.published_at, s.name AS school_name
  FROM planner_schedules ps
  JOIN schools s ON s.school_code = ps.school
  WHERE s.slug = $1 AND ps.share_token = $2 AND ps.status = 'published'
`;

const selectSessionsForSchedule = `
  SELECT * FROM planner_schedule_sessions
  WHERE schedule_id = $1
  ORDER BY class_group_name, day_of_week, start_min
`;

// ─── Published fixed-block snapshots (v6) ────────────────────────────────
// Breaks (Snack/Lunch/Salat) are snapshotted on publish so teachers can see
// them without read access to the admin-only planner_fixed_blocks config.

const deleteFixedBlocksForSchedule = `
  DELETE FROM planner_schedule_fixed_blocks WHERE schedule_id = $1
`;

const selectFixedBlocksForSchedule = `
  SELECT * FROM planner_schedule_fixed_blocks WHERE schedule_id = $1 ORDER BY day_of_week, start_min
`;

const insertScheduleFixedBlock = `
  INSERT INTO planner_schedule_fixed_blocks
    (schedule_id, school, school_id, class_group_ids, label,
     day_of_week, start_min, end_min, school_year_id)
  VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
`;

// The single published schedule for a school/year, readable by any verified
// user — the teacher surfaces need its name/published_at, not its config.
// replaced_another: this schedule took over mid-year from another (winter
// bell times), so its calendar starts the day it went live.
const selectPublishedSchedule = `
  SELECT schedule_id, name, published_at, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
         EXISTS (
           SELECT 1 FROM planner_schedules o
           WHERE o.school = planner_schedules.school AND o.school_year_id = planner_schedules.school_year_id
             AND o.schedule_id <> planner_schedules.schedule_id AND o.effective_to IS NOT NULL
         ) AS replaced_another
  FROM planner_schedules
  WHERE school = $1 AND status = 'published'
    AND ($2::uuid IS NULL OR school_year_id = $2)
  LIMIT 1
`;

const selectMyFixedBlocks = `
  SELECT psfb.*
  FROM planner_schedule_fixed_blocks psfb
  JOIN planner_schedules ps ON ps.schedule_id = psfb.schedule_id
  WHERE ps.school = $1 AND ps.status = 'published'
    AND ($2::uuid IS NULL OR psfb.school_year_id = $2)
  ORDER BY psfb.day_of_week, psfb.start_min
`;

module.exports = {
  selectSettings,
  upsertSettings,
  selectTeachersBySchool,
  selectTeacherById,
  selectOtherTeacherLinkedToUser,
  insertTeacher,
  updateTeacher,
  deleteTeacher,
  selectRoomsBySchool,
  selectRoomById,
  insertRoom,
  updateRoom,
  deleteRoom,
  selectClassGroupsBySchool,
  selectClassGroupById,
  insertClassGroup,
  updateClassGroup,
  deleteClassGroup,
  selectCoursesBySchool,
  selectCourseById,
  insertCourse,
  updateCourse,
  deleteCourse,
  selectDayTemplatesBySchool,
  deleteDayTemplatesBySchool,
  insertDayTemplate,
  selectFixedBlocksBySchool,
  selectFixedBlockById,
  insertFixedBlock,
  updateFixedBlock,
  deleteFixedBlock,
  deleteFixedBlocksBySchoolYear,
  selectPeriodRulesBySchool,
  selectPeriodRuleById,
  insertPeriodRule,
  updatePeriodRule,
  deletePeriodRule,
  selectSchedulesBySchool,
  selectScheduleById,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  insertRetimedSchedule,
  setScheduleGoLive,
  resetStaleGoLive,
  claimDueGoLive,
  recordGoLiveFailure,
  selectPendingGoLive,
  lockPlannerPublish,
  selectScheduleForUpdate,
  selectSchoolId,
  demotePublishedSchedules,
  markSchedulePublished,
  deleteSessionsForSchedule,
  insertScheduleSession,
  selectMySessions,
  selectSchoolSessions,
  selectPublicSchedule,
  selectSessionsForSchedule,
  deleteFixedBlocksForSchedule,
  selectFixedBlocksForSchedule,
  insertScheduleFixedBlock,
  selectPublishedSchedule,
  selectMyFixedBlocks,
};
