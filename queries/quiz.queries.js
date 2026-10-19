// queries/quiz.queries.js
//
// Quizzes (T23): a quiz item's questions, each student's one attempt and its
// answers. Student-side reads go through selectStudentQuestions, which has
// no answer-key columns at all (correct, accepted): the key reaches a student
// only through the results, once their grade is visible, and only when the
// teacher shows answers. Every attempt query is keyed on an item AND one
// student row (the caller's own req.student.studentId) or on an answer the
// teacher's class owns (requireClassroomResource('quizAnswer')).
//
// Writers lock in one order: the item, its gradebook column, the attempt,
// its answers, then the submission (the grading writers' column-before-
// submission order), so a submit, an override and an answer-key change on
// the same quiz never deadlock or interleave.
//
// Aliases: `i` item, `a` its assessment, `qq` question, `qt` attempt, `qa` answer.

const QUESTION_COLUMNS = `qq.question_id, qq.item_id, qq.kind, qq.prompt, qq.image_path, qq.options, qq.correct, qq.accepted,
       qq.points, qq.partial_credit, qq.sort_order`;
const QUESTION_ORDER = 'ORDER BY qq.sort_order, qq.created_at, qq.question_id';

const quizQueries = {
  // ── The quiz item ───────────────────────────────────────────────────────

  //  The quiz's item, settings and gradebook column. $1 item_id
  //  release_by: who stands behind a release on submit (Fable M4), recorded
  //  as the publisher like any Publish: the teacher who made the quiz, else
  //  the class's lead teacher.
  selectQuizItem: `
    SELECT i.item_id, i.class_id, i.kind, i.assessment_id, i.quiz_release, i.quiz_shuffle, i.quiz_show_answers,
           a.max_score, COALESCE(a.is_published, FALSE) AS is_published,
           COALESCE(i.created_by, c.teacher_id) AS release_by
    FROM classwork_items i
    JOIN classes c ON c.class_id = i.class_id
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    WHERE i.item_id = $1 AND i.deleted_at IS NULL`,

  //  The first lock every quiz writer takes. A question edit takes it FOR
  //  UPDATE, so no answer is saved or submitted while the key changes.
  //  $1 item_id
  lockItemShare: `SELECT item_id FROM classwork_items WHERE item_id = $1 AND deleted_at IS NULL FOR SHARE`,
  lockItemUpdate: `SELECT item_id FROM classwork_items WHERE item_id = $1 AND deleted_at IS NULL FOR UPDATE`,

  //  $1 item_id, $2 release, $3 shuffle, $4 show answers
  updateQuizSettings: `
    UPDATE classwork_items SET quiz_release = $2, quiz_shuffle = $3, quiz_show_answers = $4 WHERE item_id = $1`,

  //  Does the quiz have a written (hand-graded) question? $1 item_id
  selectHasWritten: `SELECT EXISTS (SELECT 1 FROM quiz_questions WHERE item_id = $1 AND kind = 'long') AS has_written`,

  // ── Questions ───────────────────────────────────────────────────────────

  //  Every column, answer key included: the teacher's builder and the
  //  server's own scoring only. $1 item_id
  selectQuestions: `
    SELECT ${QUESTION_COLUMNS}
    FROM quiz_questions qq WHERE qq.item_id = $1
    ${QUESTION_ORDER}`,

  //  What a student may read of the questions: never correct or accepted. $1 item_id
  selectStudentQuestions: `
    SELECT qq.question_id, qq.kind, qq.prompt, qq.image_path, qq.options, qq.points, qq.sort_order
    FROM quiz_questions qq WHERE qq.item_id = $1
    ${QUESTION_ORDER}`,

  //  $1 item_id, $2 kind, $3 prompt, $4 image_path, $5 options, $6 correct, $7 accepted, $8 points, $9 partial_credit, $10 sort_order
  insertQuestion: `
    INSERT INTO quiz_questions (item_id, kind, prompt, image_path, options, correct, accepted, points, partial_credit, sort_order)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::text[], $8, $9, $10)
    RETURNING question_id`,

  //  $1 question_id, $2 item_id, $3..$11 as insertQuestion's $2..$10
  updateQuestion: `
    UPDATE quiz_questions
    SET kind = $3, prompt = $4, image_path = $5, options = $6::jsonb, correct = $7::jsonb, accepted = $8::text[],
        points = $9, partial_credit = $10, sort_order = $11, updated_at = NOW()
    WHERE question_id = $1 AND item_id = $2
    RETURNING question_id`,

  //  The questions the edit left out (their answers cascade). $1 item_id, $2 question ids to keep
  deleteQuestionsExcept: `
    DELETE FROM quiz_questions WHERE item_id = $1 AND NOT (question_id = ANY($2::uuid[]))
    RETURNING question_id`,

  // ── Attempts and answers ────────────────────────────────────────────────

  //  How many students have turned the quiz in. $1 item_id
  countSubmitted: `SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE item_id = $1 AND submitted_at IS NOT NULL`,

  //  One student's attempt. $1 item_id, $2 student_id
  selectAttempt: `
    SELECT attempt_id, item_id, student_id, question_order, started_at, submitted_at, auto_score
    FROM quiz_attempts WHERE item_id = $1 AND student_id = $2`,
  lockAttempt: `
    SELECT attempt_id, item_id, student_id, question_order, started_at, submitted_at, auto_score
    FROM quiz_attempts WHERE item_id = $1 AND student_id = $2 FOR UPDATE`,
  lockAttemptById: `
    SELECT attempt_id, item_id, student_id, question_order, started_at, submitted_at, auto_score
    FROM quiz_attempts WHERE attempt_id = $1 FOR UPDATE`,

  //  The one attempt (v1), created once; a second start lands in the first.
  //  $1 item_id, $2 student_id, $3 question order (empty = the quiz's own order)
  insertAttempt: `
    INSERT INTO quiz_attempts (item_id, student_id, question_order) VALUES ($1, $2, $3::uuid[])
    ON CONFLICT (item_id, student_id) DO NOTHING`,

  //  $1 attempt_id, $2 auto_score
  markSubmitted: `UPDATE quiz_attempts SET submitted_at = NOW(), auto_score = $2 WHERE attempt_id = $1`,
  //  $1 attempt_id, $2 auto_score
  updateAutoScore: `UPDATE quiz_attempts SET auto_score = $2 WHERE attempt_id = $1`,

  //  One attempt's answers. $1 attempt_id
  selectAttemptAnswers: `
    SELECT qa.answer_id, qa.attempt_id, qa.question_id, qa.answer, qa.auto_points, qa.teacher_points, qa.teacher_note,
           qa.saved_at, qa.graded_by, qa.graded_at
    FROM quiz_answers qa WHERE qa.attempt_id = $1`,

  //  Every answer of the quiz's turned-in attempts (an answer-key change
  //  regrades them). $1 item_id
  selectSubmittedAnswers: `
    SELECT qa.answer_id, qa.attempt_id, qa.question_id, qa.answer, qa.auto_points, qa.teacher_points,
           qt.student_id
    FROM quiz_attempts qt
    JOIN quiz_answers qa ON qa.attempt_id = qt.attempt_id
    WHERE qt.item_id = $1 AND qt.submitted_at IS NOT NULL`,

  //  The turned-in attempts. $1 item_id
  selectSubmittedAttempts: `
    SELECT attempt_id, student_id, auto_score FROM quiz_attempts
    WHERE item_id = $1 AND submitted_at IS NOT NULL ORDER BY attempt_id`,

  //  An autosave: the answer replaces the last one. $1 attempt_id, $2 question ids, $3 answers (jsonb, NULL clears)
  saveAnswers: `
    INSERT INTO quiz_answers (attempt_id, question_id, answer, saved_at)
    SELECT $1, v.question_id, v.answer, NOW()
    FROM unnest($2::uuid[], $3::jsonb[]) AS v(question_id, answer)
    ON CONFLICT (attempt_id, question_id) DO UPDATE SET answer = EXCLUDED.answer, saved_at = NOW()
    RETURNING saved_at`,

  //  A row for every question the attempt has none for (left blank, or
  //  added after it was turned in), so each can be graded.
  //  $1 attempt_id, $2 question ids
  insertBlankAnswers: `
    INSERT INTO quiz_answers (attempt_id, question_id, answer)
    SELECT $1, unnest($2::uuid[]), NULL
    ON CONFLICT (attempt_id, question_id) DO NOTHING`,

  //  The machine's points, set in one statement. $1 answer ids, $2 points (NULL for written answers)
  setAutoPoints: `
    UPDATE quiz_answers qa SET auto_points = v.points
    FROM unnest($1::uuid[], $2::numeric[]) AS v(answer_id, points)
    WHERE qa.answer_id = v.answer_id`,

  //  The answer an override is for, with its attempt and question; the
  //  attempt is locked first (see the lock order). $1 answer_id
  selectAnswerTarget: `
    SELECT qa.answer_id, qa.attempt_id, qt.item_id, qt.student_id, qq.points AS question_points
    FROM quiz_answers qa
    JOIN quiz_attempts qt ON qt.attempt_id = qa.attempt_id
    JOIN quiz_questions qq ON qq.question_id = qa.question_id
    WHERE qa.answer_id = $1`,
  lockAnswer: `SELECT answer_id FROM quiz_answers WHERE answer_id = $1 FOR UPDATE`,

  //  A teacher's points (NULL clears the override) and note.
  //  $1 answer_id, $2 points, $3 set the note?, $4 note, $5 graded_by
  setTeacherPoints: `
    UPDATE quiz_answers
    SET teacher_points = $2, teacher_note = CASE WHEN $3::boolean THEN $4 ELSE teacher_note END,
        graded_by = $5, graded_at = NOW()
    WHERE answer_id = $1
    RETURNING answer_id`,

  //  requireClassroomResource('quizAnswer'): the answer's class, by the item
  //  of its attempt. $1 answer_id, $2 caller's user_id
  resourceQuizAnswer: `
    SELECT qa.answer_id, qa.attempt_id, i.item_id, i.class_id, c.school, c.teacher_id,
           EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $2) AS is_co_teacher
    FROM quiz_answers qa
    JOIN quiz_attempts qt ON qt.attempt_id = qa.attempt_id
    JOIN classwork_items i ON i.item_id = qt.item_id AND i.deleted_at IS NULL
    JOIN classes c ON c.class_id = i.class_id
    WHERE qa.answer_id = $1`,

  // ── The quiz's own score on the submission (fix round 1) ───────────────
  //
  // The quiz writes the score only while score_set_by_teacher is false: a
  // score a teacher typed (grading view, grid: grading.queries'
  // upsertDraftScore / syncLiveSubmission set the flag) always wins. These
  // writes leave the flag false.

  //  The quiz's draft. A changed draft is unpublished again (needs a Publish).
  //  $1 item_id, $2 student_id, $3 score, $4 status ('graded'), $5 graded_by
  writeQuizDraft: `
    INSERT INTO classwork_submissions (item_id, student_id, draft_score, draft_status, graded_by, score_set_by_teacher, updated_at)
    VALUES ($1, $2, $3::numeric, $4::text, $5, FALSE, NOW())
    ON CONFLICT (item_id, student_id) DO UPDATE
    SET draft_score = EXCLUDED.draft_score, draft_status = EXCLUDED.draft_status, graded_by = EXCLUDED.graded_by,
        score_set_by_teacher = FALSE,
        published_at = CASE WHEN (classwork_submissions.draft_score, classwork_submissions.draft_status)
                                 IS DISTINCT FROM (EXCLUDED.draft_score, EXCLUDED.draft_status)
                            THEN NULL ELSE classwork_submissions.published_at END,
        updated_at = NOW()`,

  //  The submission mirrors the quiz's live write on a published column
  //  (D17): the draft equals the cell and the work counts as published.
  //  $1 item_id, $2 student_id, $3 score, $4 status, $5 graded_by
  syncQuizLive: `
    UPDATE classwork_submissions
    SET draft_score = $3::numeric, draft_status = $4::text, graded_by = $5, score_set_by_teacher = FALSE,
        published_at = COALESCE(published_at, NOW()), published_by = COALESCE(published_by, $5), updated_at = NOW()
    WHERE item_id = $1 AND student_id = $2`,

  //  Back to the quiz's score: the teacher's typed score no longer wins. $1 item_id, $2 student_id
  clearTeacherScore: `
    UPDATE classwork_submissions SET score_set_by_teacher = FALSE, updated_at = NOW() WHERE item_id = $1 AND student_id = $2`,

  //  A turned-in attempt is new, unpublished work: whatever was published
  //  before (feedback, a confirmed Missing) no longer releases it (I1).
  //  $1 submission_id
  unpublishSubmission: `
    UPDATE classwork_submissions SET published_at = NULL, published_by = NULL, updated_at = NOW() WHERE submission_id = $1`,

  //  Whether this student's results are released: their work was published
  //  AFTER the attempt was turned in (an on-submit release stamps both with
  //  the transaction's instant, hence >=), and whether a teacher typed the
  //  score. Compared in SQL, to the microsecond. $1 item_id, $2 student_id
  selectRelease: `
    SELECT (qt.submitted_at IS NOT NULL AND sub.published_at IS NOT NULL AND sub.published_at >= qt.submitted_at) AS released,
           COALESCE(sub.score_set_by_teacher AND sub.draft_score IS NOT NULL, FALSE) AS score_set_by_teacher
    FROM quiz_attempts qt
    LEFT JOIN classwork_submissions sub ON sub.item_id = qt.item_id AND sub.student_id = qt.student_id
    WHERE qt.item_id = $1 AND qt.student_id = $2`,

  //  $1 item_id, $2 student_id
  selectScoreSetByTeacher: `
    SELECT COALESCE(score_set_by_teacher AND draft_score IS NOT NULL, FALSE) AS score_set_by_teacher
    FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`,

  //  The highest score in the quiz's column that a key change won't
  //  recompute: typed by a teacher, or held by a student with no turned-in
  //  attempt (a grade entered in the grid, a student the quiz isn't for).
  //  $1 item_id, $2 assessment_id
  selectKeptTop: `
    SELECT MAX(x.score)::float AS top FROM (
      SELECT sub.student_id, sub.draft_score AS score FROM classwork_submissions sub WHERE sub.item_id = $1
      UNION ALL
      SELECT sa.student_id, sa.score FROM student_assessments sa WHERE sa.assessment_id = $2
    ) x
    LEFT JOIN classwork_submissions s2 ON s2.item_id = $1 AND s2.student_id = x.student_id
    WHERE x.score IS NOT NULL
      AND (COALESCE(s2.score_set_by_teacher, FALSE)
           OR NOT EXISTS (SELECT 1 FROM quiz_attempts qt WHERE qt.item_id = $1 AND qt.student_id = x.student_id AND qt.submitted_at IS NOT NULL))`,

  //  Has any student started the quiz? $1 item_id
  selectHasAttempts: `SELECT EXISTS (SELECT 1 FROM quiz_attempts WHERE item_id = $1) AS has_attempts`,

  //  Has any student turned in, been graded or been published on this item? $1 item_id
  selectHasStudentWork: `
    SELECT EXISTS (SELECT 1 FROM classwork_submissions
                   WHERE item_id = $1 AND (turned_in_at IS NOT NULL OR published_at IS NOT NULL
                                           OR draft_score IS NOT NULL OR draft_status IS NOT NULL)) AS has_work`,

  // ── Copies (fix round 1) ────────────────────────────────────────────────

  //  The copy takes the source quiz's settings. $1 copy item_id, $2 source item_id
  copyQuizSettings: `
    UPDATE classwork_items t
    SET quiz_release = s.quiz_release, quiz_shuffle = s.quiz_shuffle, quiz_show_answers = s.quiz_show_answers
    FROM classwork_items s
    WHERE t.item_id = $1 AND s.item_id = $2`,

  //  A quiz's column takes the quiz's points as its "out of". $1 assessment_id, $2 max_score
  setColumnMax: `
    UPDATE assessments SET max_score = $2::numeric, last_modified_at = NOW()
    WHERE assessment_id = $1 AND max_score IS DISTINCT FROM $2::numeric
    RETURNING assessment_id`,
};

module.exports = quizQueries;
