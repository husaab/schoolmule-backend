const attendanceQueries = {
  // Bulk insert general attendance
  // $4 = the caller's school (token). Students of another school are skipped.
  insertGeneralAttendance: `
    INSERT INTO general_attendance (
      student_id,
      attendance_date,
      status,
      school
    )
    SELECT e.student_id, $2::date, e.status, $4::school
      FROM unnest($1::uuid[], $3::attendance_status[]) AS e(student_id, status)
      JOIN students s ON s.student_id = e.student_id AND s.school = $4::school
    ON CONFLICT (student_id, attendance_date) DO UPDATE
      SET status = EXCLUDED.status
  `,

  // Bulk insert class attendance
  // Only students on the class roster are recorded.
  insertClassAttendance: `
    INSERT INTO class_attendance (class_id, student_id, attendance_date, status)
    SELECT $1::uuid, e.student_id, $3::date, e.status
      FROM unnest($2::uuid[], $4::attendance_status[]) AS e(student_id, status)
      JOIN class_students cs ON cs.class_id = $1::uuid AND cs.student_id = e.student_id
    ON CONFLICT (class_id, student_id, attendance_date) DO UPDATE
    SET status = EXCLUDED.status
  `,

  selectClassAttendanceByDate: `
    SELECT student_id, status
    FROM class_attendance
    WHERE class_id = $1
      AND attendance_date = $2::date
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
