// queries/assessmentPublish.queries.js
//
// SQL for publishing assessments to parents. Publish state lives on
// `assessments` (is_published / published_at / published_by /
// publication_batch_id / parent_comment); each publish or unpublish action
// also writes one `assessment_publication_batches` row, and each attempted
// guardian email writes one `assessment_publication_emails` row.

const { inCurrentTerm } = require('./termScope');

const assessmentPublishQueries = {
  // ────────────────────────────────────────────────────────────
  // Validation & cascade
  // ────────────────────────────────────────────────────────────

  /**
   * The requested assessments that genuinely belong to this class.
   * Anything missing from the result was not in the class — the caller
   * rejects the request rather than silently publishing a subset.
   * Params: $1 class_id, $2 assessment_id[]
   */
  selectAssessmentsInClass: `
    SELECT
      assessment_id,
      class_id,
      name,
      is_parent,
      parent_assessment_id,
      weight_points,
      max_score,
      sort_order,
      is_published,
      parent_comment
    FROM assessments
    WHERE class_id = $1
      AND assessment_id = ANY($2::uuid[])
  `,

  /**
   * Every assessment in a class, for cascade expansion and score math.
   * Params: $1 class_id
   */
  selectAllAssessmentsInClass: `
    SELECT
      assessment_id,
      class_id,
      name,
      is_parent,
      parent_assessment_id,
      weight_points,
      max_score,
      sort_order,
      is_published,
      published_at,
      parent_comment
    FROM assessments
    WHERE class_id = $1
    ORDER BY sort_order NULLS LAST, created_at
  `,

  /**
   * Score rows for every enrolled student in a class, with per-student
   * exclusions resolved. Feeds both the ungraded-student warning counts
   * and the per-student figures in the publish email.
   * Params: $1 class_id
   */
  selectClassScoreRows: `
    SELECT
      cs.student_id,
      s.name AS student_name,
      a.assessment_id,
      sa.score,
      COALESCE(sa.status, 'graded') AS status,
      (COALESCE(sa.status, 'graded') = 'excused') AS is_excluded
    FROM class_students AS cs
    JOIN students AS s
      ON s.student_id = cs.student_id
     AND s.is_archived = FALSE
    JOIN assessments AS a
      ON a.class_id = cs.class_id
    LEFT JOIN student_assessments AS sa
      ON sa.student_id    = cs.student_id
     AND sa.assessment_id = a.assessment_id
    WHERE cs.class_id = $1
  `,

  // ────────────────────────────────────────────────────────────
  // Recipients
  // ────────────────────────────────────────────────────────────

  /**
   * Guardian email addresses per student.
   *
   * Tiering: if the student has ANY parent_students rows, use those —
   * users.email when the row is linked to an account, else the free-text
   * parent_email — and never fall back, even if some of those rows have no
   * address (a linked guardian without an email is a data problem to fix,
   * not a reason to mail a stale contact column). Only a student with zero
   * parent_students rows falls back to students.mother_email/father_email.
   *
   * Params: $1 student_id[]
   */
  selectGuardianEmailsByStudent: `
    SELECT
      s.student_id,
      s.name AS student_name,
      CASE
        WHEN bool_or(ps.parent_student_link_id IS NOT NULL) THEN
          ARRAY_AGG(DISTINCT COALESCE(u.email, ps.parent_email))
            FILTER (WHERE ps.parent_student_link_id IS NOT NULL
                      AND COALESCE(u.email, ps.parent_email) IS NOT NULL)
        ELSE
          ARRAY_REMOVE(ARRAY[MIN(s.mother_email), MIN(s.father_email)], NULL)
      END AS guardian_emails
    FROM students AS s
    LEFT JOIN parent_students AS ps ON ps.student_id = s.student_id
    LEFT JOIN users AS u            ON u.user_id     = ps.parent_id
    WHERE s.student_id = ANY($1::uuid[])
    GROUP BY s.student_id, s.name
  `,

  /**
   * The email's class line and its "Ask <teacher> about this" links: the
   * subject, the lead teacher's account name (classes.teacher_name can be
   * stale), and whether parents can start a conversation about the class:
   * it sits in the active school year (what the parent portal shows) and in
   * that year's current term, the same rule as messaging
   * (termScope.inCurrentTerm; no active term filters nothing).
   * Params: $1 class_id
   */
  selectEmailClassContext: `
    SELECT
      cl.subject,
      NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS teacher_name,
      (cl.school_year_id IS NULL OR COALESCE(sy.is_active, FALSE))
        AND ${inCurrentTerm('cl', 't.term_id', 't.name')} AS askable
    FROM classes AS cl
    LEFT JOIN users AS u ON u.user_id = cl.teacher_id
    LEFT JOIN school_years AS sy ON sy.school_year_id = cl.school_year_id
    -- termScope.selectCurrentTerm, for the class's own school and year
    LEFT JOIN LATERAL (
      SELECT term_id, name FROM terms
      WHERE school = cl.school AND is_active = TRUE
        AND (cl.school_year_id IS NULL OR school_year_id = cl.school_year_id)
      ORDER BY start_date DESC LIMIT 1
    ) AS t ON TRUE
    WHERE cl.class_id = $1
  `,

  /**
   * The accounts behind a digest's guardian addresses, so each address gets
   * the right buttons (recipientAccess): a parent account linked to the child
   * signs in on one tap, an address with no account is asked to create one.
   * Params: $1 lowercased address[], $2 student_id
   */
  selectRecipientAccounts: `
    SELECT LOWER(TRIM(u.email)) AS email, u.user_id, u.role::text AS role, u.is_archived,
           EXISTS (SELECT 1 FROM parent_students ps WHERE ps.parent_id = u.user_id AND ps.student_id = $2) AS linked
    FROM users AS u
    WHERE LOWER(TRIM(u.email)) = ANY($1::text[])
  `,

  // ────────────────────────────────────────────────────────────
  // Mutations
  // ────────────────────────────────────────────────────────────

  /** Params: $1 class_id, $2 school, $3 action, $4 assessment_id[], $5 batch_comment, $6 triggered_by, $7 student_warning_count */
  insertBatch: `
    INSERT INTO assessment_publication_batches
      (class_id, school, action, assessment_ids, batch_comment, triggered_by, student_warning_count)
    VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7)
    RETURNING batch_id, created_at
  `,

  /** Params: $1 assessment_id[], $2 published_by, $3 batch_id */
  markPublished: `
    UPDATE assessments
    SET is_published         = TRUE,
        published_at         = NOW(),
        published_by         = $2,
        publication_batch_id = $3,
        last_modified_at     = NOW()
    WHERE assessment_id = ANY($1::uuid[])
    RETURNING assessment_id
  `,

  /**
   * parent_comment is deliberately NOT cleared: a teacher who unpublishes
   * to fix a mistake shouldn't lose the note they wrote.
   * Params: $1 assessment_id[], $2 batch_id
   */
  markUnpublished: `
    UPDATE assessments
    SET is_published         = FALSE,
        published_at         = NULL,
        published_by         = NULL,
        publication_batch_id = $2,
        last_modified_at     = NOW()
    WHERE assessment_id = ANY($1::uuid[])
    RETURNING assessment_id
  `,

  /** Params: $1 comment, $2 assessment_id, $3 class_id */
  updateParentComment: `
    UPDATE assessments
    SET parent_comment   = $1,
        last_modified_at = NOW()
    WHERE assessment_id = $2
      AND class_id      = $3
    RETURNING assessment_id, parent_comment
  `,

  /** Params: $1 batch_id, $2 student_id, $3 sent_by, $4 email_addresses json, $5 assessment_id[], $6 school, $7 status, $8 error_message */
  insertPublicationEmail: `
    INSERT INTO assessment_publication_emails
      (batch_id, student_id, sent_by, email_addresses, assessment_ids, school, status, error_message)
    VALUES ($1, $2, $3, $4::jsonb, $5::uuid[], $6, $7, $8)
    RETURNING id
  `,

  // ────────────────────────────────────────────────────────────
  // Reads
  // ────────────────────────────────────────────────────────────

  /**
   * Queued "New Grades Posted" emails of a class whose columns are all
   * unpublished now: skipped, never sent (an unpublish inside the hold).
   * Params: $1 class_id, $2 reason
   */
  skipUnpublishedDigests: `
    UPDATE email_outbox AS o
    SET status = 'skipped', skip_reason = $2, finished_at = NOW()
    WHERE o.kind = 'grades_digest' AND o.status = 'pending' AND o.class_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM assessments AS a
        WHERE a.is_published
          AND a.assessment_id::text IN (SELECT jsonb_array_elements_text(o.payload->'assessmentIds'))
      )
    RETURNING o.id
  `,


  /** Notes to all parents of these publishes, oldest first. Params: $1 batch_id[] */
  selectBatchNotes: `
    SELECT batch_id, batch_comment, created_at
    FROM assessment_publication_batches
    WHERE batch_id = ANY($1::uuid[])
    ORDER BY created_at
  `,

  /** A publish of this class. Params: $1 batch_id, $2 class_id */
  selectBatchInClass: `
    SELECT batch_id, class_id, action, created_at
    FROM assessment_publication_batches
    WHERE batch_id = $1 AND class_id = $2
  `,

  /** Current publish state for every assessment in a class. Params: $1 class_id */
  selectPublicationStateByClass: `
    SELECT
      assessment_id,
      is_published,
      published_at,
      published_by,
      parent_comment,
      publication_batch_id
    FROM assessments
    WHERE class_id = $1
  `,

  /**
   * Publish/unpublish history for a class, newest first, with the
   * assessment names resolved and the email outcomes rolled up.
   * Params: $1 class_id, $2 limit, $3 offset
   */
  selectPublicationHistory: `
    SELECT
      b.batch_id,
      b.action,
      b.batch_comment,
      b.student_warning_count,
      b.created_at,
      b.triggered_by,
      TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS triggered_by_name,
      COALESCE(
        (
          SELECT JSON_AGG(JSON_BUILD_OBJECT(
                   'assessmentId', a.assessment_id,
                   'name',         a.name,
                   'isParent',     a.is_parent
                 ) ORDER BY a.sort_order NULLS LAST)
          FROM assessments AS a
          WHERE a.assessment_id = ANY(b.assessment_ids)
        ), '[]'::json
      ) AS assessments,
      COALESCE(
        (
          SELECT COUNT(*) FROM assessment_publication_emails AS e
          WHERE e.batch_id = b.batch_id AND e.status = 'sent'
        ), 0
      ) AS emails_sent,
      COALESCE(
        (
          SELECT COUNT(*) FROM assessment_publication_emails AS e
          WHERE e.batch_id = b.batch_id AND e.status = 'failed'
        ), 0
      ) AS emails_failed,
      COALESCE(
        (
          SELECT COUNT(*) FROM assessment_publication_emails AS e
          WHERE e.batch_id = b.batch_id AND e.status = 'skipped'
        ), 0
      ) AS emails_skipped
    FROM assessment_publication_batches AS b
    LEFT JOIN users AS u ON u.user_id = b.triggered_by
    WHERE b.class_id = $1
    ORDER BY b.created_at DESC
    LIMIT $2 OFFSET $3
  `,
};

module.exports = assessmentPublishQueries;
