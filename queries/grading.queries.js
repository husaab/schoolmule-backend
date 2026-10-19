// queries/grading.queries.js
//
// Grading turned-in work (spec D3, D17). A score for a turn-in column (an
// assessment linked to an assignment or quiz) waits as a draft on the
// student's classwork_submissions row until it is published; Publish copies
// it into student_assessments. Once the assessment is published, grid and
// grading-view edits write student_assessments live and keep the submission
// in step. Plain assessments never come here.
//
// Aliases: `i` item, `a` its assessment, `s` the student, `sub` the
// submission, `sa` the gradebook cell.

const { studentAvatarSql } = require('../utils/avatar');
const {
  GRADE_VISIBLE, TURN_IN_ITEM, WORK_STATE_SQL, WORK_JOINS, HAS_DRAFT, AWAITING_GRADE, UNLINKED_PUBLISHABLE, QUIZ_GRADED,
} = require('./workState');
const { ITEM_VISIBLE } = require('./classwork.queries');

// The item's students: the class roster (not archived), narrowed to the
// chosen students when the audience is "some". `i` is the item, `s` the student.
const IN_ITEM_AUDIENCE = `(i.audience = 'all' OR EXISTS (SELECT 1 FROM classwork_item_students x
                                         WHERE x.item_id = i.item_id AND x.student_id = s.student_id))`;

// A cell that holds a grade (a score, or a confirmed missing/excused).
const SA_HAS_GRADE = `(sa.score IS NOT NULL OR sa.status IN ('missing', 'excused'))`;

// HAS_DRAFT (a draft score or status) and AWAITING_GRADE (turned in, waiting
// for the teacher) live in workState.js, shared with ITEM_COUNTS.

// One grading row per student of item $1 ($2 = one student, NULL = all).
const GRADING_ROWS = `
SELECT s.student_id, s.name, ${studentAvatarSql('s')},
       sub.submission_id, sub.turned_in_at, COALESCE(sub.is_late, FALSE) AS sub_is_late, sub.text_answer,
       sub.draft_score, sub.draft_status, sub.feedback, sub.published_at AS sub_published_at,
       COALESCE(sub.score_set_by_teacher AND sub.draft_score IS NOT NULL, FALSE) AS score_set_by_teacher,
       (i.kind = 'quiz' AND NOT ${QUIZ_GRADED}) AS quiz_needs_review,
       ${WORK_STATE_SQL} AS work_status,
       ${GRADE_VISIBLE} AS grade_visible,
       CASE WHEN ${GRADE_VISIBLE} THEN sa.score END AS visible_score,
       CASE WHEN ${GRADE_VISIBLE} THEN sa.status END AS visible_status,
       CASE WHEN ${GRADE_VISIBLE} THEN COALESCE(sub.published_at, a.published_at) END AS visible_published_at,
       EXISTS (SELECT 1 FROM conversations cv WHERE cv.student_id = s.student_id AND cv.classwork_item_id = i.item_id) AS has_thread
FROM classwork_items i
LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
JOIN class_students cs ON cs.class_id = i.class_id
JOIN students s ON s.student_id = cs.student_id AND s.is_archived IS NOT TRUE
${WORK_JOINS('s.student_id')}
WHERE i.item_id = $1 AND ($2::uuid IS NULL OR s.student_id = $2::uuid) AND ${IN_ITEM_AUDIENCE}
ORDER BY s.name, s.student_id`;

