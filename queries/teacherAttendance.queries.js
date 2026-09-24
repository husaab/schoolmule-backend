const teacherAttendanceQueries = {
  // GET /today — check if user already checked in today
  selectTodayStatus: `
    SELECT status, notes
    FROM teacher_attendance
    WHERE teacher_id = $1
      AND attendance_date = $2::date
  `,

  // POST /checkin — upsert own attendance for today.
  // Inserts nothing (and returns no row) when the date falls outside every
  // school year, so summer and pre-opening check-ins can't be recorded.
  upsertCheckin: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes)
    SELECT $1, $2::date, $3, $4, $5
    WHERE EXISTS (
      SELECT 1 FROM school_years sy
      WHERE sy.school = $4 AND $2::date BETWEEN sy.start_date AND sy.end_date
    )
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now()
    RETURNING *
  `,

  // GET /me — own records in a date range (inclusive). $2 = start, $3 = end
  selectMyRange: `
    SELECT attendance_date, status, notes, hours, created_at, updated_at
    FROM teacher_attendance
    WHERE teacher_id = $1
      AND attendance_date BETWEEN $2::date AND $3::date
    ORDER BY attendance_date
  `,

  // PATCH /me/:date — edit own past record (same school-year guard as check-in)
  updateMyRecord: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes)
    SELECT $1, $2::date, $3, $4, $5
    WHERE EXISTS (
      SELECT 1 FROM school_years sy
      WHERE sy.school = $4 AND $2::date BETWEEN sy.start_date AND sy.end_date
    )
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now()
    RETURNING *
  `,

  // Every staff member at the school with their records in a date range
  // (inclusive). Staff with no records still appear (LEFT JOIN).
  // $1 = start, $2 = end, $3 = school, $4 = one user_id or NULL for all staff
  selectAllForSchoolRange: `
    SELECT
      u.user_id   AS teacher_id,
      u.first_name,
      u.last_name,
      u.username,
      ta.attendance_date,
      ta.status,
      ta.notes,
      ta.hours
    FROM users u
    LEFT JOIN teacher_attendance ta
      ON ta.teacher_id = u.user_id
      AND ta.attendance_date BETWEEN $1::date AND $2::date
    WHERE u.school = $3
      AND u.role IN ('TEACHER', 'ADMIN')
      AND ($4::uuid IS NULL OR u.user_id = $4)
    ORDER BY u.last_name, u.first_name, ta.attendance_date
  `,

  // PATCH /:teacherId/:date — admin edit any teacher's record, optionally
  // overriding the hours that day is worth ($6, NULL = the person's usual day).
  updateAnyRecord: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes, hours)
    SELECT $1, $2::date, $3, $4, $5, $6
    WHERE EXISTS (
      SELECT 1 FROM school_years sy
      WHERE sy.school = $4 AND $2::date BETWEEN sy.start_date AND sy.end_date
    )
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, hours = EXCLUDED.hours, updated_at = now()
    RETURNING *
  `,

  /**
   * Open school days in a month — the days staff are actually expected in.
   * A day qualifies when it is a weekday, falls inside one of the school's
   * configured school years, and is not covered by a calendar event flagged
   * is_school_closed (holidays, PA days, breaks).
   *
   * This backs both the "Working Days" stat and the assumed-present rule, so
   * the two can never disagree. `is_elapsed` marks days on or before today in
   * the schools' local timezone — every tenant is an Ontario school, and using
   * the DB's UTC "today" would mark tomorrow as elapsed all evening.
   *
   * $1 = start date, $2 = end date (inclusive), $3 = school enum
   */
  selectOpenSchoolDays: `
    SELECT
      to_char(d, 'YYYY-MM-DD') AS day,
      (d::date <= (now() AT TIME ZONE 'America/Toronto')::date) AS is_elapsed
    FROM generate_series($1::date, $2::date, '1 day') AS d
    WHERE EXTRACT(dow FROM d) NOT IN (0, 6)
      AND EXISTS (
        SELECT 1
        FROM school_years sy
        WHERE sy.school = $3
          AND d::date BETWEEN sy.start_date AND sy.end_date
      )
      AND NOT EXISTS (
        SELECT 1
        FROM school_calendar_events e
        WHERE e.school = $3
          AND e.is_school_closed = true
          AND d::date BETWEEN e.start_date AND COALESCE(e.end_date, e.start_date)
      )
    ORDER BY d
  `,

  /**
   * The inputs for each staff member's work profile over a date range:
   * - custom_days: an admin's explicit override (staff_work_schedules)
   * - planner_days: the linked planner teacher's working days, plus any day
   *   they teach in a published timetable — for school years overlapping
   *   the range. Unioned so a manually placed class never lands on an "off" day.
   * - hours_per_day: the admin-set length of this person's work day, if any.
   * The controller picks custom → planner → every weekday.
   *
   * $1 = school enum, $2 = start date, $3 = end date, $4 = one user_id or NULL for all staff
   */
  selectWorkDayInputs: `
    WITH month_years AS (
      SELECT school_year_id
      FROM school_years
      WHERE school = $1
        AND start_date <= $3::date
        AND end_date >= $2::date
    )
    SELECT
      u.user_id,
      sws.work_days AS custom_days,
      sws.hours_per_day,
      (
        SELECT array_agg(DISTINCT day ORDER BY day)
        FROM (
          SELECT jsonb_array_elements_text(pt.allowed_days)::int AS day
          FROM planner_teachers pt
          WHERE pt.user_id = u.user_id
            AND pt.school = $1
            AND (pt.school_year_id IS NULL OR pt.school_year_id IN (SELECT school_year_id FROM month_years))
          UNION
          SELECT pss.day_of_week::int
          FROM planner_schedule_sessions pss
          JOIN planner_schedules ps ON ps.schedule_id = pss.schedule_id
          WHERE pss.teacher_user_id = u.user_id
            AND ps.school = $1
            AND ps.status = 'published'
            AND (pss.school_year_id IS NULL OR pss.school_year_id IN (SELECT school_year_id FROM month_years))
        ) days
      ) AS planner_days
    FROM users u
    LEFT JOIN staff_work_schedules sws ON sws.user_id = u.user_id
    WHERE u.school = $1
      AND u.role IN ('TEACHER', 'ADMIN')
      AND ($4::uuid IS NULL OR u.user_id = $4)
  `,

  selectStaffMember: `
    SELECT user_id FROM users
    WHERE user_id = $1 AND school = $2 AND role IN ('TEACHER', 'ADMIN')
  `,

  upsertWorkSchedule: `
    INSERT INTO staff_work_schedules (user_id, school, work_days, updated_by)
    VALUES ($1, $2, $3::smallint[], $4)
    ON CONFLICT (user_id)
    DO UPDATE SET work_days = EXCLUDED.work_days, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING *
  `,

  // Back to the planner's days. A row must say something (CHECK
  // staff_work_schedules_not_empty), so when hours_per_day is the only other
  // thing on it the row goes; otherwise just the days are cleared. The
  // controller runs the delete first so no both-NULL row ever exists.
  deleteWorkScheduleIfOnlyDays: `
    DELETE FROM staff_work_schedules
    WHERE user_id = $1 AND school = $2 AND hours_per_day IS NULL
  `,

  clearWorkDays: `
    UPDATE staff_work_schedules SET work_days = NULL, updated_by = $3, updated_at = now()
    WHERE user_id = $1 AND school = $2 AND hours_per_day IS NOT NULL
  `,

  upsertHoursPerDay: `
    INSERT INTO staff_work_schedules (user_id, school, hours_per_day, updated_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id)
    DO UPDATE SET hours_per_day = EXCLUDED.hours_per_day, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING *
  `,

  // Back to the school default; same shape as the work-days reset.
  deleteWorkScheduleIfOnlyHours: `
    DELETE FROM staff_work_schedules
    WHERE user_id = $1 AND school = $2 AND work_days IS NULL
  `,

  clearHoursPerDay: `
    UPDATE staff_work_schedules SET hours_per_day = NULL, updated_by = $3, updated_at = now()
    WHERE user_id = $1 AND school = $2 AND work_days IS NOT NULL
  `,

  // ─── Pay schedule (one per school) ───────────────────────────────────
  selectPaySchedule: `
    SELECT * FROM staff_pay_schedules WHERE school = $1
  `,

  upsertPaySchedule: `
    INSERT INTO staff_pay_schedules
      (school, frequency, pay_day_of_month, second_pay_day_of_month, anchor_pay_date, default_hours_per_day, updated_by)
    VALUES ($1, $2, $3, $4, $5::date, $6, $7)
    ON CONFLICT (school)
    DO UPDATE SET
      frequency = EXCLUDED.frequency,
      pay_day_of_month = EXCLUDED.pay_day_of_month,
      second_pay_day_of_month = EXCLUDED.second_pay_day_of_month,
      anchor_pay_date = EXCLUDED.anchor_pay_date,
      default_hours_per_day = EXCLUDED.default_hours_per_day,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
    RETURNING *
  `,

  deletePaySchedule: `
    DELETE FROM staff_pay_schedules WHERE school = $1
  `,

  // DELETE /me/:date and /:teacherId/:date — drop what was recorded for a day.
  // The day then reads as it would with no record: assumed present when it is
  // an elapsed expected day from Sept 2026 on, otherwise unmarked.
  deleteRecord: `
    DELETE FROM teacher_attendance
    WHERE teacher_id = $1 AND attendance_date = $2::date AND school = $3
    RETURNING teacher_id, attendance_date
  `,
};

module.exports = teacherAttendanceQueries;
