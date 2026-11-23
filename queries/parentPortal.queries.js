// queries/parentPortal.queries.js
//
// Only SQL that is genuinely new for the parent portal lives here — the
// portal otherwise reuses parentStudent/term/progressReports/schoolCalendar
// queries and the analytics engine.

const { CLASS_TEACHER_NAME } = require('./personName');

/**
 * Report comments reach parents only once the student's report for that term
 * has been emailed to the family, in the class's school year: from that
 * year's start until the next year starts. Report rows are kept per student
 * and term name with no year, so last year's send (and its email_sent flag,
 * which a regenerate keeps) must not release this year's drafts. `alias` is
 * the feedback row (student_id, term); `c` is its class.
 */
const SENT_IN_CLASS_YEAR = (reportTable, alias) => `EXISTS (
      SELECT 1
      FROM ${reportTable} r
      JOIN school_years sy ON sy.school_year_id = c.school_year_id
      WHERE r.student_id = ${alias}.student_id
        AND r.term = ${alias}.term
        AND r.email_sent
        AND r.email_sent_at >= sy.start_date
        AND NOT EXISTS (
          SELECT 1 FROM school_years nx
          WHERE nx.school_id = sy.school_id AND nx.start_date > sy.start_date AND r.email_sent_at >= nx.start_date
        )
    )`;

/** A report emailed during school year $2 (any year when $2 is null). */
const SENT_DURING_YEAR = (alias) => `(
      $2::uuid IS NULL OR EXISTS (
        SELECT 1 FROM school_years sy
        WHERE sy.school_year_id = $2
          AND ${alias}.email_sent_at >= sy.start_date
          AND NOT EXISTS (
            SELECT 1 FROM school_years nx
            WHERE nx.school_id = sy.school_id AND nx.start_date > sy.start_date AND ${alias}.email_sent_at >= nx.start_date
          )
      )
    )`;

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
      ${CLASS_TEACHER_NAME('c', 'ctn')} AS teacher_name
    FROM report_card_feedback rcf
    JOIN classes c ON rcf.class_id = c.class_id
    LEFT JOIN users ctn ON ctn.user_id = c.teacher_id
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

  /**
   * What a parent sees of a child's progress report comments (Feedback, the
   * home card, the weekly summary): only terms whose report has been emailed
   * to the family (SENT_IN_CLASS_YEAR), and only school year $2 when given.
   * Same columns as progressReports.queries getStudentProgressReportFeedback.
   * Params: student_id, school_year_id | null
   */
  selectReleasedProgressFeedbackByStudent: `
    SELECT prf.id, prf.student_id, prf.class_id, prf.term, prf.core_standards, prf.work_habit,
           prf.behavior, prf.comment, prf.created_at,
           c.subject, c.grade AS class_grade, c.teacher_name, c.progress_comments_only
    FROM progress_report_feedback prf
    JOIN classes c ON prf.class_id = c.class_id
    WHERE prf.student_id = $1
      AND ($2::uuid IS NULL OR c.school_year_id = $2)
      AND ${SENT_IN_CLASS_YEAR('progress_reports', 'prf')}
    ORDER BY c.subject ASC
  `,

  /**
   * The report card counterpart: comments of terms whose report card has
   * been emailed to the family. Params: student_id, school_year_id | null
   */
  selectReleasedReportCardFeedbackByStudent: `
    SELECT rcf.student_id, rcf.class_id, rcf.term, rcf.work_habits, rcf.behavior, rcf.comment,
           c.subject, c.grade AS class_grade,
           ${CLASS_TEACHER_NAME('c', 'ctn')} AS teacher_name
    FROM report_card_feedback rcf
    JOIN classes c ON rcf.class_id = c.class_id
    LEFT JOIN users ctn ON ctn.user_id = c.teacher_id
    WHERE rcf.student_id = $1
      AND ($2::uuid IS NULL OR c.school_year_id = $2)
      AND ${SENT_IN_CLASS_YEAR('report_cards', 'rcf')}
    ORDER BY rcf.term, c.subject
  `,

  /**
   * The progress report PDFs a parent may download: emailed to the family
   * since the file was last generated (middleware/requireReportAccess
   * sentToFamily), during school year $2 when given.
   * Params: student_id, school_year_id | null
   */
  selectSentProgressReportsByStudent: `
    SELECT pr.term, pr.file_path, pr.generated_at, pr.email_sent_at
    FROM progress_reports pr
    WHERE pr.student_id = $1
      AND pr.email_sent
      AND pr.email_sent_at >= pr.generated_at
      AND ${SENT_DURING_YEAR('pr')}
    ORDER BY pr.generated_at DESC
  `,
};

module.exports = parentPortalQueries;
