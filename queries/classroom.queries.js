// queries/classroom.queries.js
//
// What the teacher's classroom reads: class cards (Classes home), the class
// header and the People roster. The pieces later tasks replace are named
// fragments, so each of them changes exactly one constant:
//   CARD_NEXT, COMING_UP     classwork items (T14); DRAFTS_AND_SCHEDULED, STREAM_NOTICES (T14)
//   CARD_TO_REVIEW, TO_REVIEW  T16 counts submissions waiting for a grade
//   PEOPLE_MISSING           a student's missing work in the class (T15)
// Fragments that sit inside a SELECT use the aliases of that query: `c` is the
// class, `s` the student and `cs` the roster row.

const { studentAvatarSql } = require('../utils/avatar');
const { INVITE_COLUMNS, latestInviteLateral } = require('../utils/inviteSql');
const { GRADE_RANK } = require('../utils/gradeRank');
const { ISO, EFFECTIVE_POSTED, ITEM_DAY, AUDIENCE_SIZE, TURNED_IN_COUNT, ITEM_VISIBLE } = require('./classwork.queries');
const { WORK_STATE_SQL, WORK_JOINS } = require('./workState');
const { AWAITING_FROM } = require('./grading.queries');

const TORONTO_TODAY = `(NOW() AT TIME ZONE 'America/Toronto')::date`;

// The class's next live classwork item (not a material) falling today or
// later: an assignment or quiz on its Toronto due date, a plain assessment on
// its gradebook date. Drafts and not-yet-due schedules are not "next".
const CARD_NEXT = `(SELECT json_build_object('itemId', i.item_id, 'assessmentId', i.assessment_id, 'title', COALESCE(a.name, i.title),
                     'kind', i.kind, 'dueAt', ${ISO('i.due_at')}, 'date', TO_CHAR(${ITEM_DAY()}, 'YYYY-MM-DD'))
                    FROM classwork_items i
                    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
                   WHERE i.class_id = c.class_id AND i.deleted_at IS NULL AND i.kind <> 'material'
                     AND ${EFFECTIVE_POSTED()}
                     AND ${ITEM_DAY()} >= ${TORONTO_TODAY}
                   ORDER BY ${ITEM_DAY()}, i.due_at NULLS FIRST, a.sort_order NULLS LAST, COALESCE(a.name, i.title)
                   LIMIT 1)`;

// Work waiting for the teacher: submissions turned in with no draft grade,
// never published and no visible grade, from students the item is for.
const CARD_TO_REVIEW = `(SELECT COUNT(*) ${AWAITING_FROM('c.class_id')})::int`;

// The Classes home's "To review" rail: the items with work waiting, most
// first (then the longest waiting), at most 8, in the caller's active
// classes of the year. $1 user_id, $2 school, $3 role, $4 school_year_id
const TO_REVIEW = `
  SELECT w.item_id, w.title, w.turned_in_count, c.class_id, c.subject, c.grade::text AS grade,
         c.banner_key, c.banner_path, c.icon_key, c.color
  FROM classes c
  CROSS JOIN LATERAL (
    SELECT i.item_id, COALESCE(a.name, i.title) AS title, COUNT(*)::int AS turned_in_count,
           MIN(sub.turned_in_at) AS oldest
    ${AWAITING_FROM('c.class_id')}
    GROUP BY i.item_id, a.name, i.title
  ) w
  WHERE c.school = $2 AND c.school_year_id = $4 AND c.archived_at IS NULL
    AND ($3::text = 'ADMIN' OR c.teacher_id = $1
         OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))
  ORDER BY w.turned_in_count DESC, w.oldest, w.item_id
  LIMIT 8`;

// A student's missing work in the class (`cs` the roster row, `s` the
// student): the items they can see whose status is missing, derived (past
// due, nothing turned in, and the student can sign in) or confirmed (a
// published missing), by the same rule the student's own To-do uses.
const PEOPLE_MISSING = `(SELECT COUNT(*) FROM classwork_items i
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    ${WORK_JOINS('s.student_id')}
   WHERE i.class_id = cs.class_id AND ${ITEM_VISIBLE('i', 'a', 's')} AND ${WORK_STATE_SQL} = 'missing')::int`;

// The classes a caller works with: an admin sees every class of the school,
// a teacher the ones they lead or co-teach. $1 user_id, $3 role.
const CALLER_SCOPE = `($3::text = 'ADMIN' OR c.teacher_id = $1
       OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))`;

