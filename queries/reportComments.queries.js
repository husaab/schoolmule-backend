// Report comment rules: a school's word limits, the term-wide review lock and
// a class's exception to it (report_comment_rules_migration.sql).

const { GRADE_RANK } = require('../utils/gradeRank');
const { wordCountSql } = require('../utils/wordCount');

// Where each document's class comments are stored. Both tables are keyed by
// (student_id, class_id, term) with the class's own term name.
const FEEDBACK_TABLE = {
  report_card: 'report_card_feedback',
  progress_report: 'progress_report_feedback',
};

// JK and SK comments: one table per kind of comment, each row keyed by
// student, term and the thing the comment is about (`column`; `field` is its
// name in a save's entry).
const KINDERGARTEN_COMMENTS = {
  jkDomain: { table: 'jk_domain_comments', column: 'domain_id', field: 'domainId' },
  jkProgress: { table: 'jk_progress_report_comments', column: 'section_type', field: 'sectionType' },
  skSubject: { table: 'sk_subject_comments', column: 'subject_id', field: 'subjectId' },
  skProgress: { table: 'sk_progress_report_comments', column: 'section_type', field: 'sectionType' },
};

// A class is locked when its own exception says so, else when its term is.
// JK and SK classes have no exceptions: their comments are not stored by
// class, so they follow the term.
const CLASS_LOCKED = `
  CASE WHEN c.grade::text IN ('JK', 'SK') THEN tl.term_id IS NOT NULL
       ELSE COALESCE(cl.locked, tl.term_id IS NOT NULL) END
`;

