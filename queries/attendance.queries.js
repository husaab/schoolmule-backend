const attendanceQueries = {
  // Save a day's general attendance in one statement: record the marks in
  // $1/$3 and remove the marks of the students in $5 (cleared on screen).
  // $4 = the caller's school (token). Students of another school are skipped,
  // and only that school's records can be removed. The controller keeps the
  // two lists apart, so no student is both removed and recorded.
  saveGeneralAttendance: `
    WITH removed AS (
      DELETE FROM general_attendance
       WHERE attendance_date = $2::date
         AND school = $4::school
         AND student_id = ANY($5::uuid[])
    )
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

  // Save a day's attendance for one class in one statement: record the marks
  // in $2/$4 and remove the marks of the students in $5 (cleared on screen).
  // Only students on the class roster are recorded.
  saveClassAttendance: `
    WITH removed AS (
      DELETE FROM class_attendance
       WHERE class_id = $1::uuid
         AND attendance_date = $3::date
         AND student_id = ANY($5::uuid[])
    )
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

  // A class's marks over a range of days (from and to included).
  selectClassAttendanceRange: `
    SELECT student_id, to_char(attendance_date, 'YYYY-MM-DD') AS day, status
    FROM class_attendance
    WHERE class_id = $1 AND attendance_date BETWEEN $2::date AND $3::date
    ORDER BY attendance_date
  `,

  // The school's daily marks over a range of days, with each student's name and grade.
  selectGeneralAttendanceRange: `
    SELECT ga.student_id, s.name, s.grade, to_char(ga.attendance_date, 'YYYY-MM-DD') AS day, ga.status
    FROM general_attendance ga
    JOIN students s ON s.student_id = ga.student_id
    WHERE ga.school = $1 AND ga.attendance_date BETWEEN $2::date AND $3::date
    ORDER BY ga.attendance_date, s.name
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