const gradingQueries = {
  IN_ITEM_AUDIENCE,
  HAS_DRAFT,
  AWAITING_GRADE,

  // ── Grading view ───────────────────────────────────────────────────────

  //  The item and its gradebook column. $1 item_id
  selectGradingItem: `
    SELECT i.item_id, i.class_id, i.kind, i.submission_mode, i.assessment_id,
           a.max_score, COALESCE(a.is_published, FALSE) AS is_published
    FROM classwork_items i
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    WHERE i.item_id = $1 AND i.deleted_at IS NULL`,

  //  $1 item_id, $2 student_id|null
  selectGradingRows: GRADING_ROWS,

  //  Of these students, the ones the item is for (roster, not archived, audience). $1 item_id, $2 student_id[]
  selectAudienceIds: `
    SELECT s.student_id
    FROM classwork_items i
    JOIN class_students cs ON cs.class_id = i.class_id
    JOIN students s ON s.student_id = cs.student_id AND s.is_archived IS NOT TRUE
    WHERE i.item_id = $1 AND s.student_id = ANY($2::uuid[]) AND ${IN_ITEM_AUDIENCE}`,

  //  Every student the item is for. $1 item_id
  selectAllAudienceIds: `
    SELECT s.student_id
    FROM classwork_items i
    JOIN class_students cs ON cs.class_id = i.class_id
    JOIN students s ON s.student_id = cs.student_id AND s.is_archived IS NOT TRUE
    WHERE i.item_id = $1 AND ${IN_ITEM_AUDIENCE}`,

  //  Locks the column's publish state, so a draft-or-live decision cannot race
  //  a publish (every writer locks the assessment before submissions).
  //  $1 assessment_id
  lockAssessmentShare: `SELECT is_published FROM assessments WHERE assessment_id = $1 FOR SHARE`,
  lockAssessmentUpdate: `SELECT is_published FROM assessments WHERE assessment_id = $1 FOR UPDATE`,

  //  The submission a grade is written on, created when missing (the teacher
  //  may grade work never opened online), then locked. $1 item_id, $2 student_id
  ensureSubmission: `
    INSERT INTO classwork_submissions (item_id, student_id) VALUES ($1, $2)
    ON CONFLICT (item_id, student_id) DO NOTHING`,
  lockSubmission: `
    SELECT sub.submission_id, sub.draft_score, sub.draft_status, sub.feedback, sub.published_at, sub.score_set_by_teacher,
           sa.score AS live_score, sa.status AS live_status,
           (sa.student_id IS NOT NULL AND ${SA_HAS_GRADE}) AS live_has_grade
    FROM classwork_submissions sub
    JOIN classwork_items i ON i.item_id = sub.item_id
    LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = sub.student_id
    WHERE sub.item_id = $1 AND sub.student_id = $2
    FOR UPDATE OF sub`,

  //  A teacher's draft write (the grading view, the grid). A cleared cell
  //  (no score, no flag) is no draft at all, unless the gradebook still holds
  //  a grade for the student (a column unpublished after a publish): then it
  //  is an explicit clear for the next Publish. A changed draft is
  //  unpublished again (it needs a Publish). A typed score marks the
  //  submission score_set_by_teacher: on a quiz it then wins over the quiz's
  //  own score (T23 fix round 1); the quiz writes through quiz.queries.
  //  $1 item_id, $2 student_id, $3 score|null, $4 status|null, $5 graded_by
  upsertDraftScore: `
    WITH v AS (
      SELECT $3::numeric AS score,
             CASE WHEN $3::numeric IS NULL AND COALESCE($4::text, 'graded') = 'graded'
                       AND NOT EXISTS (SELECT 1 FROM student_assessments sa JOIN classwork_items i ON i.assessment_id = sa.assessment_id
                                        WHERE i.item_id = $1 AND sa.student_id = $2 AND ${SA_HAS_GRADE})
                  THEN NULL ELSE COALESCE($4::text, 'graded') END AS status
    )
    INSERT INTO classwork_submissions (item_id, student_id, draft_score, draft_status, graded_by, score_set_by_teacher, updated_at)
    SELECT $1, $2, v.score, v.status, $5, v.score IS NOT NULL, NOW() FROM v
    ON CONFLICT (item_id, student_id) DO UPDATE
    SET draft_score = EXCLUDED.draft_score, draft_status = EXCLUDED.draft_status, graded_by = EXCLUDED.graded_by,
        score_set_by_teacher = EXCLUDED.score_set_by_teacher,
        published_at = CASE WHEN (classwork_submissions.draft_score, classwork_submissions.draft_status)
                                 IS DISTINCT FROM (EXCLUDED.draft_score, EXCLUDED.draft_status)
                            THEN NULL ELSE classwork_submissions.published_at END,
        updated_at = NOW()
    RETURNING student_id, draft_score, draft_status`,

  //  Un-excuse puts a draft score back (upsertDraftScore's rules) with the
  //  typed flag given, not inferred: a restored score is only "typed by a
  //  teacher" when it was before the excuse (T23 fix round 2).
  //  $1 item_id, $2 student_id, $3 score|null, $4 status|null, $5 graded_by, $6 typed by a teacher
  restoreDraftScore: `
    WITH v AS (
      SELECT $3::numeric AS score,
             CASE WHEN $3::numeric IS NULL AND COALESCE($4::text, 'graded') = 'graded'
                       AND NOT EXISTS (SELECT 1 FROM student_assessments sa JOIN classwork_items i ON i.assessment_id = sa.assessment_id
                                        WHERE i.item_id = $1 AND sa.student_id = $2 AND ${SA_HAS_GRADE})
                  THEN NULL ELSE COALESCE($4::text, 'graded') END AS status
    )
    INSERT INTO classwork_submissions (item_id, student_id, draft_score, draft_status, graded_by, score_set_by_teacher, updated_at)
    SELECT $1, $2, v.score, v.status, $5, $6::boolean AND v.score IS NOT NULL, NOW() FROM v
    ON CONFLICT (item_id, student_id) DO UPDATE
    SET draft_score = EXCLUDED.draft_score, draft_status = EXCLUDED.draft_status, graded_by = EXCLUDED.graded_by,
        score_set_by_teacher = EXCLUDED.score_set_by_teacher,
        published_at = CASE WHEN (classwork_submissions.draft_score, classwork_submissions.draft_status)
                                 IS DISTINCT FROM (EXCLUDED.draft_score, EXCLUDED.draft_status)
                            THEN NULL ELSE classwork_submissions.published_at END,
        updated_at = NOW()
    RETURNING student_id, draft_score, draft_status`,

  //  The submission mirrors a teacher's live gradebook write (the assessment
  //  is published): the draft equals the cell and the work counts as
  //  published. A cleared cell (no score, no flag) is no draft, so the work
  //  is back in To review. A typed score marks score_set_by_teacher (see
  //  upsertDraftScore). $1 item_id, $2 student_id, $3 score|null, $4 status, $5 graded_by
  syncLiveSubmission: `
    INSERT INTO classwork_submissions (item_id, student_id, draft_score, draft_status, graded_by, published_at, published_by,
                                       score_set_by_teacher, updated_at)
    VALUES ($1, $2, $3::numeric,
            CASE WHEN $3::numeric IS NULL AND COALESCE($4::text, 'graded') = 'graded' THEN NULL ELSE $4::text END,
            $5, NOW(), $5, $3::numeric IS NOT NULL, NOW())
    ON CONFLICT (item_id, student_id) DO UPDATE
    SET draft_score = EXCLUDED.draft_score, draft_status = EXCLUDED.draft_status, graded_by = EXCLUDED.graded_by,
        score_set_by_teacher = EXCLUDED.score_set_by_teacher,
        published_at = COALESCE(classwork_submissions.published_at, NOW()),
        published_by = COALESCE(classwork_submissions.published_by, EXCLUDED.published_by),
        updated_at = NOW()`,

  //  A live cell write, as the grid's upsert does. $1 student_id, $2 assessment_id, $3 score|null, $4 status
  upsertStudentAssessment: `
    INSERT INTO student_assessments (student_id, assessment_id, score, status)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (student_id, assessment_id) DO UPDATE SET score = EXCLUDED.score, status = EXCLUDED.status
    RETURNING student_id, assessment_id, score, status`,

  //  The files of one submission, with their storage paths (signed by the caller). $1 submission_id
  selectSubmissionFiles: `
    SELECT file_id, file_path, file_name, mime_type, size_bytes FROM submission_files
    WHERE submission_id = $1 ORDER BY created_at, file_id`,

  //  One student's current draft (status changes keep the draft score). $1 item_id, $2 student_id
  selectDraft: `
    SELECT draft_score, draft_status FROM classwork_submissions WHERE item_id = $1 AND student_id = $2`,

  //  $1 submission_id, $2 feedback|null
  saveFeedback: `
    UPDATE classwork_submissions SET feedback = $2, feedback_saved_at = NOW(), updated_at = NOW()
    WHERE submission_id = $1`,

  // ── Publish (services/classroom/publish.js) ────────────────────────────

  //  The drafts a Publish copies, locked. $2 NULL = every pending draft
  //  ("Publish to N students": not published yet, or the column is
  //  unpublished); a list = those students, published again even when
  //  already published (a re-publish after a regrade). Only students the
  //  item is for. An unlinked item publishes its feedback (a quiz's results
  //  too: UNLINKED_PUBLISHABLE).
  //  $1 item_id, $2 student_id[]|null, $3 linked to a gradebook column
  lockPublishable: `
    SELECT sub.submission_id, sub.student_id, sub.draft_score, sub.draft_status
    FROM classwork_submissions sub
    JOIN classwork_items i ON i.item_id = sub.item_id
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sub.student_id
    JOIN students s ON s.student_id = sub.student_id AND s.is_archived IS NOT TRUE
    WHERE sub.item_id = $1
      AND ($2::uuid[] IS NULL OR sub.student_id = ANY($2::uuid[]))
      AND ($2::uuid[] IS NOT NULL OR sub.published_at IS NULL
           OR (i.assessment_id IS NOT NULL AND NOT COALESCE(a.is_published, FALSE)))
      -- A listed student already published, with nothing changed since (no
      -- regrade, no new feedback): publishing again would only re-send the email.
      AND NOT ($2::uuid[] IS NOT NULL AND sub.published_at IS NOT NULL AND sub.updated_at <= sub.published_at
               AND (i.assessment_id IS NULL OR COALESCE(a.is_published, FALSE)))
      AND ${IN_ITEM_AUDIENCE}
      AND (${HAS_DRAFT} OR (NOT $3::boolean AND ${UNLINKED_PUBLISHABLE}))
    ORDER BY sub.student_id
    FOR UPDATE OF sub`,

  //  Of these students, the ones holding something to publish (a draft, or
  //  feedback on an item with no column), to tell "unchanged" from "no draft".
  //  $1 item_id, $2 student_id[], $3 linked to a gradebook column
  selectPublishHolders: `
    SELECT sub.student_id FROM classwork_submissions sub
    JOIN classwork_items i ON i.item_id = sub.item_id
    WHERE sub.item_id = $1 AND sub.student_id = ANY($2::uuid[])
      AND (${HAS_DRAFT} OR (NOT $3::boolean AND ${UNLINKED_PUBLISHABLE}))`,

  //  Spec D3, for an unpublished column only: the gradebook cells of the
  //  item's students become drafts on their submissions (a turn-in item took
  //  the column over, or its first Publish is for some students only), so
  //  nothing of theirs shows before that student is published. A newer draft
  //  wins over the cell. Students outside the item's audience keep their
  //  cells: they are graded like a plain assessment (fix round 3).
  //  $3 = students whose cells stay (the ones being published).
  //  $1 item_id, $2 assessment_id, $3 student_id[]
  moveCellsToDrafts: `
    WITH moved AS (
      DELETE FROM student_assessments sa
      WHERE sa.assessment_id = $2 AND NOT (sa.student_id = ANY($3::uuid[]))
        AND (sa.score IS NOT NULL OR sa.status IN ('missing', 'excused'))
        AND EXISTS (SELECT 1 FROM assessments a WHERE a.assessment_id = $2 AND NOT COALESCE(a.is_published, FALSE))
        AND EXISTS (SELECT 1 FROM classwork_items i
                      JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sa.student_id
                      JOIN students s ON s.student_id = sa.student_id AND s.is_archived IS NOT TRUE
                     WHERE i.item_id = $1 AND ${IN_ITEM_AUDIENCE})
      RETURNING sa.student_id, sa.score, sa.status
    )
    INSERT INTO classwork_submissions (item_id, student_id, draft_score, draft_status, score_set_by_teacher, updated_at)
    SELECT $1, m.student_id, CASE WHEN m.status = 'missing' THEN NULL ELSE m.score END, m.status,
           m.status <> 'missing' AND m.score IS NOT NULL, NOW() FROM moved m
    ON CONFLICT (item_id, student_id) DO UPDATE
    SET draft_score = CASE WHEN classwork_submissions.draft_score IS NULL AND classwork_submissions.draft_status IS NULL
                           THEN EXCLUDED.draft_score ELSE classwork_submissions.draft_score END,
        score_set_by_teacher = CASE WHEN classwork_submissions.draft_score IS NULL AND classwork_submissions.draft_status IS NULL
                                    THEN EXCLUDED.score_set_by_teacher ELSE classwork_submissions.score_set_by_teacher END,
        draft_status = CASE WHEN classwork_submissions.draft_score IS NULL AND classwork_submissions.draft_status IS NULL
                            THEN EXCLUDED.draft_status ELSE classwork_submissions.draft_status END,
        published_at = NULL,
        updated_at = NOW()`,

  //  Grades in the column for students of the class outside the item's
  //  audience (graded like a plain assessment). A per-student Publish can't
  //  publish the column while there are any: it would show them too.
  //  $1 item_id
  countOutsideGrades: `
    SELECT COUNT(*)::int AS n
    FROM classwork_items i
    JOIN student_assessments sa ON sa.assessment_id = i.assessment_id
    JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sa.student_id
    JOIN students s ON s.student_id = sa.student_id AND s.is_archived IS NOT TRUE
    WHERE i.item_id = $1 AND ${SA_HAS_GRADE} AND NOT ${IN_ITEM_AUDIENCE}`,

  //  The (item, student) pairs, among these, where the student is one the
  //  item is for. $1 item_id[], $2 student_id[]
  selectAudiencePairs: `
    SELECT i.item_id, s.student_id
    FROM classwork_items i
    JOIN class_students cs ON cs.class_id = i.class_id
    JOIN students s ON s.student_id = cs.student_id AND s.is_archived IS NOT TRUE
    WHERE i.item_id = ANY($1::uuid[]) AND s.student_id = ANY($2::uuid[]) AND ${IN_ITEM_AUDIENCE}`,

  //  After an audience change (publish.reconcileAudience), the students of
  //  the class the item is no longer for are graded like a plain assessment.
  //
  //  Those taken off the item by this edit who hold a draft not published
  //  yet, on a published column: making it their gradebook cell would show
  //  it with no Publish (D3), so the change is refused while there are any
  //  (fix round 4). Only this edit's students are checked (round 5): a
  //  student who was off the roster or archived at an earlier change isn't
  //  in the grading view, and their draft is left as it is.
  //  $1 item_id, $2 the students the item was for before the edit (NULL = the whole class)
  selectUnpublishedDraftsOutside: `
    SELECT s.student_id, s.name
    FROM classwork_submissions sub
    JOIN classwork_items i ON i.item_id = sub.item_id
    JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sub.student_id
    JOIN students s ON s.student_id = sub.student_id AND s.is_archived IS NOT TRUE
    WHERE sub.item_id = $1 AND sub.published_at IS NULL AND ${HAS_DRAFT} AND NOT ${IN_ITEM_AUDIENCE}
      AND ($2::uuid[] IS NULL OR sub.student_id = ANY($2::uuid[]))
    ORDER BY s.name, s.student_id`,
  //  On an unpublished column only, their drafts become their gradebook
  //  cells (released by the column's Publish in Grades, as on main). On a
  //  published column the cell already holds what was published, and is
  //  never written here. Students off the roster or archived are left alone,
  //  as they are when they leave the class. $1 item_id
  draftsOutsideToCells: `
    INSERT INTO student_assessments (student_id, assessment_id, score, status)
    SELECT sub.student_id, i.assessment_id,
           CASE WHEN sub.draft_status = 'missing' THEN NULL ELSE sub.draft_score END, COALESCE(sub.draft_status, 'graded')
    FROM classwork_submissions sub
    JOIN classwork_items i ON i.item_id = sub.item_id
    JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sub.student_id
    JOIN students s ON s.student_id = sub.student_id AND s.is_archived IS NOT TRUE
    WHERE sub.item_id = $1 AND NOT COALESCE(a.is_published, FALSE) AND ${HAS_DRAFT} AND NOT ${IN_ITEM_AUDIENCE}
    ON CONFLICT (student_id, assessment_id) DO UPDATE SET score = EXCLUDED.score, status = EXCLUDED.status`,
  //  Then the drafts moved to the cell above, and the drafts already
  //  published (a copy of the cell, which a later edit of the plain cell
  //  would leave stale), are cleared. published_at is kept: a grade and
  //  feedback already published stay published (round 5). An unpublished
  //  draft on a published column is never cleared. $1 item_id
  clearDraftsOutside: `
    UPDATE classwork_submissions sub SET draft_score = NULL, draft_status = NULL, updated_at = NOW()
    FROM classwork_items i, assessments a, class_students cs, students s
    WHERE sub.item_id = $1 AND i.item_id = sub.item_id AND a.assessment_id = i.assessment_id AND ${HAS_DRAFT}
      AND (NOT COALESCE(a.is_published, FALSE) OR sub.published_at IS NOT NULL)
      AND cs.class_id = i.class_id AND cs.student_id = sub.student_id
      AND s.student_id = sub.student_id AND s.is_archived IS NOT TRUE AND NOT ${IN_ITEM_AUDIENCE}`,

  //  Before an unpublished column's first Publish for some students: the
  //  other students' earlier publishes (from before the column was
  //  unpublished in the gradebook) are withdrawn, so their feedback stays
  //  hidden too. $1 item_id, $2 student_id[] (the ones being published)
  withdrawOthers: `
    UPDATE classwork_submissions SET published_at = NULL, updated_at = NOW()
    WHERE item_id = $1 AND published_at IS NOT NULL AND NOT (student_id = ANY($2::uuid[]))`,

  //  $1 submission_id[], $2 published_by
  markSubmissionsPublished: `
    UPDATE classwork_submissions SET published_at = NOW(), published_by = $2, updated_at = NOW()
    WHERE submission_id = ANY($1::uuid[])`,

  //  Sets one student's draft status (Mark missing, Excuse), keeping the
  //  draft score (else the gradebook's) except for missing, as the grid's
  //  status menu does. Created when missing. Missing has no score, so no
  //  score typed by a teacher either (score_set_by_teacher cleared, T23).
  //  $1 item_id, $2 student_id, $3 status, $4 graded_by
  setDraftStatus: `
    INSERT INTO classwork_submissions (item_id, student_id, draft_score, draft_status, graded_by, updated_at)
    VALUES ($1, $2,
            CASE WHEN $3::text = 'missing' THEN NULL
                 ELSE (SELECT sa.score FROM student_assessments sa JOIN classwork_items i ON i.assessment_id = sa.assessment_id
                        WHERE i.item_id = $1 AND sa.student_id = $2) END,
            $3::text, $4, NOW())
    ON CONFLICT (item_id, student_id) DO UPDATE
    SET draft_score = CASE WHEN EXCLUDED.draft_status = 'missing' THEN NULL
                           ELSE COALESCE(classwork_submissions.draft_score, EXCLUDED.draft_score) END,
        score_set_by_teacher = CASE WHEN EXCLUDED.draft_status = 'missing' THEN FALSE
                                    ELSE classwork_submissions.score_set_by_teacher END,
        draft_status = EXCLUDED.draft_status, graded_by = EXCLUDED.graded_by, updated_at = NOW()`,

  //  Of these students, the ones excused on this item (as a draft, or in the
  //  gradebook), with their draft score. $1 item_id, $2 student_id[]
  selectExcused: `
    SELECT s.student_id, COALESCE(sub.draft_score, sa.score) AS draft_score,
           (sa.student_id IS NOT NULL AND sa.status = 'excused') AS live_excused,
           COALESCE(sub.score_set_by_teacher AND sub.draft_score IS NOT NULL, FALSE) AS score_set_by_teacher
    FROM classwork_items i
    JOIN students s ON s.student_id = ANY($2::uuid[])
    LEFT JOIN classwork_submissions sub ON sub.item_id = i.item_id AND sub.student_id = s.student_id
    LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = s.student_id
    WHERE i.item_id = $1 AND (sub.draft_status = 'excused' OR sa.status = 'excused')`,

  //  The live turn-in items among these columns (publishAssessments).
  //  $1 class_id, $2 assessment_id[]
  selectTurnInItemsForAssessments: `
    SELECT i.item_id, i.class_id, i.assessment_id, i.kind
    FROM classwork_items i
    WHERE i.class_id = $1 AND i.assessment_id = ANY($2::uuid[]) AND i.kind IN ('assignment', 'quiz') AND i.deleted_at IS NULL`,

  //  Every pending draft on the class's turn-in columns, as the score rows a
  //  Publish would write (publishAssessments' preview, cascade and digest).
  //  $1 class_id
  selectPendingDrafts: `
    SELECT sub.student_id, i.assessment_id, sub.draft_score, sub.draft_status
    FROM classwork_items i
    JOIN classwork_submissions sub ON sub.item_id = i.item_id
    JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sub.student_id
    JOIN students s ON s.student_id = sub.student_id AND s.is_archived IS NOT TRUE
    WHERE i.class_id = $1 AND i.assessment_id IS NOT NULL AND i.kind IN ('assignment', 'quiz') AND i.deleted_at IS NULL
      AND sub.published_at IS NULL AND ${HAS_DRAFT} AND ${IN_ITEM_AUDIENCE}`,

  // ── The gradebook grid (studentAssessment.controller) ──────────────────

  //  Which of these columns are turn-in columns, and whether each is published.
  //  $1 class_id, $2 assessment_id[]
  selectTurnInColumns: `
    SELECT i.item_id, i.assessment_id, a.is_published
    FROM classwork_items i
    JOIN assessments a ON a.assessment_id = i.assessment_id
    WHERE i.class_id = $1 AND i.assessment_id = ANY($2::uuid[]) AND i.kind IN ('assignment', 'quiz') AND i.deleted_at IS NULL`,
  //  The same, with the columns locked (the grading writers' order: the
  //  assessment before the submissions), so a draft-or-live decision can't
  //  race a Publish. $1 class_id, $2 assessment_id[]
  lockTurnInColumns: `
    SELECT i.item_id, i.assessment_id, a.is_published
    FROM classwork_items i
    JOIN assessments a ON a.assessment_id = i.assessment_id
    WHERE i.class_id = $1 AND i.assessment_id = ANY($2::uuid[]) AND i.kind IN ('assignment', 'quiz') AND i.deleted_at IS NULL
    ORDER BY a.assessment_id
    FOR SHARE OF a`,

  //  The grid's classwork layer: the class's turn-in columns, and per student
  //  a pending draft, work turned in and awaiting a grade, or work missing by
  //  its due date with nothing published yet. $1 class_id
  selectOverlayItems: `
    SELECT i.item_id, i.assessment_id, i.kind, i.submission_mode
    FROM classwork_items i
    WHERE i.class_id = $1 AND i.assessment_id IS NOT NULL AND i.kind IN ('assignment', 'quiz') AND i.deleted_at IS NULL
    ORDER BY i.created_at, i.item_id`,
  selectOverlayCells: `
    SELECT * FROM (
    SELECT s.student_id, s.name, i.created_at, i.item_id, i.assessment_id, sub.draft_score, sub.draft_status,
           (sub.turned_in_at IS NOT NULL AND COALESCE(sub.is_late, FALSE)) AS is_late,
           CASE
             WHEN sub.published_at IS NULL AND ${HAS_DRAFT} THEN 'draft'
             WHEN ${AWAITING_GRADE} THEN 'turned_in'
             WHEN ${WORK_STATE_SQL} = 'missing' AND NOT ${GRADE_VISIBLE} AND ${ITEM_VISIBLE('i', 'a', 's')} THEN 'missing_derived'
           END AS state
    FROM classwork_items i
    JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN class_students cs ON cs.class_id = i.class_id
    JOIN students s ON s.student_id = cs.student_id AND s.is_archived IS NOT TRUE
    ${WORK_JOINS('s.student_id')}
    WHERE i.class_id = $1 AND i.kind IN ('assignment', 'quiz') AND i.deleted_at IS NULL AND ${IN_ITEM_AUDIENCE}
    ) c
    WHERE c.state IS NOT NULL
    ORDER BY c.name, c.student_id, c.created_at, c.item_id`,
};

// Turned in and awaiting a grade on a live turn-in item of class `cls`, from
// students the item is for (CARD_TO_REVIEW, TO_REVIEW).
const AWAITING_FROM = (cls) => `
  FROM classwork_items i
  JOIN classwork_submissions sub ON sub.item_id = i.item_id
  JOIN class_students cs ON cs.class_id = i.class_id AND cs.student_id = sub.student_id
  JOIN students s ON s.student_id = sub.student_id AND s.is_archived IS NOT TRUE
  LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
  LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = sub.student_id
  WHERE i.class_id = ${cls} AND i.deleted_at IS NULL AND ${TURN_IN_ITEM} AND ${IN_ITEM_AUDIENCE} AND ${AWAITING_GRADE}`;

module.exports = gradingQueries;
module.exports.AWAITING_FROM = AWAITING_FROM;
