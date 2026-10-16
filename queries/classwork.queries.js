// queries/classwork.queries.js
//
// Classwork: items (assessment, assignment, quiz, material), topics, the
// "some students" audience and attachments. A linked item's name, date and
// points live on its gradebook assessment (`a`); `i.title` is only for items
// with no column. Aliases: `i` item, `a` its assessment, `p` the category.

const { GRADE_RANK } = require('../utils/gradeRank');

// An ISO-8601 UTC string from a timestamptz, for values built inside JSON.
const ISO = (expr) => `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const TORONTO_TODAY = `(NOW() AT TIME ZONE 'America/Toronto')::date`;

// Live for readers: posted, or scheduled and past its publish time (the
// scheduler may not have promoted it yet).
const EFFECTIVE_POSTED = (i = 'i') => `(${i}.status = 'posted' OR (${i}.status = 'scheduled' AND ${i}.publish_at <= NOW()))`;

// The day an item falls on: the Toronto date of its due time, else the
// gradebook date (plain assessments are dated, not due).
const ITEM_DAY = (i = 'i', a = 'a') => `COALESCE((${i}.due_at AT TIME ZONE 'America/Toronto')::date, ${a}.date)`;

/**
 * The single "item visible to student" rule (spec 0.8). `s` is an alias with a
 * student_id column (or an expression table alias the caller provides).
 */
const ITEM_VISIBLE = (i, a, s) => `
  ${i}.deleted_at IS NULL
  AND (${i}.status = 'posted' OR (${i}.status = 'scheduled' AND ${i}.publish_at <= NOW()))
  AND (${i}.kind <> 'assessment' OR ${i}.show_early OR ${a}.date IS NULL
       OR ${a}.date <= (NOW() AT TIME ZONE 'America/Toronto')::date OR ${a}.is_published)
  AND (${i}.audience = 'all' OR EXISTS (SELECT 1 FROM classwork_item_students x WHERE x.item_id = ${i}.item_id AND x.student_id = ${s}.student_id))
  AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.class_id = ${i}.class_id AND cs.student_id = ${s}.student_id)`;

// The students an item reaches: the class roster (not archived), narrowed to
// the chosen students when the audience is "some".
const AUDIENCE_SIZE = (i = 'i') => `(SELECT COUNT(*) FROM class_students cs JOIN students s ON s.student_id = cs.student_id
   WHERE cs.class_id = ${i}.class_id AND s.is_archived IS NOT TRUE
     AND (${i}.audience = 'all' OR EXISTS (SELECT 1 FROM classwork_item_students x
                                           WHERE x.item_id = ${i}.item_id AND x.student_id = cs.student_id)))::int`;

// Turn-in counts per item. Nothing is turned in online until T15.
const ITEM_COUNTS = `json_build_object('turnedIn', 0, 'missing', 0, 'notYet', 0, 'toReview', 0, 'drafts', 0, 'published', 0)`;

// A cell that holds a grade: a score, or a confirmed missing/excused status.
const HAS_GRADE = (sa = 'sa') => `(${sa}.score IS NOT NULL OR ${sa}.status IN ('missing', 'excused'))`;

// Item (and ItemSummary) columns. The class average is for plain published
// assessments only: missing counts as 0, excused is left out.
const ITEM_SELECT = `
SELECT i.item_id, i.class_id, i.kind, COALESCE(a.name, i.title) AS title, i.topic_id, i.status,
       CASE WHEN i.status = 'scheduled' AND i.publish_at <= NOW() THEN 'posted' ELSE i.status END AS effective_status,
       i.publish_at,
       COALESCE(i.posted_at, CASE WHEN i.status = 'scheduled' AND i.publish_at <= NOW() THEN i.publish_at END) AS posted_at,
       i.due_at, TO_CHAR(a.date, 'YYYY-MM-DD') AS date, i.submission_mode, i.show_early, i.audience,
       i.instructions, i.email_students, i.remind_students, i.sort_order, i.created_by, i.created_at, i.edited_at,
       a.assessment_id, a.parent_assessment_id AS category_id, p.name AS category_name, a.max_score, a.weight_points,
       COALESCE(a.is_published, FALSE) AS is_published,
       (SELECT COUNT(*) FROM student_assessments sa WHERE sa.assessment_id = a.assessment_id AND ${HAS_GRADE()})::int AS score_count,
       (SELECT COUNT(*) FROM classwork_attachments x WHERE x.item_id = i.item_id)::int AS attachment_count,
       ${ITEM_COUNTS} AS counts,
       CASE WHEN i.kind = 'assessment' AND COALESCE(a.is_published, FALSE) AND a.max_score > 0 THEN
         (SELECT ROUND(AVG(CASE WHEN sa.status = 'missing' THEN 0 ELSE sa.score END) * 100 / a.max_score, 1)
            FROM student_assessments sa
           WHERE sa.assessment_id = a.assessment_id
             AND (sa.status = 'missing' OR (sa.status = 'graded' AND sa.score IS NOT NULL)))
       END AS class_avg_pct
