// queries/childClassroom.queries.js
//
// The one read model behind the student portal and the parent's read-only
// lens into a child's classes. Every query is keyed on a student row (the
// caller's own, or a child the parent owns); nothing here ever returns
// another student's data. Archived classes are left out everywhere.
//
// students.grade and classes.grade are the "GRADE" enum in production: always
// compare them as ::text.

const { studentAvatarSql } = require('../utils/avatar');
const { GRADE_RANK } = require('../utils/gradeRank');
const { inCurrentTerm } = require('./termScope');
const { IN_AUDIENCE } = require('./announcement.queries');

// A class's teachers, lead first then co-teachers by last name, as PersonLite
// JSON. Archived accounts are left out (they are no one to talk to). `c` is
// the classes alias.
const TEACHERS_JSON = (c) => `COALESCE((
    SELECT json_agg(json_build_object('userId', u.user_id, 'name', TRIM(CONCAT(u.first_name, ' ', u.last_name)),
                                      'avatar', u.avatar, 'role', t.role)
                    ORDER BY t.ord, u.last_name, u.first_name)
    FROM (SELECT ${c}.teacher_id AS user_id, 'lead' AS role, 0 AS ord
          UNION
          SELECT ct.teacher_id, 'co', 1 FROM class_teachers ct
           WHERE ct.class_id = ${c}.class_id AND ct.teacher_id IS DISTINCT FROM ${c}.teacher_id) t
    JOIN users u ON u.user_id = t.user_id
    WHERE u.is_archived IS NOT TRUE), '[]')`;

// The classes row columns ClassIdentity needs (subject and grade come separately).
const IDENTITY_COLUMNS = (c) => `${c}.banner_key, ${c}.banner_path, ${c}.icon_key, ${c}.color`;

// A class post published in the last 7 days that the reader has not opened.
// $reader is the reader's user id (the student, or the parent in the lens).
const HAS_NEW_POST = (c, reader) => `EXISTS (
    SELECT 1 FROM announcements a
     WHERE a.class_id = ${c}.class_id AND a.scope = 'class' AND a.deleted_at IS NULL
       AND a.published_at >= NOW() - INTERVAL '7 days'
       AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.announcement_id AND r.user_id = ${reader}))`;

// The child can sign in: a linked login that is live (not archived, not
// invite-pending) with consent on file, classrooms on, and the child's grade at
// or above the school's login grade (the sign-in gate's own rules).
const SIGNS_IN = (s) => `EXISTS (
    SELECT 1 FROM student_account_links sal
      JOIN users su ON su.user_id = sal.user_id AND su.is_archived IS NOT TRUE AND su.password <> '!'
      JOIN student_accounts sa ON sa.user_id = su.user_id AND sa.consent_at IS NOT NULL
      JOIN school_classroom_settings scs ON scs.school = ${s}.school AND scs.enabled
     WHERE sal.student_id = ${s}.student_id
       AND ${GRADE_RANK(`${s}.grade::text`)} >= ${GRADE_RANK('scs.login_from_grade')})`;

