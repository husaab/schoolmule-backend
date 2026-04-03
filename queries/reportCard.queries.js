const reportCardQueries = {
  upsertFeedback: `
    INSERT INTO report_card_feedback (
      student_id, class_id, term, work_habits, behavior, comment
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (student_id, class_id, term) DO UPDATE
    SET
      work_habits = EXCLUDED.work_habits,
      behavior = EXCLUDED.behavior,
      comment = EXCLUDED.comment,
      created_at = now()
  `,

  selectFeedback: `
    SELECT student_id, class_id, term, work_habits, behavior, comment
    FROM report_card_feedback
    WHERE student_id = $1 AND class_id = $2 AND term = $3
  `,

  selectFeedbackByClass: `
    SELECT rcf.student_id, rcf.class_id, rcf.term, rcf.work_habits, rcf.behavior, rcf.comment, s.name as student_name
    FROM report_card_feedback rcf
    JOIN students s ON s.student_id = rcf.student_id
    WHERE rcf.class_id = $1 AND rcf.term = $2
  `,

  upsertGeneratedReportCard: `
    INSERT INTO report_cards (student_id, term, student_name, file_path, grade, school)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (student_id, term) DO UPDATE
    SET file_path = EXCLUDED.file_path,
        grade = EXCLUDED.grade,
        school = EXCLUDED.school,
        generated_at = now()
  `,

  selectGeneratedReportCards: `
    SELECT student_id, term, student_name, file_path, generated_at, grade, email_sent, email_sent_at, email_sent_by
    FROM report_cards
    WHERE term = $1 AND school = $2
  `,

  selectGeneratedReportCardsByStudentId: `
    SELECT student_id, term, student_name, file_path, generated_at, grade, email_sent, email_sent_at, email_sent_by
    FROM report_cards
    WHERE student_id = $1 AND term = $2 AND school = $3
  `,

  updateReportCardEmailStatus: `
    UPDATE report_cards
    SET 
      email_sent = $3,
      email_sent_at = $4,
      email_sent_by = $5
    WHERE student_id = $1 AND term = $2
    RETURNING *
  `
};

module.exports = reportCardQueries;