FROM classwork_items i
LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
LEFT JOIN assessments p ON p.assessment_id = a.parent_assessment_id`;

const classworkQueries = {
  ISO,
  TORONTO_TODAY,
  EFFECTIVE_POSTED,
  ITEM_DAY,
  ITEM_VISIBLE,
  AUDIENCE_SIZE,
  ITEM_COUNTS,
  ITEM_SELECT,

  // ── Reads ──────────────────────────────────────────────────────────────

  //  A class's items. $1 class_id, $2 topic (uuid text, 'none' = no topic,
  //  NULL = every topic), $3 kind (NULL = every kind)
  selectClassItems: `${ITEM_SELECT}
WHERE i.class_id = $1 AND i.deleted_at IS NULL
  AND ($2::text IS NULL OR ($2::text = 'none' AND i.topic_id IS NULL) OR i.topic_id::text = $2::text)
  AND ($3::text IS NULL OR i.kind = $3::text)
ORDER BY i.sort_order, COALESCE(i.posted_at, i.publish_at, i.created_at) DESC, i.created_at DESC, i.item_id`,

  //  One live item. $1 item_id
  selectItem: `${ITEM_SELECT}
WHERE i.item_id = $1 AND i.deleted_at IS NULL`,

  //  Items by id (the copy result). $1 uuid[]
  selectItemsByIds: `${ITEM_SELECT}
