// SQL for the Schedule Planner: per-school config entities, drafts, and the
// published-schedule session materialization.

// ─── Settings ────────────────────────────────────────────────────────────

const selectSettings = `
  SELECT * FROM planner_settings WHERE school = $1
`;

const upsertSettings = `
  INSERT INTO planner_settings (school, school_id, default_duration_minutes, snap_minutes)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (school) DO UPDATE
    SET default_duration_minutes = EXCLUDED.default_duration_minutes,
        snap_minutes = EXCLUDED.snap_minutes,
        updated_at = NOW()
  RETURNING *
`;

// ─── Teachers ────────────────────────────────────────────────────────────

const selectTeachersBySchool = `
  SELECT * FROM planner_teachers WHERE school = $1 ORDER BY display_name
`;

const selectTeacherById = `
  SELECT * FROM planner_teachers WHERE planner_teacher_id = $1 AND school = $2
`;

const insertTeacher = `
  INSERT INTO planner_teachers
    (school, school_id, user_id, staff_id, display_name, is_full_time,
     max_weekly_minutes, allowed_days, excluded_windows, notes)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
  RETURNING *
`;

const updateTeacher = `
  UPDATE planner_teachers
  SET user_id = $1, staff_id = $2, display_name = $3, is_full_time = $4,
      max_weekly_minutes = $5, allowed_days = $6::jsonb,
      excluded_windows = $7::jsonb, notes = $8, updated_at = NOW()
  WHERE planner_teacher_id = $9 AND school = $10
  RETURNING *
`;

const deleteTeacher = `
  DELETE FROM planner_teachers WHERE planner_teacher_id = $1 AND school = $2 RETURNING *
`;

// ─── Rooms ───────────────────────────────────────────────────────────────

const selectRoomsBySchool = `
  SELECT * FROM planner_rooms WHERE school = $1 ORDER BY name
`;

const selectRoomById = `
  SELECT * FROM planner_rooms WHERE room_id = $1 AND school = $2
`;

const insertRoom = `
  INSERT INTO planner_rooms (school, school_id, name, capacity_note)
  VALUES ($1, $2, $3, $4)
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
  SELECT * FROM planner_class_groups WHERE school = $1 ORDER BY sort_order, name
`;

const selectClassGroupById = `
  SELECT * FROM planner_class_groups WHERE class_group_id = $1 AND school = $2
`;

const insertClassGroup = `
  INSERT INTO planner_class_groups (school, school_id, name, grade, sort_order)
  VALUES ($1, $2, $3, $4, $5)
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
  SELECT * FROM planner_courses WHERE school = $1 ORDER BY name
`;

const selectCourseById = `
  SELECT * FROM planner_courses WHERE course_id = $1 AND school = $2
`;

const insertCourse = `
  INSERT INTO planner_courses
    (school, school_id, class_group_id, name, sessions_per_week, duration_minutes,
     max_per_day, assigned_teacher_id, candidate_teacher_ids, required_room_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
  RETURNING *
`;

const updateCourse = `
  UPDATE planner_courses
  SET name = $1, sessions_per_week = $2, duration_minutes = $3, max_per_day = $4,
      assigned_teacher_id = $5, candidate_teacher_ids = $6::jsonb,
      required_room_id = $7, updated_at = NOW()
  WHERE course_id = $8 AND school = $9
  RETURNING *
`;

const deleteCourse = `
  DELETE FROM planner_courses WHERE course_id = $1 AND school = $2 RETURNING *
`;

// ─── Day templates ───────────────────────────────────────────────────────

const selectDayTemplatesBySchool = `
  SELECT * FROM planner_day_templates WHERE school = $1 ORDER BY day_of_week
`;

const deleteDayTemplatesBySchool = `
  DELETE FROM planner_day_templates WHERE school = $1
`;

const insertDayTemplate = `
  INSERT INTO planner_day_templates (school, school_id, day_of_week, fillable_ranges)
  VALUES ($1, $2, $3, $4::jsonb)
  RETURNING *
`;

// ─── Fixed blocks ────────────────────────────────────────────────────────

const selectFixedBlocksBySchool = `
  SELECT * FROM planner_fixed_blocks WHERE school = $1 ORDER BY day_of_week, start_min
`;

const insertFixedBlock = `
  INSERT INTO planner_fixed_blocks
    (school, school_id, class_group_id, label, day_of_week, start_min, end_min)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING *
`;

const updateFixedBlock = `
  UPDATE planner_fixed_blocks
  SET class_group_id = $1, label = $2, day_of_week = $3, start_min = $4,
      end_min = $5, updated_at = NOW()
  WHERE fixed_block_id = $6 AND school = $7
  RETURNING *
`;

const deleteFixedBlock = `
  DELETE FROM planner_fixed_blocks WHERE fixed_block_id = $1 AND school = $2 RETURNING *
`;

const selectFixedBlockById = `
  SELECT * FROM planner_fixed_blocks WHERE fixed_block_id = $1 AND school = $2
`;

// ─── Schedules (drafts + published) ──────────────────────────────────────

const selectSchedulesBySchool = `
  SELECT schedule_id, school, name, status, share_token, published_at, created_at, updated_at
  FROM planner_schedules
  WHERE school = $1
  ORDER BY updated_at DESC
`;

const selectScheduleById = `
  SELECT * FROM planner_schedules WHERE schedule_id = $1 AND school = $2
`;

const insertSchedule = `
  INSERT INTO planner_schedules (school, school_id, name, sessions, diagnostics, config_snapshot)
  VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
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

// ─── Publish + materialized sessions ─────────────────────────────────────

const demotePublishedSchedules = `
  UPDATE planner_schedules
  SET status = 'draft', updated_at = NOW()
  WHERE school = $1 AND status = 'published'
  RETURNING schedule_id
`;

const markSchedulePublished = `
  UPDATE planner_schedules
  SET status = 'published', published_at = NOW(), updated_at = NOW()
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
     day_of_week, start_min, end_min)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
`;

const selectMySessions = `
  SELECT pss.*
  FROM planner_schedule_sessions pss
  JOIN planner_schedules ps ON ps.schedule_id = pss.schedule_id
  WHERE pss.teacher_user_id = $1 AND ps.school = $2 AND ps.status = 'published'
  ORDER BY pss.day_of_week, pss.start_min
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

module.exports = {
  selectSettings,
  upsertSettings,
  selectTeachersBySchool,
  selectTeacherById,
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
  selectSchedulesBySchool,
  selectScheduleById,
  insertSchedule,
  updateSchedule,
  deleteSchedule,
  demotePublishedSchedules,
  markSchedulePublished,
  deleteSessionsForSchedule,
  insertScheduleSession,
  selectMySessions,
  selectPublicSchedule,
  selectSessionsForSchedule,
};
