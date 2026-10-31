// queries/commentBank.queries.js
//
// A class's standard progress comments (class_comment_banks): one row per
// class, holding the Core Standards and Work Habits sentences and the mark
// cut-offs as JSON objects.

module.exports = {
  // $1 class_id
  selectForClass: `
    SELECT core_standards, work_habits, cutoffs
    FROM class_comment_banks
    WHERE class_id = $1
  `,

  // $1 class_id, $2 core_standards, $3 work_habits, $4 cutoffs, $5 updated_by
  upsert: `
    INSERT INTO class_comment_banks (class_id, core_standards, work_habits, cutoffs, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, now())
    ON CONFLICT (class_id) DO UPDATE
      SET core_standards = EXCLUDED.core_standards,
          work_habits    = EXCLUDED.work_habits,
          cutoffs        = EXCLUDED.cutoffs,
          updated_by     = EXCLUDED.updated_by,
          updated_at     = now()
    RETURNING core_standards, work_habits, cutoffs
  `,

  // $1 class_id
  deleteForClass: `DELETE FROM class_comment_banks WHERE class_id = $1`,

  // $1 caller user_id, $2 school_year_id: the caller's classes (own or
  // co-taught) in that year that have a saved bank.
  selectMine: `
    SELECT c.class_id, c.grade, c.subject, c.term_name
    FROM classes c
    JOIN class_comment_banks b ON b.class_id = c.class_id
    WHERE c.school_year_id = $2
      AND (c.teacher_id = $1
           OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))
    ORDER BY c.grade, c.subject, c.term_name NULLS FIRST
  `,

  // $1 new class_id, $2 source class_id, $3 user_id: Duplicate class and the
  // year rollover carry the source's bank over; a class with none copies none.
  copyCommentBank: `
    INSERT INTO class_comment_banks (class_id, core_standards, work_habits, cutoffs, updated_by)
    SELECT $1, core_standards, work_habits, cutoffs, $3
    FROM class_comment_banks
    WHERE class_id = $2
    ON CONFLICT (class_id) DO NOTHING
  `,
};
