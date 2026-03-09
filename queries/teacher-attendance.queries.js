const teacherAttendanceQueries = {
  // GET /today — check if user already checked in today
  selectTodayStatus: `
    SELECT status
    FROM teacher_attendance
    WHERE teacher_id = $1
      AND attendance_date = CURRENT_DATE
  `,

  // POST /checkin — upsert own attendance for today
  upsertCheckin: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school)
    VALUES ($1, CURRENT_DATE, $2, $3)
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    RETURNING *
  `,

  // GET /me?month=YYYY-MM — own monthly records
  selectMyMonth: `
    SELECT attendance_date, status, created_at, updated_at
    FROM teacher_attendance
    WHERE teacher_id = $1
      AND attendance_date >= ($2 || '-01')::date
      AND attendance_date < (($2 || '-01')::date + INTERVAL '1 month')
    ORDER BY attendance_date
  `,

  // PATCH /me/:date — edit own past record
  updateMyRecord: `
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school)
    VALUES ($1, $2::date, $3, $4)
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, updated_at = now()
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
      ta.status
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
    INSERT INTO teacher_attendance (teacher_id, attendance_date, status, school)
    VALUES ($1, $2::date, $3, $4)
    ON CONFLICT (teacher_id, attendance_date)
    DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    RETURNING *
  `,

  // Working days in a month (non-weekend days)
  selectWorkingDays: `
    SELECT COUNT(*)::int AS working_days
    FROM generate_series(
      ($1 || '-01')::date,
      (($1 || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day')::date,
      '1 day'
    ) AS d
    WHERE EXTRACT(dow FROM d) NOT IN (0, 6)
  `,
};

module.exports = teacherAttendanceQueries;
