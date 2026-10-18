// queries/classworkSubmission.queries.js
//
// A student's own classwork: the items they can see with their work status,
// their submission (typed answer, files, turn in) and the read-model counts.
// Every query is keyed on one student row ($1, the caller's own
// req.student.studentId, or a child the parent owns): nothing here returns a
// classmate's work. A grade leaves the database only when it is visible
// (spec 0.8), so a score on an unpublished assessment is never selected.
//
// Aliases: `i` item, `a` its assessment, `sub` the student's submission, `sa`
// the student's gradebook cell, `c` the class, `ro` the roster row, `tu` the
// class's lead teacher (when the account is live).

const { ITEM_VISIBLE } = require('./classwork.queries');
const { inCurrentTerm } = require('./termScope');
const { GRADE_VISIBLE, TURN_IN_ITEM, WORK_STATE_SQL, WORK_LATE_SQL, WORK_JOINS } = require('./workState');

// One work row: the item, the student's status, and the grade only when visible.
const WORK_COLUMNS = `
  i.item_id, i.class_id, i.kind, i.submission_mode, i.topic_id, COALESCE(a.name, i.title) AS title,
  i.due_at, TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
  COALESCE(i.posted_at, CASE WHEN i.status = 'scheduled' AND i.publish_at <= NOW() THEN i.publish_at END) AS posted_at,
  i.assessment_id, a.max_score,
  ${GRADE_VISIBLE} AS grade_visible,
  CASE WHEN ${GRADE_VISIBLE} THEN sa.score END AS grade_score,
  CASE WHEN ${GRADE_VISIBLE} THEN sa.status END AS grade_status,
  CASE WHEN ${GRADE_VISIBLE} THEN COALESCE(sub.published_at, a.published_at) END AS grade_published_at,
  sub.turned_in_at, sub.is_late AS sub_is_late,
  ${WORK_STATE_SQL} AS work_status,
  ${WORK_LATE_SQL} AS is_late,
  CASE WHEN i.kind = 'quiz' THEN (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.item_id = i.item_id)::int ELSE 0 END AS question_count,
  c.subject, c.grade::text AS grade, c.banner_key, c.banner_path, c.icon_key, c.color,
  tu.user_id AS teacher_id, tu.avatar AS teacher_avatar, tu.photo_path AS teacher_photo_path,
  COALESCE(NULLIF(TRIM(CONCAT(tu.first_name, ' ', tu.last_name)), ''), c.teacher_name) AS teacher_name`;

// The student's items: on the roster, the class live and in the school, the
// item visible to them (ITEM_VISIBLE). `ro` carries the student id.
const WORK_FROM = `
FROM class_students ro
JOIN classes c ON c.class_id = ro.class_id
JOIN classwork_items i ON i.class_id = c.class_id
LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
${WORK_JOINS('ro.student_id')}
LEFT JOIN users tu ON tu.user_id = c.teacher_id AND tu.is_archived IS NOT TRUE`;

const WORK_WHERE = `ro.student_id = $1 AND c.school = $2 AND c.archived_at IS NULL AND ${ITEM_VISIBLE('i', 'a', 'ro')}`;

