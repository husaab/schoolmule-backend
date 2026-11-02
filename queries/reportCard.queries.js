const reportCardQueries = {
  // $7 comment_details (jsonb or null), $8 whether the entry carried them:
  // an entry without them (older app builds) keeps what is saved.
  upsertFeedback: `
    INSERT INTO report_card_feedback (
      student_id, class_id, term, work_habits, behavior, comment, comment_details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (student_id, class_id, term) DO UPDATE
    SET
      work_habits = EXCLUDED.work_habits,
      behavior = EXCLUDED.behavior,
      comment = EXCLUDED.comment,
      comment_details = CASE WHEN $8::boolean THEN EXCLUDED.comment_details ELSE report_card_feedback.comment_details END,
      created_at = now()
  `,

  selectFeedback: `
    SELECT student_id, class_id, term, work_habits, behavior, comment
    FROM report_card_feedback
    WHERE student_id = $1 AND class_id = $2 AND term = $3
  `,

  selectFeedbackByClass: `
    SELECT rcf.student_id, rcf.class_id, rcf.term, rcf.work_habits, rcf.behavior, rcf.comment, rcf.comment_details, s.name as student_name
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
    SELECT rc.student_id, rc.term, rc.student_name, rc.file_path, rc.generated_at, rc.grade, rc.email_sent, rc.email_sent_at, rc.email_sent_by
    FROM report_cards rc
    JOIN students s ON s.student_id = rc.student_id
    WHERE rc.term = $1 AND rc.school = $2
      AND ($3::uuid IS NULL OR s.school_year_id = $3)
  `,

  selectGeneratedReportCardsByStudentId: `
    SELECT student_id, term, student_name, file_path, generated_at, grade, email_sent, email_sent_at, email_sent_by
    FROM report_cards
    WHERE student_id = $1 AND term = $2 AND school = $3
  `,

  // Every class a grade 1-8 student takes in the term, and whether its
  // teacher has entered the report card's work habits, behaviour and comment
  // for them (what the class's Report card comments page counts as done).
  // Feedback is stored under the class's own term name. JK and SK cards are
  // skills-based and print no class comments, so they're left out.
  // $1 school, $2 term name, $3 school year (null = any).
  selectTermCommentsStatus: `
    SELECT cs.student_id, c.class_id, c.subject, c.teacher_name,
      (NULLIF(btrim(f.work_habits), '') IS NOT NULL
        AND NULLIF(btrim(f.behavior), '') IS NOT NULL
        AND NULLIF(btrim(f.comment), '') IS NOT NULL) AS complete
    FROM classes c
    JOIN terms t ON t.term_id = c.term_id
    JOIN class_students cs ON cs.class_id = c.class_id
    JOIN students s ON s.student_id = cs.student_id
    LEFT JOIN report_card_feedback f
      ON f.student_id = cs.student_id AND f.class_id = c.class_id AND f.term = t.name
    WHERE c.school = $1 AND t.name = $2
      AND ($3::uuid IS NULL OR t.school_year_id = $3)
      AND COALESCE(s.grade::text, '') NOT IN ('JK', 'SK')
    ORDER BY cs.student_id, c.subject
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