WHERE i.item_id = ANY($1::uuid[]) AND i.deleted_at IS NULL
ORDER BY i.created_at, i.item_id`,

  //  The item row itself, locked for an edit. $1 item_id
  lockItem: `SELECT * FROM classwork_items WHERE item_id = $1 AND deleted_at IS NULL FOR UPDATE`,

  selectItemStudentIds: `SELECT student_id FROM classwork_item_students WHERE item_id = $1 ORDER BY student_id`,

  selectAttachments: `
    SELECT * FROM classwork_attachments WHERE item_id = $1 ORDER BY sort_order, created_at, attachment_id`,

  //  The class's categories (gradebook parents) with how many columns each holds. $1 class_id
  selectCategories: `
    SELECT p.assessment_id, p.name, p.weight_points,
           (SELECT COUNT(*) FROM assessments c WHERE c.parent_assessment_id = p.assessment_id)::int AS child_count
    FROM assessments p
    WHERE p.class_id = $1 AND COALESCE(p.is_parent, FALSE)
    ORDER BY p.sort_order NULLS LAST, p.created_at, p.assessment_id`,

  //  Leaf columns an assignment or quiz may fill: no other item has taken
  //  them over (their item, if any, is still a plain assessment). $1 class_id
  selectLinkableColumns: `
    SELECT a.assessment_id, a.name, p.name AS category_name, a.max_score
    FROM assessments a
    LEFT JOIN assessments p ON p.assessment_id = a.parent_assessment_id
    WHERE a.class_id = $1 AND COALESCE(a.is_parent, FALSE) = FALSE
      AND NOT EXISTS (SELECT 1 FROM classwork_items x WHERE x.assessment_id = a.assessment_id AND x.kind <> 'assessment')
    ORDER BY p.sort_order NULLS FIRST, p.name NULLS FIRST, a.sort_order NULLS LAST, a.created_at, a.assessment_id`,

  //  Students an item may be given to: the class roster, not archived. $1 class_id
  selectRosterIds: `
    SELECT cs.student_id
    FROM class_students cs JOIN students s ON s.student_id = cs.student_id
    WHERE cs.class_id = $1 AND s.is_archived IS NOT TRUE`,

  //  Topics with their live item counts. $1 class_id
  selectTopics: `
    SELECT t.topic_id, t.class_id, t.name, t.sort_order,
           (SELECT COUNT(*) FROM classwork_items i WHERE i.topic_id = t.topic_id AND i.deleted_at IS NULL)::int AS item_count
    FROM classwork_topics t
    WHERE t.class_id = $1
    ORDER BY t.sort_order, t.created_at, t.topic_id`,

  selectTopic: `
    SELECT t.topic_id, t.class_id, t.name, t.sort_order,
           (SELECT COUNT(*) FROM classwork_items i WHERE i.topic_id = t.topic_id AND i.deleted_at IS NULL)::int AS item_count
    FROM classwork_topics t
    WHERE t.topic_id = $1`,

  // ── The gradebook side of an item ──────────────────────────────────────

  //  A category of this class, locked so two creates cannot both rescale it. $1 category id, $2 class_id
  lockCategory: `
    SELECT assessment_id, class_id, name, weight_points
    FROM assessments
    WHERE assessment_id = $1 AND class_id = $2 AND COALESCE(is_parent, FALSE)
    FOR UPDATE`,

  //  A category's columns, locked. $1 category id
  lockChildren: `
    SELECT assessment_id, weight_points, sort_order
    FROM assessments
    WHERE parent_assessment_id = $1
    ORDER BY sort_order NULLS LAST, created_at, assessment_id
    FOR UPDATE`,

  //  A leaf column, locked. $1 assessment_id
  lockAssessment: `
    SELECT assessment_id, class_id, parent_assessment_id, name, max_score
    FROM assessments WHERE assessment_id = $1 FOR UPDATE`,

  updateAssessmentWeight: `
    UPDATE assessments SET weight_points = $1, last_modified_at = NOW() WHERE assessment_id = $2`,

  //  The gradebook column takes the item's title (and date when one is given). $1 name, $2 date, $3 assessment_id
  renameAssessment: `
    UPDATE assessments SET name = $1, date = COALESCE($2::date, date), last_modified_at = NOW()
    WHERE assessment_id = $3`,

  //  An edit of a linked item. $1 assessment_id, $2 name, $3 set the date?, $4 date, $5 max_score (NULL keeps)
  updateLinkedAssessment: `
    UPDATE assessments
    SET name = $2,
        date = CASE WHEN $3::boolean THEN $4::date ELSE date END,
        max_score = COALESCE($5::numeric, max_score),
        last_modified_at = NOW()
    WHERE assessment_id = $1`,

  //  Moves a column under another category. $1 assessment_id, $2 category, $3 weight, $4 sort_order
  reparentAssessment: `
    UPDATE assessments
    SET parent_assessment_id = $2, weight_points = $3, sort_order = $4, last_modified_at = NOW()
    WHERE assessment_id = $1`,

  deleteAssessment: `DELETE FROM assessments WHERE assessment_id = $1`,

  countGrades: `
    SELECT COUNT(*)::int AS n FROM student_assessments sa WHERE sa.assessment_id = $1 AND ${HAS_GRADE()}`,

  // ── Item writes ────────────────────────────────────────────────────────
  // Shared parameter order after the leading ones:
  //   kind, instructions, topic_id, due_at, submission_mode, status,
  //   publish_at, show_early, email_students, remind_students, audience, created_by

  //  An item with no gradebook column. $1 class_id, $2 title, $3..$14 as above
  insertItem: `
    INSERT INTO classwork_items (class_id, title, kind, instructions, topic_id, due_at, submission_mode, status,
                                 publish_at, posted_at, show_early, email_students, remind_students, audience, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, $9, CASE WHEN $8::text = 'posted' THEN NOW() END, $10, $11, $12, $13, $14)
    RETURNING item_id`,

  //  The column's item becomes this item (still one item per assessment).
  //  Only a plain-assessment row is taken over: a column another assignment
  //  already fills returns no row. $1 class_id, $2 assessment_id, $3..$14 as above
  convertItemByAssessment: `
    INSERT INTO classwork_items (class_id, assessment_id, title, kind, instructions, topic_id, due_at, submission_mode, status,
                                 publish_at, posted_at, show_early, email_students, remind_students, audience, created_by)
    VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8::text, $9, CASE WHEN $8::text = 'posted' THEN NOW() END, $10, $11, $12, $13, $14)
    ON CONFLICT (assessment_id) WHERE assessment_id IS NOT NULL DO UPDATE
    SET kind = EXCLUDED.kind, title = NULL, instructions = EXCLUDED.instructions, topic_id = EXCLUDED.topic_id,
        due_at = EXCLUDED.due_at, submission_mode = EXCLUDED.submission_mode, status = EXCLUDED.status,
        publish_at = EXCLUDED.publish_at, posted_at = EXCLUDED.posted_at, show_early = EXCLUDED.show_early,
        email_students = EXCLUDED.email_students, remind_students = EXCLUDED.remind_students,
        audience = EXCLUDED.audience, created_by = EXCLUDED.created_by, created_at = NOW(),
        edited_at = NULL, deleted_at = NULL
    WHERE classwork_items.kind = 'assessment'
    RETURNING item_id`,

  //  An edit. $1 item_id, $2 own title (NULL when linked), $3..$13 as above
  //  (no created_by), $14 content changed (sets edited_at)
  updateItem: `
    UPDATE classwork_items
    SET title = $2, kind = $3, instructions = $4, topic_id = $5, due_at = $6, submission_mode = $7,
        status = $8::text, publish_at = $9,
        posted_at = CASE WHEN $8::text = 'posted' THEN COALESCE(posted_at, NOW()) ELSE NULL END,
        show_early = $10, email_students = $11, remind_students = $12, audience = $13,
        edited_at = CASE WHEN $14::boolean THEN NOW() ELSE edited_at END
    WHERE item_id = $1
    RETURNING item_id`,

  setItemAssessment: `UPDATE classwork_items SET assessment_id = $2 WHERE item_id = $1`,

  //  Frees a column's plain-assessment row so another item can fill it. $1 assessment_id, $2 the item keeping it
  deletePlainItemOf: `
    DELETE FROM classwork_items WHERE assessment_id = $1 AND kind = 'assessment' AND item_id <> $2`,

  softDeleteItem: `UPDATE classwork_items SET deleted_at = NOW() WHERE item_id = $1`,

  touchItem: `UPDATE classwork_items SET edited_at = NOW() WHERE item_id = $1`,

  clearItemStudents: `DELETE FROM classwork_item_students WHERE item_id = $1`,
  insertItemStudents: `
    INSERT INTO classwork_item_students (item_id, student_id)
    SELECT $1, unnest($2::uuid[])
    ON CONFLICT DO NOTHING`,

  // ── Topics ─────────────────────────────────────────────────────────────

  insertTopic: `
    INSERT INTO classwork_topics (class_id, name, sort_order)
    VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM classwork_topics WHERE class_id = $1), 0))
    RETURNING topic_id`,

  //  $1 topic_id, $2 name (NULL keeps), $3 sort_order (NULL keeps)
  updateTopic: `
    UPDATE classwork_topics SET name = COALESCE($2, name), sort_order = COALESCE($3::int, sort_order)
    WHERE topic_id = $1
    RETURNING topic_id`,

  deleteTopic: `DELETE FROM classwork_topics WHERE topic_id = $1`,

  //  $1 class_id, $2 topic ids in their new order
  reorderTopics: `
    UPDATE classwork_topics t SET sort_order = o.ord - 1
    FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ord)
    WHERE t.topic_id = o.id AND t.class_id = $1`,

  // ── Attachments ────────────────────────────────────────────────────────

  countAttachments: `SELECT COUNT(*)::int AS n FROM classwork_attachments WHERE item_id = $1`,

  //  $1 item_id, $2 file_path, $3 file_name, $4 mime_type, $5 size_bytes, $6 created_by
  insertFileAttachment: `
    INSERT INTO classwork_attachments (item_id, kind, file_path, file_name, mime_type, size_bytes, sort_order, created_by)
    VALUES ($1, 'file', $2, $3, $4, $5,
            COALESCE((SELECT MAX(sort_order) + 1 FROM classwork_attachments WHERE item_id = $1), 0), $6)
    RETURNING *`,

  //  $1 item_id, $2 url, $3 title, $4 created_by
  insertLinkAttachment: `
    INSERT INTO classwork_attachments (item_id, kind, url, title, sort_order, created_by)
    VALUES ($1, 'link', $2, $3,
            COALESCE((SELECT MAX(sort_order) + 1 FROM classwork_attachments WHERE item_id = $1), 0), $4)
    RETURNING *`,

  //  $1 attachment_id, $2 set the title?, $3 title, $4 url (NULL keeps)
  updateAttachment: `
    UPDATE classwork_attachments
    SET title = CASE WHEN $2::boolean THEN $3 ELSE title END, url = COALESCE($4, url)
    WHERE attachment_id = $1
    RETURNING *`,

  //  A new file in place of the old one; old_path is the object to remove.
  //  $1 attachment_id, $2 file_path, $3 file_name, $4 mime_type, $5 size_bytes
  replaceAttachmentFile: `
    UPDATE classwork_attachments x
    SET file_path = $2, file_name = $3, mime_type = $4, size_bytes = $5
    FROM (SELECT file_path AS old_path FROM classwork_attachments WHERE attachment_id = $1) o
    WHERE x.attachment_id = $1
    RETURNING x.*, o.old_path`,

  deleteAttachment: `DELETE FROM classwork_attachments WHERE attachment_id = $1 RETURNING *`,

  selectAttachment: `SELECT * FROM classwork_attachments WHERE attachment_id = $1`,

  // ── Resource ownership (requireClassroomResource) ──────────────────────
  // Each returns the class's school and lead teacher, and whether $2 co-teaches it.

  resourceItem: `
    SELECT i.item_id, i.class_id, c.school, c.teacher_id,
           EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $2) AS is_co_teacher
    FROM classwork_items i JOIN classes c ON c.class_id = i.class_id
    WHERE i.item_id = $1 AND i.deleted_at IS NULL`,

  resourceTopic: `
    SELECT t.topic_id, t.class_id, c.school, c.teacher_id,
           EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $2) AS is_co_teacher
    FROM classwork_topics t JOIN classes c ON c.class_id = t.class_id
    WHERE t.topic_id = $1`,

  resourceAttachment: `
    SELECT x.attachment_id, x.item_id, x.kind, i.class_id, c.school, c.teacher_id,
           EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $2) AS is_co_teacher
    FROM classwork_attachments x
    JOIN classwork_items i ON i.item_id = x.item_id AND i.deleted_at IS NULL
    JOIN classes c ON c.class_id = i.class_id
    WHERE x.attachment_id = $1`,

  // ── Copy from another class ────────────────────────────────────────────

  //  The caller's other classes in the target's year (admins: every class).
  //  $1 user_id, $2 school, $3 role, $4 school_year_id, $5 target class_id
  selectCopySources: `
    SELECT c.class_id, c.grade::text AS grade, c.subject, c.term_name,
           (SELECT COUNT(*) FROM classwork_items i WHERE i.class_id = c.class_id AND i.deleted_at IS NULL)::int AS item_count
    FROM classes c
    WHERE c.school = $2 AND c.school_year_id IS NOT DISTINCT FROM $4::uuid AND c.class_id <> $5
      AND ($3::text = 'ADMIN' OR c.teacher_id = $1
           OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))
    ORDER BY ${GRADE_RANK('c.grade::text')}, c.subject, c.term_name NULLS LAST, c.class_id`,

  //  May the caller copy from this class? $1 class_id, $2 user_id
  selectSourceClass: `
    SELECT c.class_id, c.school, c.teacher_id, c.school_year_id,
           EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $2) AS is_co_teacher
    FROM classes c WHERE c.class_id = $1`,

  //  Live items to copy, oldest first. $1 class_id, $2 item ids (NULL = all)
  selectCopyItems: `${ITEM_SELECT}