const classworkSubmissionQueries = {
  GRADE_VISIBLE,
  TURN_IN_ITEM,
  WORK_STATE_SQL,
  WORK_LATE_SQL,
  WORK_JOINS,

  // ── Reads ──────────────────────────────────────────────────────────────

  //  The student's visible items with their status: one class ($3), or (when
  //  $3 is NULL) every live class of the year in the current term (the
  //  classes the student's home lists).
  //  $1 student_id, $2 school, $3 class_id|null, $4 school_year_id|null,
  //  $5 current term_id|null, $6 current term name|null
  selectStudentWork: `
SELECT ${WORK_COLUMNS}
${WORK_FROM}
WHERE ${WORK_WHERE}
  AND ($3::uuid IS NULL OR c.class_id = $3::uuid)
  AND ($3::uuid IS NOT NULL OR (($4::uuid IS NULL OR c.school_year_id = $4::uuid) AND ${inCurrentTerm('c', '$5', '$6')}))
ORDER BY i.sort_order, COALESCE(i.posted_at, i.publish_at, i.created_at) DESC, i.created_at DESC, i.item_id`,

  //  One item the student can see, with what the item page needs. closed:
  //  past due in a class that takes no late work. parents_can_read: the
  //  school lets guardians read messages about a piece of work
  //  (parents_read_private_comments; no settings row = the default, yes).
  //  $1 student_id, $2 school, $3 item_id
  selectStudentItem: `
SELECT ${WORK_COLUMNS},
       i.instructions, c.accept_late,
       ${TURN_IN_ITEM} AS turn_in,
       CASE WHEN sub.published_at IS NOT NULL AND (i.assessment_id IS NULL OR COALESCE(a.is_published, FALSE))
            THEN sub.feedback END AS visible_feedback,
       sub.published_at AS sub_published_at,
       (i.due_at IS NOT NULL AND NOW() > i.due_at AND NOT c.accept_late) AS closed,
       sub.submission_id, sub.text_answer, sub.text_saved_at,
       COALESCE((SELECT scs.parents_read_private_comments FROM school_classroom_settings scs
                  WHERE scs.school = c.school), TRUE) AS parents_can_read
${WORK_FROM}
WHERE ${WORK_WHERE} AND i.item_id = $3::uuid`,

  //  The confirmed + derived missing count per class. $1 student_id, $2 school, $3 class ids
  selectMissingByClass: `
SELECT i.class_id, COUNT(*)::int AS n
${WORK_FROM}
WHERE ${WORK_WHERE} AND c.class_id = ANY($3::uuid[]) AND ${WORK_STATE_SQL} = 'missing'
GROUP BY i.class_id`,

  //  A file of the student's own submission on an item they can still see.
  //  $1 file_id, $2 student_id, $3 school
  selectOwnFile: `
SELECT f.file_id, f.file_path, f.file_name, f.mime_type, f.size_bytes, s.submission_id, s.item_id
FROM submission_files f
JOIN classwork_submissions s ON s.submission_id = f.submission_id
JOIN classwork_items i ON i.item_id = s.item_id
LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
JOIN classes c ON c.class_id = i.class_id
WHERE f.file_id = $1 AND s.student_id = $2 AND c.school = $3 AND c.archived_at IS NULL
  AND ${ITEM_VISIBLE('i', 'a', 's')}`,

  //  $1 submission_id
  selectSubmissionFiles: `
SELECT file_id, file_name, mime_type, size_bytes FROM submission_files
WHERE submission_id = $1 ORDER BY created_at, file_id`,

  countSubmissionFiles: `SELECT COUNT(*)::int AS n FROM submission_files WHERE submission_id = $1`,

  // ── Writes (keyed on item × the caller's own student row) ──────────────

  //  First open: the row is created, or a row the teacher started gets its
  //  opened_at. A later open changes nothing. $1 item_id, $2 student_id
  openSubmission: `
INSERT INTO classwork_submissions (item_id, student_id, opened_at) VALUES ($1, $2, NOW())
ON CONFLICT (item_id, student_id) DO UPDATE SET opened_at = NOW(), updated_at = NOW()
WHERE classwork_submissions.opened_at IS NULL`,

  //  The row a write works on, created when missing, then locked.
  //  $1 item_id, $2 student_id
  ensureSubmission: `
INSERT INTO classwork_submissions (item_id, student_id, opened_at) VALUES ($1, $2, NOW())
ON CONFLICT (item_id, student_id) DO NOTHING`,
  lockSubmission: `
SELECT submission_id, turned_in_at, is_late, text_answer FROM classwork_submissions
WHERE item_id = $1 AND student_id = $2 FOR UPDATE`,

  //  $1 submission_id, $2 text (NULL clears)
  saveText: `
UPDATE classwork_submissions SET text_answer = $2, text_saved_at = NOW(), updated_at = NOW()
WHERE submission_id = $1 RETURNING text_saved_at`,

  //  clock_timestamp(), not NOW(): files added in one request keep their order.
  //  $1 submission_id, $2 file_path, $3 file_name, $4 mime_type, $5 size_bytes, $6 uploaded_by
  insertSubmissionFile: `
INSERT INTO submission_files (submission_id, file_path, file_name, mime_type, size_bytes, uploaded_by, created_at)
VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
RETURNING file_id`,

  //  $1 file_id, $2 submission_id
  deleteSubmissionFile: `
DELETE FROM submission_files WHERE file_id = $1 AND submission_id = $2 RETURNING file_path`,

  touchSubmission: `UPDATE classwork_submissions SET updated_at = NOW() WHERE submission_id = $1`,

  //  Turn in now; late when past the due time (NOW() is the transaction's).
  //  $1 submission_id
  turnIn: `
UPDATE classwork_submissions s
SET turned_in_at = NOW(), first_turned_in_at = COALESCE(s.first_turned_in_at, NOW()),
    is_late = (i.due_at IS NOT NULL AND NOW() > i.due_at), updated_at = NOW()
FROM classwork_items i
WHERE s.submission_id = $1 AND i.item_id = s.item_id`,

  //  Back to the student; first_turned_in_at stays. $1 submission_id
  unsubmit: `
UPDATE classwork_submissions SET turned_in_at = NULL, is_late = FALSE, updated_at = NOW()
WHERE submission_id = $1`,
};

module.exports = classworkSubmissionQueries;
