// queries/messaging.queries.js
//
// Parent–teacher conversations. Membership is never stored: every access
// query re-derives it from the same three sources — parent_students
// (guardians), classes.teacher_id (lead) and class_teachers (co-teachers) —
// so a guardian linked after a thread began sees it immediately. See
// middleware/requireConversationAccess.js.

// The "who can see this conversation" projection, shared by the guard and
// the thread endpoint. $1 conversation_id
const CONVERSATION_ACCESS_SELECT = `
  SELECT
    c.conversation_id, c.school, c.student_id, c.class_id, c.assessment_id,
    c.title, c.status, c.created_by, c.resolved_by, c.resolved_at,
    c.last_message_at, c.created_at,
    s.name          AS student_name,
    s.school_year_id,
    cl.subject      AS class_subject,
    cl.teacher_id   AS lead_teacher_id,
    COALESCE((SELECT ARRAY_AGG(ct.teacher_id) FROM class_teachers ct WHERE ct.class_id = c.class_id), '{}')::uuid[] AS co_teacher_ids,
    COALESCE((SELECT ARRAY_AGG(ps.parent_id) FROM parent_students ps
              WHERE ps.student_id = c.student_id AND ps.parent_id IS NOT NULL), '{}')::uuid[] AS guardian_ids,
    COALESCE((SELECT ARRAY_AGG(cp.user_id) FROM conversation_participants cp
              JOIN users u ON u.user_id = cp.user_id
              WHERE cp.conversation_id = c.conversation_id AND u.role = 'ADMIN'), '{}')::uuid[] AS admin_participant_ids
  FROM conversations c
  JOIN students s  ON s.student_id = c.student_id
  JOIN classes  cl ON cl.class_id  = c.class_id
`;

// Unread = messages from someone else, not deleted, newer than my last read.
// Expects aliases c (conversations) and cp (my participant row) and $1 = my user_id.
const UNREAD_COUNT_EXPR = `
  (SELECT COUNT(*) FROM messages m
   WHERE m.conversation_id = c.conversation_id
     AND m.kind = 'message' AND m.deleted_at IS NULL
     AND m.sender_id IS DISTINCT FROM $1
     AND m.created_at > COALESCE(cp.last_read_at, '-infinity'::timestamptz))::int
`;

const LAST_MESSAGE_SQL = `
  (SELECT jsonb_build_object(
      'senderId', lm.sender_id, 'senderRole', lm.sender_role, 'kind', lm.kind,
      'body', CASE WHEN lm.deleted_at IS NOT NULL THEN NULL ELSE LEFT(lm.body, 140) END,
      'deleted', lm.deleted_at IS NOT NULL,
      'createdAt', lm.created_at,
      'senderName', TRIM(CONCAT(su.first_name, ' ', su.last_name)))
   FROM messages lm LEFT JOIN users su ON su.user_id = lm.sender_id
   WHERE lm.conversation_id = c.conversation_id
   ORDER BY lm.created_at DESC LIMIT 1) AS last_message
`;

// Shared list body. $1 user_id, $2 school, $3 school_year_id|null,
// $4 status|null ('open'|'resolved'), $5 class_id|null, $6 student_id|null,
// $7 search|null, $8 limit, $9 unread_only boolean
const listBody = (scopeSql) => `
  SELECT
    c.conversation_id, c.student_id, c.class_id, c.assessment_id, c.title, c.status,
    c.last_message_at, c.created_at,
    s.name AS student_name, cl.subject AS class_subject,
    TRIM(CONCAT(lt.first_name, ' ', lt.last_name)) AS lead_teacher_name,
    cp.last_read_at,
    ${UNREAD_COUNT_EXPR} AS unread_count,
    ${LAST_MESSAGE_SQL}
  FROM conversations c
  JOIN students s  ON s.student_id = c.student_id
  JOIN classes  cl ON cl.class_id  = c.class_id
  LEFT JOIN users lt ON lt.user_id = cl.teacher_id
  LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
  WHERE c.school = $2
    AND ($3::uuid IS NULL OR s.school_year_id = $3)
    AND ($4::text IS NULL OR c.status = $4)
    AND ($5::uuid IS NULL OR c.class_id = $5)
    AND ($6::uuid IS NULL OR c.student_id = $6)
    AND ($7::text IS NULL OR s.name ILIKE '%' || $7 || '%' OR c.title ILIKE '%' || $7 || '%' OR cl.subject ILIKE '%' || $7 || '%')
    AND ($9::boolean IS FALSE OR ${UNREAD_COUNT_EXPR} > 0)
    AND (${scopeSql})
  ORDER BY c.last_message_at DESC
  LIMIT $8
`;

