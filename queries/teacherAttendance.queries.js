const teacherAttendanceQueries = {
  // GET /today — check if user already checked in today
  selectTodayStatus: `
    SELECT status, notes
    FROM teacher_attendance
    WHERE teacher_id = $1
      AND attendance_date = $2::date
  `,

  // POST /checkin — upsert own attendance for today
  upsertCheckin: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes)
    VALUES ($1, $2::date, $3, $4, $5)
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now()
    RETURNING *
  `,

  // GET /me?month=YYYY-MM — own monthly records
  selectMyMonth: `
    SELECT attendance_date, status, notes, created_at, updated_at
    FROM teacher_attendance
    WHERE teacher_id = $1
      AND attendance_date >= ($2 || '-01')::date
      AND attendance_date < (($2 || '-01')::date + INTERVAL '1 month')
    ORDER BY attendance_date
  `,

  // PATCH /me/:date — edit own past record
  updateMyRecord: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes)
    VALUES ($1, $2::date, $3, $4, $5)
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now()
    RETURNING *
  `,

  // GET /?school=X&month=YYYY-MM — all teachers for school + month (admin)
  selectAllForSchoolMonth: `
    SELECT
      u.user_id   AS teacher_id,
      u.first_name,
      u.last_name,
      u.username,
      ta.attendance_date,
      ta.status,
      ta.notes
    FROM users u
    LEFT JOIN teacher_attendance ta
      ON ta.teacher_id = u.user_id
      AND ta.attendance_date >= ($1 || '-01')::date
      AND ta.attendance_date < (($1 || '-01')::date + INTERVAL '1 month')
    WHERE u.school = $2
      AND u.role IN ('TEACHER', 'ADMIN')
    ORDER BY u.last_name, u.first_name, ta.attendance_date
  `,

  // PATCH /:teacherId/:date — admin edit any teacher's record
  updateAnyRecord: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school, notes)
    VALUES ($1, $2::date, $3, $4, $5)
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = now()
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
   * $1 = month (YYYY-MM), $2 = school enum
   */
  selectOpenSchoolDays: `
    SELECT
      to_char(d, 'YYYY-MM-DD') AS day,
      (d::date <= (now() AT TIME ZONE 'America/Toronto')::date) AS is_elapsed
    FROM generate_series(
      ($1 || '-01')::date,
      (($1 || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day')::date,
      '1 day'
    ) AS d
    WHERE EXTRACT(dow FROM d) NOT IN (0, 6)
      AND EXISTS (
        SELECT 1
        FROM school_years sy
        WHERE sy.school = $2
          AND d::date BETWEEN sy.start_date AND sy.end_date
      )
      AND NOT EXISTS (
        SELECT 1
        FROM school_calendar_events e
        WHERE e.school = $2
          AND e.is_school_closed = true
          AND d::date BETWEEN e.start_date AND COALESCE(e.end_date, e.start_date)
      )
    ORDER BY d
  `,
};

module.exports = teacherAttendanceQueries;