const reportCommentsQueries = {
  //  $1 = school
  selectLimits: `
    SELECT kind, min_words, max_words
    FROM report_comment_limits
    WHERE school = $1
  `,

  //  $1 school, $2 kind, $3 min_words, $4 max_words, $5 updated_by
  upsertLimit: `
    INSERT INTO report_comment_limits (school, kind, min_words, max_words, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (school, kind) DO UPDATE SET
      min_words  = EXCLUDED.min_words,
      max_words  = EXCLUDED.max_words,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
  `,

  // The rules of each class for each document: one row per id sent and kind.
  // `ord` is the id's place in $1, so a caller matches rows to what it sent by
  // position and never by comparing id text (Postgres reads a uuid in several
  // spellings; only it should decide which class an id names).
  //  $1 class ids (uuid[]), $2 kinds (text[])
  selectClassRules: `
    SELECT r.ord::int AS ord, c.class_id, c.school, c.grade::text AS grade, c.term_id, k.kind,
           ${CLASS_LOCKED} AS locked,
           CASE WHEN c.grade::text NOT IN ('JK', 'SK') AND cl.locked IS NOT NULL THEN 'class'
                WHEN tl.term_id IS NOT NULL THEN 'term' END AS lock_scope,
           l.min_words, l.max_words
    FROM unnest($1::uuid[]) WITH ORDINALITY AS r(class_id, ord)
    JOIN classes c ON c.class_id = r.class_id
    CROSS JOIN unnest($2::text[]) AS k(kind)
    LEFT JOIN report_comment_term_locks tl ON tl.term_id = c.term_id AND tl.kind = k.kind
    LEFT JOIN report_comment_class_locks cl ON cl.class_id = c.class_id AND cl.kind = k.kind
    LEFT JOIN report_comment_limits l ON l.school = c.school AND l.kind = k.kind
  `,

  // The comments already saved for (student, class) pairs, to tell a comment
  // that was changed from one that is only being sent again. `ord` is the
  // pair's place in the arrays (matched by position, as selectClassRules).
  //  $1 student ids (uuid[]), $2 class ids (uuid[]), pairwise
  selectSavedComments: (kind) => `
    SELECT e.ord::int AS ord, f.comment
    FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS e(student_id, class_id, ord)
    JOIN classes c ON c.class_id = e.class_id
    JOIN terms t ON t.term_id = c.term_id
    JOIN ${FEEDBACK_TABLE[kind]} f
      ON f.student_id = e.student_id AND f.class_id = e.class_id AND f.term = t.name
  `,

  // Which of these terms (by name, as JK and SK entries carry it) are locked
  // for any of the documents?
  //  $1 school, $2 school year (null = any), $3 term names (text[]), $4 kinds (text[])
  selectLockedTermNames: `
    SELECT DISTINCT t.name
    FROM report_comment_term_locks tl
    JOIN terms t ON t.term_id = tl.term_id
    WHERE t.school = $1
      AND ($2::uuid IS NULL OR t.school_year_id = $2)
      AND t.name = ANY($3::text[])
      AND tl.kind = ANY($4::text[])
  `,

  // The JK or SK comments saved for these students in these terms, keyed as
  // the save's entries key them (see KINDERGARTEN_COMMENTS).
  //  $1 student ids (uuid[]), $2 term names (text[])
  selectKindergartenComments: (source) => `
    SELECT student_id, term, ${KINDERGARTEN_COMMENTS[source].column}::text AS item, comment
    FROM ${KINDERGARTEN_COMMENTS[source].table}
    WHERE student_id = ANY($1::uuid[]) AND term = ANY($2::text[])
  `,

  //  $1 term id, $2 school
  selectTerm: `
    SELECT term_id, name, is_active
    FROM terms
    WHERE term_id = $1 AND school = $2
  `,

  // The term the review opens on: the active one of the year, else the latest.
  //  $1 school, $2 school year (null = any)
  selectDefaultTerm: `
    SELECT term_id, name, is_active
    FROM terms
    WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
    ORDER BY is_active DESC NULLS LAST, start_date DESC
    LIMIT 1
  `,

  //  $1 term id
  selectTermLocks: `
    SELECT tl.kind, tl.locked_at, u.first_name, u.last_name
    FROM report_comment_term_locks tl
    LEFT JOIN users u ON u.user_id = tl.locked_by
    WHERE tl.term_id = $1
  `,

  // Lock the whole term for a document. The term's class exceptions go, so
  // every class is locked.  $1 term id, $2 kind, $3 locked_by
  lockTerm: `
    WITH cleared AS (
      DELETE FROM report_comment_class_locks cl
      USING classes c
      WHERE c.class_id = cl.class_id AND c.term_id = $1 AND cl.kind = $2
    )
    INSERT INTO report_comment_term_locks (term_id, kind, locked_by, locked_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (term_id, kind) DO UPDATE SET
      locked_by = EXCLUDED.locked_by,
      locked_at = NOW()
  `,

  // Reopen the whole term for a document: every class is open again.
  //  $1 term id, $2 kind
  unlockTerm: `
    WITH cleared AS (
      DELETE FROM report_comment_class_locks cl
      USING classes c
      WHERE c.class_id = cl.class_id AND c.term_id = $1 AND cl.kind = $2
    )
    DELETE FROM report_comment_term_locks
    WHERE term_id = $1 AND kind = $2
  `,

  // A class with whether its term is locked for the document.
  //  $1 class id, $2 kind
  selectClassForLock: `
    SELECT c.class_id, c.school, c.grade::text AS grade, (tl.term_id IS NOT NULL) AS term_locked
    FROM classes c
    LEFT JOIN report_comment_term_locks tl ON tl.term_id = c.term_id AND tl.kind = $2
    WHERE c.class_id = $1
  `,

  //  $1 class id, $2 kind, $3 locked, $4 set_by
  upsertClassLock: `
    INSERT INTO report_comment_class_locks (class_id, kind, locked, set_by, set_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (class_id, kind) DO UPDATE SET
      locked = EXCLUDED.locked,
      set_by = EXCLUDED.set_by,
      set_at = NOW()
  `,

  //  $1 class id, $2 kind
  deleteClassLock: `
    DELETE FROM report_comment_class_locks
    WHERE class_id = $1 AND kind = $2
  `,

  // Every class of a term for the review list, with its exception and how its
  // students' comments stand against the limits.
  //  $1 term id, $2 kind, $3 min words (null = none), $4 max words (null = none)
  selectTermClasses: (kind) => `
    SELECT c.class_id, c.subject, c.grade::text AS grade, c.teacher_name,
           cl.locked AS class_locked,
           COUNT(cs.student_id)::int AS students,
           (COUNT(*) FILTER (WHERE w.words > 0))::int AS written,
           (COUNT(*) FILTER (WHERE w.words > 0 AND $3::int IS NOT NULL AND w.words < $3::int))::int AS too_short,
           (COUNT(*) FILTER (WHERE $4::int IS NOT NULL AND w.words > $4::int))::int AS too_long
    FROM classes c
    JOIN terms t ON t.term_id = c.term_id
    LEFT JOIN report_comment_class_locks cl ON cl.class_id = c.class_id AND cl.kind = $2
    LEFT JOIN (class_students cs JOIN students s ON s.student_id = cs.student_id)
      ON cs.class_id = c.class_id
    LEFT JOIN ${FEEDBACK_TABLE[kind]} f
      ON f.student_id = cs.student_id AND f.class_id = c.class_id AND f.term = t.name
    LEFT JOIN LATERAL (SELECT ${wordCountSql('f.comment')} AS words) w ON TRUE
    WHERE c.term_id = $1
    GROUP BY c.class_id, c.subject, c.grade, c.teacher_name, cl.locked
    ORDER BY ${GRADE_RANK('c.grade::text')}, c.subject, c.class_id
  `,
};

module.exports = reportCommentsQueries;
module.exports.FEEDBACK_TABLE = FEEDBACK_TABLE;
module.exports.KINDERGARTEN_COMMENTS = KINDERGARTEN_COMMENTS;