// Live classwork (not materials) falling today through two weeks out,
// earliest first, at most 8, in the caller's active classes. audience_size is
// how many students the item reaches, turned_in_count how many of them have
// turned it in. $1 user_id, $2 school, $3 role, $4 school_year_id, $5 class_id
// (NULL = every class of the caller).
const COMING_UP = `
  SELECT i.item_id, i.assessment_id, i.kind, i.submission_mode, c.class_id, c.grade::text AS grade, c.subject,
         COALESCE(a.name, i.title) AS title, TO_CHAR(${ITEM_DAY()}, 'YYYY-MM-DD') AS date, i.due_at,
         ${AUDIENCE_SIZE()} AS audience_size, ${TURNED_IN_COUNT()} AS turned_in_count
  FROM classwork_items i
  JOIN classes c ON c.class_id = i.class_id
  LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
  WHERE c.school = $2 AND c.school_year_id = $4 AND c.archived_at IS NULL
    AND ${CALLER_SCOPE}
    AND ($5::uuid IS NULL OR c.class_id = $5::uuid)
    AND i.deleted_at IS NULL AND i.kind <> 'material' AND ${EFFECTIVE_POSTED()}
    AND ${ITEM_DAY()} BETWEEN ${TORONTO_TODAY} AND ${TORONTO_TODAY} + 14
  ORDER BY ${ITEM_DAY()}, ${GRADE_RANK('c.grade::text')}, c.subject, i.due_at NULLS FIRST, a.sort_order NULLS LAST,
           COALESCE(a.name, i.title)
  LIMIT 8`;

// Drafts and future schedules the caller works on: items they created, or in
// classes they lead or co-teach (so a co-teacher sees the class's drafts and
// an admin only their own), this year, active classes, scheduled first by
// publish time, then drafts newest first, at most 10.
// $1 user_id, $2 school, $3 school_year_id
const DRAFTS_AND_SCHEDULED = `
  SELECT i.item_id, i.kind, c.class_id, c.grade::text AS grade, c.subject, COALESCE(a.name, i.title) AS title,
         i.status, i.publish_at
  FROM classwork_items i
  JOIN classes c ON c.class_id = i.class_id
  LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
  WHERE c.school = $2 AND c.school_year_id = $3 AND c.archived_at IS NULL
    AND i.deleted_at IS NULL
    AND (i.status = 'draft' OR (i.status = 'scheduled' AND i.publish_at > NOW()))
    AND (i.created_by = $1 OR c.teacher_id = $1
         OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))
  ORDER BY (i.status = 'scheduled') DESC, i.publish_at, COALESCE(i.edited_at, i.created_at) DESC, i.item_id
  LIMIT 10`;

// The teacher Stream's classwork notices: live assignments, quizzes and
// materials of the class, newest first, at most 20. total = the students the
// item reaches; turned_in_count = how many of them turned it in. $1 class_id
const STREAM_NOTICES = `
  SELECT i.item_id, i.kind, COALESCE(a.name, i.title) AS title,
         COALESCE(i.posted_at, i.publish_at) AS posted_at, i.due_at, ${AUDIENCE_SIZE()} AS total,
         ${TURNED_IN_COUNT()} AS turned_in_count
  FROM classwork_items i
  LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
  WHERE i.class_id = $1 AND i.deleted_at IS NULL AND i.kind IN ('assignment', 'quiz', 'material')
    AND ${EFFECTIVE_POSTED()}
  ORDER BY COALESCE(i.posted_at, i.publish_at) DESC, i.created_at DESC, i.item_id
  LIMIT 20`;

// One ClassCard row. `extraColumns` is the header's additions (options, year).
const cardSelect = (where, orderBy, extraColumns = '') => `
SELECT c.class_id, c.subject, c.grade::text AS grade, c.term_id, c.term_name, c.teacher_id, c.teacher_name,
       c.banner_key, c.banner_path, c.icon_key, c.color, c.archived_at${extraColumns},
       (SELECT COUNT(*) FROM class_students cs JOIN students s ON s.student_id = cs.student_id
         WHERE cs.class_id = c.class_id AND s.is_archived IS NOT TRUE)::int AS student_count,
       COALESCE((SELECT json_agg(json_build_object(
                   'userId', u.user_id, 'name', TRIM(CONCAT(u.first_name, ' ', u.last_name)), 'avatar', u.avatar,
                   'photoPath', u.photo_path,
                   'role', CASE WHEN u.user_id = c.teacher_id THEN 'lead' ELSE 'co' END)
                 ORDER BY (u.user_id = c.teacher_id) DESC, u.last_name)
                 FROM users u
                WHERE u.user_id = c.teacher_id
                   OR u.user_id IN (SELECT ct.teacher_id FROM class_teachers ct WHERE ct.class_id = c.class_id)), '[]') AS teachers,
       ${CARD_NEXT} AS next,
       ${CARD_TO_REVIEW} AS to_review_count
FROM classes c
WHERE ${where}${orderBy}`;

