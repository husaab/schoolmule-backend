// queries/classroom.queries.js
//
// What the teacher's classroom reads: class cards (Classes home), the class
// header and the People roster. The pieces later tasks replace are named
// fragments, so each of them changes exactly one constant:
//   CARD_NEXT, COMING_UP     T14 reads classwork items instead of assessments
//   CARD_TO_REVIEW, TO_REVIEW  T16 counts submissions waiting for a grade
//   PEOPLE_MISSING           T15 counts a student's missing work in the class
// Fragments that sit inside a SELECT use the aliases of that query: `c` is the
// class, `s` the student and `cs` the roster row.

const { studentAvatarSql } = require('../utils/avatar');
const { GRADE_RANK } = require('../utils/gradeRank');

const TORONTO_TODAY = `(NOW() AT TIME ZONE 'America/Toronto')::date`;

// The class's next leaf assessment dated today or later (categories are not
// leaves). T14 reads the class's next posted classwork item instead.
const CARD_NEXT = `(SELECT json_build_object('itemId', NULL, 'assessmentId', a.assessment_id, 'title', a.name, 'kind', 'assessment',
                     'dueAt', NULL, 'date', TO_CHAR(a.date, 'YYYY-MM-DD'))
                    FROM assessments a
                   WHERE a.class_id = c.class_id AND COALESCE(a.is_parent, FALSE) = FALSE
                     AND a.date >= ${TORONTO_TODAY}
                   ORDER BY a.date, a.sort_order NULLS LAST LIMIT 1)`;

// Submissions waiting for the teacher. Nothing is turned in online yet (T16).
const CARD_TO_REVIEW = '0';
const TO_REVIEW = null; // T16: a query returning the "to review" list; T7 answers [].

// A student's missing work in the class. Nothing is tracked yet (T15).
const PEOPLE_MISSING = '0';

// The classes a caller works with: an admin sees every class of the school,
// a teacher the ones they lead or co-teach. $1 user_id, $3 role.
const CALLER_SCOPE = `($3::text = 'ADMIN' OR c.teacher_id = $1
       OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))`;

// Leaf assessments dated today through two weeks out, earliest first, at most
// 8, in the caller's active classes. $1 user_id, $2 school, $3 role,
// $4 school_year_id, $5 class_id (NULL = every class of the caller).
// T14 reads classwork items (assignment/quiz by due date) instead.
const COMING_UP = `
  SELECT a.assessment_id, c.class_id, c.grade::text AS grade, c.subject, a.name AS title,
         TO_CHAR(a.date, 'YYYY-MM-DD') AS date
  FROM assessments a
  JOIN classes c ON c.class_id = a.class_id
  WHERE c.school = $2 AND c.school_year_id = $4 AND c.archived_at IS NULL
    AND ${CALLER_SCOPE}
    AND ($5::uuid IS NULL OR c.class_id = $5::uuid)
    AND COALESCE(a.is_parent, FALSE) = FALSE
    AND a.date BETWEEN ${TORONTO_TODAY} AND ${TORONTO_TODAY} + 14
  ORDER BY a.date, ${GRADE_RANK('c.grade::text')}, c.subject, a.sort_order NULLS LAST, a.name
  LIMIT 8`;

// One ClassCard row. `extraColumns` is the header's additions (options, year).
const cardSelect = (where, orderBy, extraColumns = '') => `
SELECT c.class_id, c.subject, c.grade::text AS grade, c.term_id, c.term_name, c.teacher_id, c.teacher_name,
       c.banner_key, c.banner_path, c.icon_key, c.color, c.archived_at${extraColumns},
       (SELECT COUNT(*) FROM class_students cs JOIN students s ON s.student_id = cs.student_id
         WHERE cs.class_id = c.class_id AND s.is_archived IS NOT TRUE)::int AS student_count,
       COALESCE((SELECT json_agg(json_build_object(
                   'userId', u.user_id, 'name', TRIM(CONCAT(u.first_name, ' ', u.last_name)), 'avatar', u.avatar,
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
  //  avatar (login pick over the teacher-set one) and every parent on file;
  //  the service dedupes parents by address. $1 class_id
  selectPeopleStudents: `
    SELECT s.student_id, s.name, s.grade::text AS grade, ${studentAvatarSql('s')},
           u.user_id, u.is_archived, (u.password = '!') AS invite_pending, u.last_seen_at,
           COALESCE((SELECT json_agg(json_build_object(
                       'name', COALESCE(NULLIF(TRIM(CONCAT(pu.first_name, ' ', pu.last_name)), ''), NULLIF(TRIM(ps.parent_name), '')),
                       'relation', NULLIF(TRIM(ps.relation), ''),
                       'hasAccount', pu.user_id IS NOT NULL,
                       'emailKey', LOWER(TRIM(COALESCE(pu.email, ps.parent_email, ''))))
                     ORDER BY (pu.user_id IS NOT NULL) DESC, ps.created_at, ps.parent_student_link_id)
                     FROM parent_students ps
                     LEFT JOIN users pu ON pu.user_id = ps.parent_id
                    WHERE ps.student_id = s.student_id), '[]') AS parents,
           ${PEOPLE_MISSING} AS missing_count
    FROM class_students cs
    JOIN students s ON s.student_id = cs.student_id
    LEFT JOIN student_account_links sal ON sal.student_id = s.student_id
    LEFT JOIN users u ON u.user_id = sal.user_id
    WHERE cs.class_id = $1 AND s.is_archived IS NOT TRUE
    ORDER BY s.name, s.student_id
  `,
};

module.exports = classroomQueries;
