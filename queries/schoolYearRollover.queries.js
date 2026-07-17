const rolloverQueries = {
  selectSourceStudents: `
    SELECT student_id, name, grade::text AS grade, oen, homeroom_teacher_id,
           mother_name, mother_email, mother_number,
           father_name, father_email, father_number, emergency_contact
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = false
    ORDER BY name
  `,

  selectAlreadyRolled: `
    SELECT previous_student_id
    FROM students
    WHERE school_year_id = $1 AND previous_student_id IS NOT NULL
  `,

  insertRolledStudent: `
    INSERT INTO students (
      name, homeroom_teacher_id, grade, oen, school,
      mother_name, mother_email, mother_number,
      father_name, father_email, father_number, emergency_contact,
      school_year_id, previous_student_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING student_id
  `,

  copyParentLinks: `
    INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, parent_number, relation, school)
    SELECT $1, ps.parent_id, ps.parent_name, ps.parent_email, ps.parent_number, ps.relation, ps.school
    FROM parent_students ps
    WHERE ps.student_id = $2
  `,

  selectSourceClasses: `
    SELECT class_id, grade, subject, teacher_name, teacher_id, term_name
    FROM classes
    WHERE school = $1 AND school_year_id = $2
    ORDER BY grade, subject
  `,

  insertRolledClass: `
    INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING class_id
  `,

  copyClassTeachers: `
    INSERT INTO class_teachers (class_id, teacher_id)
    SELECT $1, ct.teacher_id FROM class_teachers ct WHERE ct.class_id = $2
    ON CONFLICT DO NOTHING
  `,

  insertTermForYear: `
    INSERT INTO terms (school, school_id, name, start_date, end_date, academic_year, is_active, school_year_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, NOW())
    RETURNING term_id, name
  `,

  copyPlannerSettings: `
    INSERT INTO planner_settings (school, school_id, default_duration_minutes, snap_minutes, school_year_id)
    SELECT school, school_id, default_duration_minutes, snap_minutes, $2
    FROM planner_settings WHERE school = $1 AND school_year_id = $3
    ON CONFLICT (school, school_year_id) DO NOTHING
  `,

  copyPlannerTeachers: `
    INSERT INTO planner_teachers (school, school_id, user_id, staff_id, display_name, is_full_time,
                                  max_weekly_minutes, allowed_days, excluded_windows, notes, daily_spare_minutes, school_year_id)
    SELECT school, school_id, user_id, staff_id, display_name, is_full_time,
           max_weekly_minutes, allowed_days, excluded_windows, notes, daily_spare_minutes, $2
    FROM planner_teachers WHERE school = $1 AND school_year_id = $3
  `,

  copyPlannerRooms: `
    INSERT INTO planner_rooms (school, school_id, name, capacity_note, school_year_id)
    SELECT school, school_id, name, capacity_note, $2
    FROM planner_rooms WHERE school = $1 AND school_year_id = $3
  `,

  selectPlannerClassGroups: `
    SELECT class_group_id, school, school_id, name, grade, sort_order
    FROM planner_class_groups WHERE school = $1 AND school_year_id = $2
  `,

  insertPlannerClassGroup: `
    INSERT INTO planner_class_groups (school, school_id, name, grade, sort_order, school_year_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING class_group_id
  `,

  copyPlannerDayTemplates: `
    INSERT INTO planner_day_templates (school, school_id, day_of_week, fillable_ranges, school_year_id)
    SELECT school, school_id, day_of_week, fillable_ranges, $2
    FROM planner_day_templates WHERE school = $1 AND school_year_id = $3
  `,

  selectPlannerFixedBlocks: `
    SELECT school, school_id, label, day_of_week, start_min, end_min, class_group_ids
    FROM planner_fixed_blocks WHERE school = $1 AND school_year_id = $2
  `,

  insertPlannerFixedBlock: `
    INSERT INTO planner_fixed_blocks (school, school_id, label, day_of_week, start_min, end_min, class_group_ids, school_year_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,

  copyCalendarEvents: `
    INSERT INTO school_calendar_events (school, school_id, title, category, start_date, end_date, is_school_closed, notes, school_year_id)
    SELECT school, school_id, title, category,
           (start_date + INTERVAL '1 year')::date,
           (end_date + INTERVAL '1 year')::date,
           is_school_closed, notes, $2
    FROM school_calendar_events WHERE school = $1 AND school_year_id = $3
  `,
};

module.exports = rolloverQueries;