const classroomQueries = {
  CARD_NEXT,
  CARD_TO_REVIEW,
  TO_REVIEW,
  PEOPLE_MISSING,
  COMING_UP,
  DRAFTS_AND_SCHEDULED,
  STREAM_NOTICES,

  //  The Classes home. $1 user_id, $2 school, $3 role, $4 school_year_id,
  //  $5 include_archived
  selectClassCards: cardSelect(
    `c.school = $2 AND c.school_year_id = $4 AND ($5::boolean OR c.archived_at IS NULL)
  AND ${CALLER_SCOPE}`,
    `
ORDER BY ${GRADE_RANK('c.grade::text')}, c.subject`,
  ),

  //  The class header: the same card plus the class options and the year it
  //  belongs to (a past year is read-only for teachers). An archived class is
  //  returned with its archived_at, so it can be reopened and unarchived.
  //  $1 class_id
  selectClassCard: cardSelect(
    'c.class_id = $1',
    '',
    `,
       c.school, c.school_year_id, c.accept_late, c.email_new_posts, c.show_class_average,
       (SELECT sy.is_active FROM school_years sy WHERE sy.school_year_id = c.school_year_id) AS year_is_active`,
  ),

  //  Lead first, then co-teachers by last name. homeroom_grade is the grade of
  //  the class's year whose students have this teacher as homeroom teacher
  //  (the most common one if there are several). $1 class_id
  selectClassTeachers: `
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name, u.avatar, u.photo_path,
           CASE WHEN u.user_id = c.teacher_id THEN 'lead' ELSE 'co' END AS role,
           (SELECT s.grade::text
              FROM students s
             WHERE s.homeroom_teacher_id = u.user_id AND s.school = c.school
               AND s.school_year_id IS NOT DISTINCT FROM c.school_year_id
               AND s.is_archived IS NOT TRUE
             GROUP BY s.grade
             ORDER BY COUNT(*) DESC, s.grade::text
             LIMIT 1) AS homeroom_grade
    FROM classes c
    JOIN users u ON u.user_id = c.teacher_id
      OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = u.user_id)
    WHERE c.class_id = $1
    ORDER BY (u.user_id = c.teacher_id) DESC, u.last_name, u.first_name
  `,

  //  The roster. Each student with the linked login (if any), the displayed
  //  avatar (login pick over the teacher-set one) and every parent on file:
  //  the linked parents, then the mother and father on the student record
  //  (S3: the same guardians the Stream's "who gets emails" counts, matched
  //  to an account by address). The service dedupes parents by address,
  //  keeping the account holder's copy. $1 class_id
  selectPeopleStudents: `
    SELECT s.student_id, s.name, s.grade::text AS grade, ${studentAvatarSql('s')},
           u.user_id, u.photo_path, u.is_archived, (u.password = '!') AS invite_pending, u.last_seen_at,
           (u.google_sub IS NOT NULL) AS has_google, sa.activated_at, sa.activated_via,${INVITE_COLUMNS},
           COALESCE((SELECT json_agg(json_build_object(
                       'name', g.name, 'relation', g.relation, 'hasAccount', g.has_account, 'emailKey', g.email_key)
                     ORDER BY g.has_account DESC, g.src, g.created_at, g.link_id)
                     FROM (
                       SELECT COALESCE(NULLIF(TRIM(CONCAT(pu.first_name, ' ', pu.last_name)), ''), NULLIF(TRIM(ps.parent_name), '')) AS name,
                              NULLIF(TRIM(ps.relation), '') AS relation, pu.user_id IS NOT NULL AS has_account,
                              LOWER(TRIM(COALESCE(pu.email, ps.parent_email, ''))) AS email_key,
                              0 AS src, ps.created_at, ps.parent_student_link_id::text AS link_id
                       FROM parent_students ps
                       LEFT JOIN users pu ON pu.user_id = ps.parent_id
                       WHERE ps.student_id = s.student_id
                       UNION ALL
                       SELECT COALESCE(NULLIF(TRIM(CONCAT(ru.first_name, ' ', ru.last_name)), ''), NULLIF(TRIM(r.name), '')),
                              r.relation, ru.user_id IS NOT NULL, LOWER(TRIM(r.email)), 1, NULL::timestamptz, r.relation
                       FROM (VALUES ('Mother', s.mother_name, s.mother_email), ('Father', s.father_name, s.father_email)) AS r(relation, name, email)
                       LEFT JOIN LATERAL (
                         SELECT gu.user_id, gu.first_name, gu.last_name FROM users gu
                         WHERE LOWER(gu.email) = LOWER(TRIM(r.email)) AND gu.school = s.school AND gu.is_archived IS NOT TRUE
                           AND gu.role::text <> 'STUDENT' -- a student login is never a guardian's account (N6)
                         ORDER BY gu.user_id LIMIT 1) ru ON TRUE
                       WHERE TRIM(COALESCE(r.email, '')) <> ''
                     ) g), '[]') AS parents,
           ${PEOPLE_MISSING} AS missing_count
    FROM class_students cs
    JOIN students s ON s.student_id = cs.student_id
    LEFT JOIN student_account_links sal ON sal.student_id = s.student_id
    LEFT JOIN users u ON u.user_id = sal.user_id
    LEFT JOIN student_accounts sa ON sa.user_id = u.user_id
    ${latestInviteLateral('u.user_id')}
    WHERE cs.class_id = $1 AND s.is_archived IS NOT TRUE
    ORDER BY s.name, s.student_id
  `,
};

module.exports = classroomQueries;