const childClassroomQueries = {
  // One student row as the portal shows it. $1 student_id
  selectChildProfile: `
    SELECT s.student_id, s.name, s.grade::text AS grade, s.school, s.school_year_id, s.is_archived,
           ${studentAvatarSql('s')},
           NULLIF(TRIM(CONCAT(ht.first_name, ' ', ht.last_name)), '') AS homeroom_teacher_name
    FROM students s
    LEFT JOIN users ht ON ht.user_id = s.homeroom_teacher_id
    WHERE s.student_id = $1
  `,

  // The student's current-term classes of the year, by subject.
  // $1 student_id, $2 school, $3 school_year_id|null, $4 current term_id|null,
  // $5 current term name|null, $6 reader user_id
  selectChildClasses: `
    SELECT c.class_id, c.subject, c.grade::text AS grade, c.term_name, ${IDENTITY_COLUMNS('c')},
           ${TEACHERS_JSON('c')} AS teachers,
           ${HAS_NEW_POST('c', '$6')} AS has_new_post
    FROM class_students cs
    JOIN classes c ON c.class_id = cs.class_id
    WHERE cs.student_id = $1 AND c.school = $2 AND c.archived_at IS NULL
      AND ($3::uuid IS NULL OR c.school_year_id = $3)
      AND ${inCurrentTerm('c', '$4', '$5')}
    ORDER BY c.subject, ${GRADE_RANK('c.grade::text')}, c.class_id
  `,

  // One class the student is enrolled in (any term of the year), never an
  // archived one. $1 student_id, $2 class_id, $3 school, $4 school_year_id|null
  selectChildClass: `
    SELECT c.class_id, c.subject, c.grade::text AS grade, c.term_name, ${IDENTITY_COLUMNS('c')}
    FROM class_students cs
    JOIN classes c ON c.class_id = cs.class_id
    WHERE cs.student_id = $1 AND cs.class_id = $2 AND c.school = $3 AND c.archived_at IS NULL
      AND ($4::uuid IS NULL OR c.school_year_id = $4)
  `,

  // The class's teachers (lead first), only for a student on its roster.
  // $1 class_id, $2 student_id
  selectChildClassTeachers: `
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name, u.avatar, u.photo_path, t.role
    FROM (SELECT c.teacher_id AS user_id, 'lead' AS role, 0 AS ord FROM classes c WHERE c.class_id = $1
          UNION
          SELECT ct.teacher_id, 'co', 1 FROM class_teachers ct JOIN classes c ON c.class_id = ct.class_id
           WHERE ct.class_id = $1 AND ct.teacher_id IS DISTINCT FROM c.teacher_id) t
    JOIN users u ON u.user_id = t.user_id
    WHERE u.is_archived IS NOT TRUE
      AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.class_id = $1 AND cs.student_id = $2)
    ORDER BY t.ord, u.last_name, u.first_name
  `,

  // The classes a grades read covers: the student's non-archived marked
  // (Grade 1-8) classes of one term, or of every term when $3 is NULL.
  // Classes with nothing graded yet are listed too. $1 student_id, $2 school, $3 term_id|null
  selectGradeClasses: `
    SELECT c.class_id, c.subject, c.grade::text AS grade, c.teacher_name, c.show_class_average, ${IDENTITY_COLUMNS('c')}
    FROM class_students cs
    JOIN classes c ON c.class_id = cs.class_id
    WHERE cs.student_id = $1 AND c.school = $2 AND c.archived_at IS NULL
      AND ($3::uuid IS NULL OR c.term_id = $3)
      AND c.grade::text NOT IN ('JK', 'SK')
    ORDER BY c.subject, c.class_id
  `,

  // The parent's children for the selected year (one row per child), youngest
  // grade first. $1 parent_id, $2 school, $3 school_year_id|null
  selectParentChildren: `
    SELECT s.student_id, s.name, s.grade::text AS grade, s.school_year_id,
           ${studentAvatarSql('s')},
           NULLIF(TRIM(CONCAT(ht.first_name, ' ', ht.last_name)), '') AS homeroom_teacher_name,
           ${SIGNS_IN('s')} AS signs_in
    FROM students s
    LEFT JOIN users ht ON ht.user_id = s.homeroom_teacher_id
    WHERE s.school = $2 AND s.is_archived IS NOT TRUE
      AND ($3::uuid IS NULL OR s.school_year_id = $3)
      AND EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id AND ps.parent_id = $1)
    ORDER BY ${GRADE_RANK('s.grade::text')}, s.name, s.student_id
  `,

  // "Needs you": posts asking for a "Got it" in the last 30 days, in the
  // audience of at least one of the parent's children for the year, that the
  // parent has not acknowledged. student_ids = those children.
  // $1 parent_id, $2 school, $3 school_year_id|null
  selectAckNeeded: `
    WITH kids AS (
      SELECT s.* FROM students s
      WHERE s.school = $2 AND s.is_archived IS NOT TRUE AND ($3::uuid IS NULL OR s.school_year_id = $3)
        AND EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id AND ps.parent_id = $1)
    )
    SELECT a.announcement_id, a.title, a.published_at, cl.subject AS class_subject,
           NULLIF(TRIM(CONCAT(au.first_name, ' ', au.last_name)), '') AS author_name,
           ARRAY_AGG(s.student_id ORDER BY s.name, s.student_id) AS student_ids
    FROM announcements a
    LEFT JOIN classes cl ON cl.class_id = a.class_id
    LEFT JOIN users au ON au.user_id = a.author_id
    JOIN kids s ON ${IN_AUDIENCE('s')}
    WHERE a.school = $2 AND a.deleted_at IS NULL AND a.ack_requested
      AND a.published_at >= NOW() - INTERVAL '30 days'
      AND ($3::uuid IS NULL OR a.school_year_id IS NULL OR a.school_year_id = $3)
      AND NOT EXISTS (SELECT 1 FROM announcement_acks k WHERE k.announcement_id = a.announcement_id AND k.user_id = $1)
    GROUP BY a.announcement_id, a.title, a.published_at, cl.subject, au.first_name, au.last_name
    ORDER BY a.published_at DESC, a.announcement_id
  `,
};

module.exports = childClassroomQueries;
