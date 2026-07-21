// queries/parentPortal.queries.js
//
// Only SQL that is genuinely new for the parent portal lives here — the
// portal otherwise reuses parentStudent/term/progressReports/schoolCalendar
// queries and the analytics engine.

const parentPortalQueries = {
  /**
   * Day-by-day general attendance for one student in a date range.
   * Status enum: 'PRESENT' | 'LATE' | 'ABSENT' (present = PRESENT or LATE,
   * matching the analytics attendance convention).
   * Params: student_id, school, range_start (date), range_end (date)
   */
  selectStudentAttendanceRange: `
    SELECT attendance_date, status
    FROM general_attendance
    WHERE student_id = $1
      AND school = $2
      AND attendance_date BETWEEN $3 AND $4
    ORDER BY attendance_date
  `,

  /**
   * Report card feedback across ALL classes/terms for one student, with the
   * class subject/teacher for display (per-student variant of
   * reportCard.queries selectFeedback, which needs class_id + term).
   * Params: student_id
   */
  selectReportCardFeedbackByStudent: `
    SELECT
      rcf.student_id,
      rcf.class_id,
      rcf.term,
      rcf.work_habits,
      rcf.behavior,
      rcf.comment,
      c.subject,
      c.grade AS class_grade,
      c.teacher_name
    FROM report_card_feedback rcf
    JOIN classes c ON rcf.class_id = c.class_id
    WHERE rcf.student_id = $1
    ORDER BY rcf.term, c.subject
  `,
};

module.exports = parentPortalQueries;
