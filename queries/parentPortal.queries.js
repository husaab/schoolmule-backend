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

  /**
   * When this parent last looked at each of their children's marks.
   *
   * Drives the dashboard's NEW badge. The comparison against published_at
   * happens on the server, not in the browser, so a wrong client clock
   * can't misreport what's new. A NULL means the parent has never opened
   * the dashboard, in which case everything published counts as new.
   *
   * Params: $1 parent_id
   */
  selectLastSeenByParent: `
    SELECT student_id, last_seen_at
    FROM parent_students
    WHERE parent_id = $1
  `,

  /**
   * Mark every child of this parent as seen, clearing the NEW badges.
   * Params: $1 parent_id
   */
  markParentPublicationsSeen: `
    UPDATE parent_students
    SET last_seen_at = NOW()
    WHERE parent_id = $1
    RETURNING last_seen_at
  `,
};

module.exports = parentPortalQueries;
