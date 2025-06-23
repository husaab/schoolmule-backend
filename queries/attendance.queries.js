const attendanceQueries = {
  // Bulk insert general attendance
  insertGeneralAttendance: `
    INSERT INTO general_attendance (
      student_id,
      attendance_date,
      status,
      school
    )
    SELECT
      unnest($1::uuid[]),
      $2::date,
      unnest($3::attendance_status[]),
      $4::school
    ON CONFLICT (student_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status
  `,

  // Bulk insert class attendance
  insertClassAttendance: `
    INSERT INTO class_attendance (class_id, student_id, attendance_date, status)
    SELECT
      $1::uuid,
      unnest($2::uuid[]),
      $3::date,
      unnest($4::attendance_status[])
    ON CONFLICT (class_id, student_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status
  `,

  selectGeneralAttendanceByDate: `
    SELECT student_id, status
    FROM general_attendance
    WHERE attendance_date = $1
  `,

  // Get class attendance for a given class and date
  selectGeneralAttendanceByDate: `
    SELECT student_id, status
    FROM general_attendance
    WHERE attendance_date = $1
      AND school = $2
  `,
};

module.exports = attendanceQueries;