const PARENT_SCOPE = `EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = c.student_id AND ps.parent_id = $1)`;
const TEACHER_SCOPE = `cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1)`;

const messagingQueries = {
  selectConversationAccess: `${CONVERSATION_ACCESS_SELECT} WHERE c.conversation_id = $1`,

  // Everything needed to validate a new thread in one round trip.
  // $1 student_id, $2 class_id, $3 assessment_id, $4 user_id
  selectAnchorContext: `
    SELECT
      cl.class_id, cl.school, cl.subject AS class_subject, cl.teacher_id AS lead_teacher_id,
      s.student_id, s.name AS student_name, s.school AS student_school,
      a.assessment_id, a.name AS assessment_name, a.is_published, a.is_parent,
      (a.class_id = cl.class_id) AS assessment_in_class,
      EXISTS (SELECT 1 FROM class_students cs WHERE cs.class_id = cl.class_id AND cs.student_id = s.student_id) AS student_in_class,
      EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id AND ps.parent_id = $4) AS is_guardian,
      EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $4) AS is_co_teacher
    FROM classes cl
    CROSS JOIN students s
    LEFT JOIN assessments a ON a.assessment_id = $3
    WHERE cl.class_id = $2 AND s.student_id = $1
  `,

  // $1 student_id, $2 class_id, $3 assessment_id
  findConversationByAnchor: `
    SELECT conversation_id, status FROM conversations
    WHERE student_id = $1 AND class_id = $2 AND assessment_id = $3
  `,

  // $1 school, $2 student_id, $3 class_id, $4 assessment_id, $5 title, $6 created_by
  insertConversation: `
    INSERT INTO conversations (school, student_id, class_id, assessment_id, title, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING conversation_id
  `,

  // $1 conversation_id, $2 sender_id, $3 sender_role, $4 kind, $5 body
  insertMessage: `
    INSERT INTO messages (conversation_id, sender_id, sender_role, kind, body)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING message_id, created_at
  `,

  // $1 message_id, $2 file_path, $3 file_name, $4 mime_type, $5 size_bytes
  insertAttachment: `
    INSERT INTO message_attachments (message_id, file_path, file_name, mime_type, size_bytes)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING attachment_id
  `,

  // A new message bumps the thread and reopens it. $1 conversation_id
  touchConversation: `
    UPDATE conversations
    SET last_message_at = NOW(), status = 'open', resolved_by = NULL, resolved_at = NULL
    WHERE conversation_id = $1
  `,

  // $1 conversation_id, $2 status, $3 user_id
  updateConversationStatus: `
    UPDATE conversations
    SET status = $2::text,
        resolved_by = CASE WHEN $2::text = 'resolved' THEN $3::uuid ELSE NULL END,
        resolved_at = CASE WHEN $2::text = 'resolved' THEN NOW() ELSE NULL END
    WHERE conversation_id = $1
    RETURNING status
  `,

  listForParent: listBody(PARENT_SCOPE),
  listForTeacher: listBody(TEACHER_SCOPE),
  listForAdmin: listBody('TRUE'),

  // Badge. $1 user_id, $2 school, $3 role
  selectUnreadSummary: `
    WITH mine AS (
      SELECT c.conversation_id, cp.last_read_at
      FROM conversations c
      JOIN classes cl ON cl.class_id = c.class_id
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
      WHERE c.school = $2 AND c.status = 'open' AND (
        ($3 = 'PARENT' AND EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = c.student_id AND ps.parent_id = $1))
        OR ($3 = 'TEACHER' AND (cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1)))
        OR ($3 = 'ADMIN' AND (cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1)
                              OR EXISTS (SELECT 1 FROM conversation_participants cp2 WHERE cp2.conversation_id = c.conversation_id AND cp2.user_id = $1)))
      )
    ),
    per AS (
      SELECT
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.kind = 'message'
           AND m.deleted_at IS NULL AND m.sender_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(mine.last_read_at, '-infinity'::timestamptz)) AS unread,
        (SELECT CASE WHEN $3 = 'PARENT' THEN lm.sender_role <> 'PARENT' ELSE lm.sender_role = 'PARENT' END
           FROM messages lm WHERE lm.conversation_id = mine.conversation_id AND lm.kind = 'message' AND lm.deleted_at IS NULL
           ORDER BY lm.created_at DESC LIMIT 1) AS needs_reply
      FROM mine
    )
    SELECT
      COUNT(*) FILTER (WHERE unread > 0)::int AS unread_conversations,
      COALESCE(SUM(unread), 0)::int AS unread_messages,
      COUNT(*) FILTER (WHERE needs_reply)::int AS needs_reply
    FROM per
  `,

  // $1 conversation_id
  selectMessages: `
    SELECT m.message_id, m.sender_id, m.sender_role, m.kind, m.body, m.created_at, m.edited_at, m.deleted_at,
           TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS sender_name,
           (SELECT ps.relation FROM parent_students ps
             JOIN conversations c ON c.conversation_id = m.conversation_id
             WHERE ps.parent_id = m.sender_id AND ps.student_id = c.student_id LIMIT 1) AS sender_relation
    FROM messages m
    LEFT JOIN users u ON u.user_id = m.sender_id
    WHERE m.conversation_id = $1
    ORDER BY m.created_at ASC
  `,

  // $1 message_id[]
  selectAttachmentsByMessageIds: `
    SELECT attachment_id, message_id, file_path, file_name, mime_type, size_bytes
    FROM message_attachments WHERE message_id = ANY($1::uuid[])
    ORDER BY created_at
  `,

  // $1 attachment_id, $2 conversation_id
  selectAttachment: `
    SELECT ma.attachment_id, ma.file_path, ma.file_name, ma.mime_type
    FROM message_attachments ma JOIN messages m ON m.message_id = ma.message_id
    WHERE ma.attachment_id = $1 AND m.conversation_id = $2 AND m.deleted_at IS NULL
  `,

  // Display list: guardians with accounts, lead + co-teachers, admins who joined. $1 conversation_id
  selectParticipants: `
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name, u.role, ps.relation
    FROM conversations c
    JOIN parent_students ps ON ps.student_id = c.student_id AND ps.parent_id IS NOT NULL
    JOIN users u ON u.user_id = ps.parent_id
    WHERE c.conversation_id = $1
    UNION
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.role, NULL
    FROM conversations c JOIN classes cl ON cl.class_id = c.class_id JOIN users u ON u.user_id = cl.teacher_id
    WHERE c.conversation_id = $1
    UNION
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.role, NULL
    FROM conversations c JOIN class_teachers ct ON ct.class_id = c.class_id JOIN users u ON u.user_id = ct.teacher_id
    WHERE c.conversation_id = $1
    UNION
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.role, NULL
    FROM conversation_participants cp JOIN users u ON u.user_id = cp.user_id
    WHERE cp.conversation_id = $1 AND u.role = 'ADMIN'
  `,

  // Score context. $1 assessment_id, $2 student_id
  selectAssessmentContext: `
    SELECT a.assessment_id, a.name, a.date, a.weight_points, a.max_score, a.is_published, a.parent_comment, a.published_at,
           sa.score,
           (SELECT ROUND(AVG(x.score / NULLIF(a.max_score, 0) * 100)::numeric, 1)
              FROM student_assessments x WHERE x.assessment_id = a.assessment_id AND x.score IS NOT NULL) AS class_avg_pct
    FROM assessments a
    LEFT JOIN student_assessments sa ON sa.assessment_id = a.assessment_id AND sa.student_id = $2
    WHERE a.assessment_id = $1
  `,

  // $1 conversation_id, $2 user_id
  selectParticipantState: `
    SELECT last_read_at, last_emailed_at, muted FROM conversation_participants
    WHERE conversation_id = $1 AND user_id = $2
  `,
  upsertParticipantRead: `
    INSERT INTO conversation_participants (conversation_id, user_id, last_read_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()
    RETURNING last_read_at
  `,
  // $1 conversation_id, $2 user_id, $3 muted
  upsertParticipantMuted: `
    INSERT INTO conversation_participants (conversation_id, user_id, muted)
    VALUES ($1, $2, $3)
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET muted = EXCLUDED.muted
    RETURNING muted
  `,
  ensureParticipant: `
    INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING
  `,

  // $1 message_id, $2 conversation_id
  selectMessageForMutation: `
    SELECT message_id, sender_id, kind, created_at, deleted_at FROM messages
    WHERE message_id = $1 AND conversation_id = $2
  `,
  // $1 message_id, $2 body
  updateMessageBody: `
    UPDATE messages SET body = $2, edited_at = NOW() WHERE message_id = $1 RETURNING edited_at
  `,
  // $1 message_id, $2 user_id
  softDeleteMessage: `
    UPDATE messages SET deleted_at = NOW(), deleted_by = $2 WHERE message_id = $1 RETURNING deleted_at
  `,
  // $1 message_id
  selectAttachmentPathsByMessage: `
    SELECT file_path FROM message_attachments WHERE message_id = $1
  `,
  deleteAttachmentsByMessage: `
    DELETE FROM message_attachments WHERE message_id = $1
  `,

  // ── Outbox ──────────────────────────────────────────────────
  // $1 conversation_id, $2 recipient_id[], $3 school, $4 delay (interval text, e.g. '2 minutes')
  enqueueEmailJobs: `
    INSERT INTO message_email_jobs (conversation_id, recipient_id, school, send_after)
    SELECT $1, r, $3, NOW() + $4::interval FROM UNNEST($2::uuid[]) AS r
    ON CONFLICT DO NOTHING
  `,
  // $1 conversation_id, $2 recipient_id
  cancelPendingJob: `
    UPDATE message_email_jobs SET status = 'skipped', last_error = 'read before send'
    WHERE conversation_id = $1 AND recipient_id = $2 AND status = 'pending'
  `,
  // Claim by pushing send_after forward so another instance leaves it alone
  // while this one works; a crash mid-send simply retries in 5 minutes.
  claimDueJob: `
    UPDATE message_email_jobs
    SET attempts = attempts + 1, send_after = NOW() + interval '5 minutes'
    WHERE job_id = (
      SELECT job_id FROM message_email_jobs
      WHERE status = 'pending' AND send_after <= NOW()
      ORDER BY send_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING job_id, conversation_id, recipient_id, school, attempts
  `,
  // $1 job_id
  selectJobContext: `
    SELECT
      j.job_id, j.conversation_id, j.recipient_id, j.school, j.attempts,
      u.email AS recipient_email, u.first_name AS recipient_first_name, u.role AS recipient_role, u.is_archived AS recipient_archived,
      c.title, c.assessment_id, c.student_id, c.last_message_at,
      s.name AS student_name, cl.subject AS class_subject,
      cp.last_read_at, cp.last_emailed_at, COALESCE(cp.muted, FALSE) AS muted
    FROM message_email_jobs j
    JOIN users u ON u.user_id = j.recipient_id
    JOIN conversations c ON c.conversation_id = j.conversation_id
    JOIN students s ON s.student_id = c.student_id
    JOIN classes cl ON cl.class_id = c.class_id
    LEFT JOIN conversation_participants cp ON cp.conversation_id = j.conversation_id AND cp.user_id = j.recipient_id
    WHERE j.job_id = $1
  `,
  // $1 conversation_id, $2 recipient_id, $3 since timestamptz|null
  selectMessagesForEmail: `
    SELECT m.message_id, m.body, m.created_at,
           TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS sender_name,
           (SELECT COUNT(*) FROM message_attachments ma WHERE ma.message_id = m.message_id)::int AS attachment_count
    FROM messages m LEFT JOIN users u ON u.user_id = m.sender_id
    WHERE m.conversation_id = $1 AND m.kind = 'message' AND m.deleted_at IS NULL
      AND m.sender_id IS DISTINCT FROM $2
      AND m.created_at > COALESCE($3::timestamptz, '-infinity'::timestamptz)
    ORDER BY m.created_at ASC
  `,
  // $1 job_id, $2 status, $3 last_error|null
  finishJob: `
    UPDATE message_email_jobs
    SET status = $2::text, last_error = $3, sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END
    WHERE job_id = $1
  `,
  // $1 job_id, $2 error, $3 max_attempts
  retryOrFailJob: `
    UPDATE message_email_jobs
    SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
        last_error = $2,
        send_after = NOW() + (attempts * interval '5 minutes')
    WHERE job_id = $1
  `,
  // $1 conversation_id, $2 recipient_id
  markEmailed: `
    INSERT INTO conversation_participants (conversation_id, user_id, last_emailed_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_emailed_at = NOW()
  `,

  // ── Pickers and chips ───────────────────────────────────────
  // Parent picker. $1 student_id, $2 school_year_id|null
  selectParentTargets: `
    SELECT cl.class_id, cl.subject, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS teacher_name,
           a.assessment_id, a.name AS assessment_name, a.date, a.is_published,
           cv.conversation_id
    FROM class_students cs
    JOIN classes cl ON cl.class_id = cs.class_id
    LEFT JOIN users u ON u.user_id = cl.teacher_id
    LEFT JOIN assessments a ON a.class_id = cl.class_id AND a.is_published = TRUE AND COALESCE(a.is_parent, FALSE) = FALSE
    LEFT JOIN conversations cv ON cv.student_id = cs.student_id AND cv.assessment_id = a.assessment_id
    WHERE cs.student_id = $1 AND ($2::uuid IS NULL OR cl.school_year_id = $2)
    ORDER BY cl.subject, a.sort_order NULLS LAST, a.name
  `,
  // Staff picker. $1 class_id
  selectTeacherTargetStudents: `
    SELECT s.student_id, s.name,
           COALESCE(json_agg(json_build_object(
                      'name', COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name),
                      'relation', ps.relation,
                      'hasAccount', ps.parent_id IS NOT NULL))
                    FILTER (WHERE ps.parent_student_link_id IS NOT NULL), '[]') AS guardians
    FROM class_students cs
    JOIN students s ON s.student_id = cs.student_id
    LEFT JOIN parent_students ps ON ps.student_id = s.student_id
    LEFT JOIN users u ON u.user_id = ps.parent_id
    WHERE cs.class_id = $1
    GROUP BY s.student_id, s.name
    ORDER BY s.name
  `,
  selectTeacherTargetAssessments: `
    SELECT assessment_id, name, date, is_published FROM assessments
    WHERE class_id = $1 AND COALESCE(is_parent, FALSE) = FALSE
    ORDER BY sort_order NULLS LAST, name
  `,

  // Chips. $1 user_id, $2 class_id|null, $3 student_id|null
  selectStubs: `
    SELECT c.conversation_id, c.student_id, c.class_id, c.assessment_id, c.status,
           ${UNREAD_COUNT_EXPR} AS unread_count
    FROM conversations c
    LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
    WHERE ($2::uuid IS NULL OR c.class_id = $2) AND ($3::uuid IS NULL OR c.student_id = $3)
  `,

  // Admin oversight: threads with a failed email. $1 conversation_id[]
  selectFailedEmailConversations: `
    SELECT DISTINCT conversation_id FROM message_email_jobs WHERE status = 'failed' AND conversation_id = ANY($1::uuid[])
  `,
};

module.exports = messagingQueries;
