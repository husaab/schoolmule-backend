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
    SELECT student_id, term, student_name, file_path, generated_at, grade
    FROM report_cards
    WHERE term = $1 AND school = $2
  `,

  selectGeneratedReportCardsByStudentId: `
    SELECT student_id, term, student_name, file_path, generated_at, grade
    FROM report_cards
    WHERE student_id = $1 AND term = $2 AND school = $3
  `
};

module.exports = reportCardQueries;