LEFT JOIN classwork_topics t ON t.topic_id = i.topic_id
WHERE i.class_id = $1 AND i.deleted_at IS NULL AND ($2::uuid[] IS NULL OR i.item_id = ANY($2::uuid[]))
ORDER BY t.sort_order NULLS LAST, i.sort_order, i.created_at, i.item_id`,

  selectClassSchoolYear: `SELECT class_id, school, school_year_id FROM classes WHERE class_id = $1`,

  // ── Scheduler ──────────────────────────────────────────────────────────

  promoteScheduledItems: `
    UPDATE classwork_items SET status = 'posted', posted_at = publish_at
    WHERE status = 'scheduled' AND publish_at <= NOW() AND deleted_at IS NULL
    RETURNING item_id, class_id`,

  // ── Child grades (itemId and kind for a graded column) ─────────────────

  //  Each assessment's live item, and whether the student may open it.
  //  $1 assessment ids, $2 student_id
  selectItemsForAssessments: `
    SELECT i.assessment_id, i.item_id, i.kind,
           (${ITEM_VISIBLE('i', 'a', 'st')}) AS visible
    FROM classwork_items i
    JOIN assessments a ON a.assessment_id = i.assessment_id
    CROSS JOIN (SELECT $2::uuid AS student_id) st
    WHERE i.assessment_id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
};

module.exports = classworkQueries;
