// queries/messaging.queries.js
//
// Parent–teacher conversations. Membership is never stored: every access
// query re-derives it from the same three sources — parent_students
// (guardians), classes.teacher_id (lead) and class_teachers (co-teachers) —
// so a guardian linked after a thread began sees it immediately. See
// middleware/requireConversationAccess.js.
//
// Student portal (T17): a conversation may also include the student
// (includes_student, new threads only: every older parent–teacher thread
// stays between the adults) through the student's login
// (student_account_links), and may be anchored to one piece of classwork
// (classwork_item_id, "private comments" on that work). Guardians are always
// derived into a student's thread; a school may hide item threads from them
// (school_classroom_settings.parents_read_private_comments = FALSE).

// Current-term gate for starting threads (see termScope.js).
const { inCurrentTerm, selectCurrentTerm } = require('./termScope');
const { GRADE_RANK } = require('../utils/gradeRank');
const { studentAvatarSql, studentPhotoSql } = require('../utils/avatar');

// An item thread the school keeps from guardians. `c` is the conversations
// alias. Never true for a thread with no classwork anchor, so every
// parent–teacher thread keeps its guardians.
const GUARDIANS_HIDDEN = "(c.classwork_item_id IS NOT NULL AND NOT COALESCE((SELECT scs.parents_read_private_comments FROM school_classroom_settings scs WHERE scs.school = c.school), TRUE))";

// The "who can see this conversation" projection, shared by the guard and
// the thread endpoint. $1 conversation_id
const CONVERSATION_ACCESS_SELECT = `
  SELECT
    c.conversation_id, c.school, c.student_id, c.class_id, c.assessment_id,
    c.kind, c.teacher_id,
    c.title, c.status, c.created_by, c.resolved_by, c.resolved_at,
    c.last_message_at, c.created_at,
    s.name          AS student_name,
    s.school_year_id,
    COALESCE(cl.subject, NULLIF(lt.staff_title, ''), 'Homeroom') AS class_subject,
    COALESCE(cl.teacher_id, c.teacher_id) AS lead_teacher_id,
    COALESCE((SELECT ARRAY_AGG(ct.teacher_id) FROM class_teachers ct WHERE ct.class_id = c.class_id), '{}')::uuid[] AS co_teacher_ids,
    COALESCE((SELECT ARRAY_AGG(ps.parent_id) FROM parent_students ps
              WHERE ps.student_id = c.student_id AND ps.parent_id IS NOT NULL), '{}')::uuid[] AS guardian_ids,
    -- Office staff who joined (messages.all, RBAC): staff who are not the
    -- thread's own teachers and have written in it. A teacher holding
    -- messages.all counts too. Reading joins nothing: opening a thread only
    -- leaves a read mark in conversation_participants.
    COALESCE((SELECT ARRAY_AGG(DISTINCT u.user_id) FROM messages wm
              JOIN users u ON u.user_id = wm.sender_id
              WHERE wm.conversation_id = c.conversation_id AND wm.kind = 'message'
                AND u.role::text IN ('ADMIN', 'TEACHER')
                AND u.user_id IS DISTINCT FROM COALESCE(cl.teacher_id, c.teacher_id)
                AND NOT EXISTS (SELECT 1 FROM class_teachers ct2 WHERE ct2.class_id = c.class_id AND ct2.teacher_id = u.user_id)
             ), '{}')::uuid[] AS admin_participant_ids,
    c.includes_student, c.classwork_item_id,
    CASE WHEN c.includes_student THEN COALESCE((SELECT ARRAY_AGG(sal.user_id) FROM student_account_links sal
           JOIN users su ON su.user_id = sal.user_id AND su.is_archived = FALSE
          WHERE sal.student_id = c.student_id), '{}') ELSE '{}' END::uuid[] AS student_user_ids,
    ${GUARDIANS_HIDDEN} AS guardians_hidden
  FROM conversations c
  JOIN students s  ON s.student_id = c.student_id
  LEFT JOIN classes cl ON cl.class_id = c.class_id
  LEFT JOIN users lt ON lt.user_id = c.teacher_id
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

// Who spoke last, ignoring removed and system lines — what "needs reply" means.
const LAST_REAL_SENDER_SQL = `
  (SELECT lr.sender_role FROM messages lr
   WHERE lr.conversation_id = c.conversation_id AND lr.kind = 'message' AND lr.deleted_at IS NULL
   ORDER BY lr.created_at DESC LIMIT 1) AS last_real_sender_role
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
    c.conversation_id, c.student_id, c.class_id, c.assessment_id, c.kind, c.teacher_id, c.title, c.status,
    c.last_message_at, c.created_at, c.includes_student, c.classwork_item_id,
    s.name AS student_name, COALESCE(cl.subject, NULLIF(lt.staff_title, ''), 'Homeroom') AS class_subject,
    ${studentAvatarSql('s', 'student_avatar')},
    ${studentPhotoSql('s', 'student_photo_path')},
    TRIM(CONCAT(lt.first_name, ' ', lt.last_name)) AS lead_teacher_name,
    lt.avatar AS lead_teacher_avatar, lt.photo_path AS lead_teacher_photo_path,
    -- Who the thread is addressed to: its own teacher (a student's co-teacher,
    -- homeroom teacher or teaching admin), else the class lead.
    NULLIF(TRIM(CONCAT(adr.first_name, ' ', adr.last_name)), '') AS addressee_name,
    cl.term_name,
    -- No guardian names on an item thread the school keeps from guardians (they aren't in it).
    CASE WHEN ${GUARDIANS_HIDDEN} THEN '{}'::text[] ELSE
    COALESCE((SELECT ARRAY_AGG(DISTINCT COALESCE(NULLIF(TRIM(CONCAT(gu.first_name, ' ', gu.last_name)), ''), ps.parent_name))
              FROM parent_students ps LEFT JOIN users gu ON gu.user_id = ps.parent_id
              WHERE ps.student_id = c.student_id AND COALESCE(NULLIF(TRIM(CONCAT(gu.first_name, ' ', gu.last_name)), ''), ps.parent_name) IS NOT NULL), '{}')::text[]
    END AS guardian_names,
    cp.last_read_at,
    ${UNREAD_COUNT_EXPR} AS unread_count,
    ${LAST_REAL_SENDER_SQL},
    ${LAST_MESSAGE_SQL}
  FROM conversations c
  JOIN students s  ON s.student_id = c.student_id
  LEFT JOIN classes cl ON cl.class_id = c.class_id
  LEFT JOIN users lt ON lt.user_id = COALESCE(cl.teacher_id, c.teacher_id)
  LEFT JOIN users adr ON adr.user_id = COALESCE(c.teacher_id, cl.teacher_id)
  LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
  WHERE c.school = $2
    AND ($3::uuid IS NULL OR s.school_year_id = $3)
    AND ($4::text IS NULL OR c.status = $4 OR ($4::text = 'open' AND ${UNREAD_COUNT_EXPR} > 0))
    AND ($5::uuid IS NULL OR c.class_id = $5)
    AND ($6::uuid IS NULL OR c.student_id = $6)
    AND ($7::text IS NULL OR s.name ILIKE '%' || $7 || '%' OR c.title ILIKE '%' || $7 || '%' OR cl.subject ILIKE '%' || $7 || '%' OR lt.staff_title ILIKE '%' || $7 || '%')
    AND ($9::boolean IS FALSE OR ${UNREAD_COUNT_EXPR} > 0)
    AND (${scopeSql})
  ORDER BY c.last_message_at DESC
  LIMIT $8
`;

// A guardian's threads: their children's, minus item threads the school keeps from guardians.
const PARENT_SCOPE = `EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = c.student_id AND ps.parent_id = $1) AND NOT ${GUARDIANS_HIDDEN}`;
const TEACHER_SCOPE = `cl.teacher_id = $1 OR c.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1)`;
// A student's threads: only those that include the student, through the
// caller's own login (any year's link, so last year's threads stay theirs).
// An older parent–teacher thread about them never matches.
const STUDENT_SCOPE = "c.includes_student AND EXISTS (SELECT 1 FROM student_account_links sal WHERE sal.user_id = $1 AND sal.student_id = c.student_id)";

const messagingQueries = {
  selectConversationAccess: `${CONVERSATION_ACCESS_SELECT} WHERE c.conversation_id = $1`,

  // The current term: the school's active term, provided it belongs to the
  // selected school year. $1 school, $2 school_year_id|null
  selectCurrentTerm,

  // Everything needed to validate a new thread in one round trip.
  // $1 student_id, $2 class_id, $3 assessment_id, $4 user_id, $5 current term_id|null, $6 current term name|null
  selectAnchorContext: `
    SELECT
      cl.class_id, cl.school, cl.subject AS class_subject, cl.teacher_id AS lead_teacher_id,
      ${inCurrentTerm('cl', '$5', '$6')} AS in_current_term,
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
  // Upsert on the anchor: two guardians pressing "Ask the teacher" at the same
  // moment both land in one thread instead of the second hitting the unique index.
  insertConversation: `
    INSERT INTO conversations (school, student_id, class_id, assessment_id, title, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (student_id, class_id, assessment_id) WHERE assessment_id IS NOT NULL
      DO UPDATE SET title = conversations.title
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
  listForStudent: listBody(STUDENT_SCOPE),

  // Badge. $1 user_id, $2 school, $3 role
  selectUnreadSummary: `
    WITH mine AS (
      SELECT c.conversation_id, c.status, cp.last_read_at
      FROM conversations c
      LEFT JOIN classes cl ON cl.class_id = c.class_id
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
      WHERE c.school = $2 AND (
        ($3 = 'PARENT' AND EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = c.student_id AND ps.parent_id = $1)
                       AND NOT ${GUARDIANS_HIDDEN})
        OR ($3 = 'TEACHER' AND (cl.teacher_id = $1 OR c.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1)))
        OR ($3 = 'ADMIN' AND (cl.teacher_id = $1 OR c.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $1)
                              OR EXISTS (SELECT 1 FROM messages wm WHERE wm.conversation_id = c.conversation_id AND wm.sender_id = $1 AND wm.kind = 'message')))
      )
    ),
    per AS (
      SELECT
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.kind = 'message'
           AND m.deleted_at IS NULL AND m.sender_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(mine.last_read_at, '-infinity'::timestamptz)) AS unread,
        (mine.status = 'open' AND COALESCE((SELECT CASE WHEN $3 = 'PARENT' THEN lm.sender_role NOT IN ('PARENT', 'STUDENT') ELSE lm.sender_role IN ('PARENT', 'STUDENT') END
           FROM messages lm WHERE lm.conversation_id = mine.conversation_id AND lm.kind = 'message' AND lm.deleted_at IS NULL
           ORDER BY lm.created_at DESC LIMIT 1), FALSE)) AS needs_reply
      FROM mine
    )
    SELECT
      COUNT(*) FILTER (WHERE unread > 0)::int AS unread_conversations,
      COALESCE(SUM(unread), 0)::int AS unread_messages,
      COUNT(*) FILTER (WHERE needs_reply)::int AS needs_reply,
      -- The sidebar badge: staff threads stay lit until answered, read or not;
      -- a guardian's only while unread (a teacher's last word is no task).
      COUNT(*) FILTER (WHERE unread > 0 OR ($3 <> 'PARENT' AND needs_reply))::int AS attention_conversations
    FROM per
  `,

  // The student's badge: the parent badge's shape over the student's own
  // threads (STUDENT_SCOPE), for the same school year the list shows.
  // $1 user_id, $2 school, $3 school_year_id|null
  selectStudentUnreadSummary: `
    WITH mine AS (
      SELECT c.conversation_id, c.status, cp.last_read_at
      FROM conversations c
      JOIN students s ON s.student_id = c.student_id
      LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
      WHERE c.school = $2 AND ($3::uuid IS NULL OR s.school_year_id = $3) AND ${STUDENT_SCOPE}
    ),
    per AS (
      SELECT
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = mine.conversation_id AND m.kind = 'message'
           AND m.deleted_at IS NULL AND m.sender_id IS DISTINCT FROM $1
           AND m.created_at > COALESCE(mine.last_read_at, '-infinity'::timestamptz)) AS unread,
        (mine.status = 'open' AND COALESCE((SELECT lm.sender_role NOT IN ('PARENT', 'STUDENT')
           FROM messages lm WHERE lm.conversation_id = mine.conversation_id AND lm.kind = 'message' AND lm.deleted_at IS NULL
           ORDER BY lm.created_at DESC LIMIT 1), FALSE)) AS needs_reply
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
           COALESCE(u.avatar, CASE WHEN m.sender_role = 'STUDENT' THEN
             (SELECT st.avatar FROM conversations sc JOIN students st ON st.student_id = sc.student_id
               WHERE sc.conversation_id = m.conversation_id) END) AS sender_avatar,
           u.photo_path AS sender_photo_path,
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

  // Display list: guardians with accounts (unless the school keeps this item
  // thread from them), the student when the thread includes them (their
  // login, not archived; avatar by the student display rule), lead +
  // co-teachers, admins who joined. $1 conversation_id
  selectParticipants: `
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name, u.role, ps.relation, (u.password = '!') AS invite_pending, u.avatar, u.photo_path
    FROM conversations c
    JOIN parent_students ps ON ps.student_id = c.student_id AND ps.parent_id IS NOT NULL
    JOIN users u ON u.user_id = ps.parent_id
    WHERE c.conversation_id = $1 AND NOT ${GUARDIANS_HIDDEN}
    UNION
    SELECT u.user_id, COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), st.name), u.role, 'student', FALSE,
           COALESCE(u.avatar, st.avatar), u.photo_path
    FROM conversations c
    JOIN students st ON st.student_id = c.student_id
    JOIN student_account_links sal ON sal.student_id = c.student_id
    JOIN users u ON u.user_id = sal.user_id AND u.is_archived = FALSE
    WHERE c.conversation_id = $1 AND c.includes_student
    UNION
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.role, NULL, FALSE, u.avatar, u.photo_path
    FROM conversations c LEFT JOIN classes cl ON cl.class_id = c.class_id
    JOIN users u ON u.user_id = COALESCE(cl.teacher_id, c.teacher_id)
    WHERE c.conversation_id = $1
    UNION
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.role, NULL, FALSE, u.avatar, u.photo_path
    FROM conversations c JOIN class_teachers ct ON ct.class_id = c.class_id JOIN users u ON u.user_id = ct.teacher_id
    WHERE c.conversation_id = $1
    UNION
    SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.role, NULL, FALSE, u.avatar, u.photo_path
    FROM messages m JOIN users u ON u.user_id = m.sender_id
    WHERE m.conversation_id = $1 AND m.kind = 'message' AND u.role::text IN ('ADMIN', 'TEACHER')
  `,

  // Score context. $1 assessment_id, $2 student_id
  selectAssessmentContext: `
    SELECT a.assessment_id, a.name, a.date, a.weight_points, a.max_score, a.is_published, a.parent_comment, a.published_at,
           sa.score,
           sa.status,
           (SELECT ROUND(AVG(CASE WHEN x.status = 'missing' THEN 0 ELSE x.score / NULLIF(a.max_score, 0) * 100 END)::numeric, 1)
              FROM student_assessments x
              WHERE x.assessment_id = a.assessment_id
                AND x.status <> 'excused'
                AND (x.score IS NOT NULL OR x.status = 'missing')) AS class_avg_pct
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
  // $1 job_id. since_exact is the later of last_emailed_at / last_read_at as text: a JS Date
  // would cut Postgres microseconds to milliseconds and re-select an already-emailed message.
  selectJobContext: `
    SELECT
      j.job_id, j.conversation_id, j.recipient_id, j.school, j.attempts,
      u.email AS recipient_email, u.first_name AS recipient_first_name, u.role AS recipient_role, u.is_archived AS recipient_archived,
      (u.password = '!') AS recipient_invite_pending,
      c.title, c.assessment_id, c.kind, c.student_id, c.last_message_at, c.classwork_item_id,
      s.name AS student_name, COALESCE(cl.subject, NULLIF(lt.staff_title, ''), 'Homeroom') AS class_subject,
      cp.last_read_at, cp.last_emailed_at, COALESCE(cp.muted, FALSE) AS muted,
      -- Student threads (T17), re-checked at send time: a guardian on an item
      -- thread the school now keeps from guardians, a student no longer in
      -- the thread, or a school that doesn't email the student's grade, is
      -- skipped.
      c.includes_student, ${GUARDIANS_HIDDEN} AS guardians_hidden,
      (c.includes_student AND EXISTS (SELECT 1 FROM student_account_links sal
         WHERE sal.user_id = j.recipient_id AND sal.student_id = c.student_id)) AS recipient_in_thread,
      EXISTS (SELECT 1 FROM parent_students ps JOIN users gu ON gu.user_id = ps.parent_id AND gu.is_archived = FALSE
         WHERE ps.student_id = c.student_id) AS has_guardians,
      EXISTS (SELECT 1 FROM school_classroom_settings scs
         WHERE scs.school = s.school AND scs.enabled AND scs.student_email_from_grade IS NOT NULL
           AND ${GRADE_RANK('s.grade::text')} >= ${GRADE_RANK('scs.student_email_from_grade')}) AS student_email_on,
      GREATEST(cp.last_emailed_at, cp.last_read_at)::text AS since_exact
    FROM message_email_jobs j
    JOIN users u ON u.user_id = j.recipient_id
    JOIN conversations c ON c.conversation_id = j.conversation_id
    JOIN students s ON s.student_id = c.student_id
    LEFT JOIN classes cl ON cl.class_id = c.class_id
    LEFT JOIN users lt ON lt.user_id = c.teacher_id
    LEFT JOIN conversation_participants cp ON cp.conversation_id = j.conversation_id AND cp.user_id = j.recipient_id
    WHERE j.job_id = $1
  `,
  // $1 conversation_id, $2 recipient_id, $3 since timestamptz|null (pass the exact text, never a JS Date).
  // created_at_exact keeps the microseconds for markEmailed and the next "since".
  selectMessagesForEmail: `
    SELECT m.message_id, m.body, m.created_at, m.created_at::text AS created_at_exact, m.sender_role::text AS sender_role,
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
  // $1 conversation_id, $2 recipient_id, $3 created_at_exact of the last message in the digest.
  // Never NOW(): a message posted while the email was being sent would be skipped forever.
  // Never a JS Date either: at millisecond precision the same message reads as unsent and is emailed again.
  markEmailed: `
    INSERT INTO conversation_participants (conversation_id, user_id, last_emailed_at)
    VALUES ($1, $2, $3::timestamptz)
    ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_emailed_at = GREATEST(conversation_participants.last_emailed_at, EXCLUDED.last_emailed_at)
  `,

  // ── Pickers and chips ───────────────────────────────────────
  // Parent picker: the child's current-term classes. $1 student_id, $2 school_year_id|null,
  // $3 current term_id|null, $4 current term name|null
  selectParentTargets: `
    SELECT cl.class_id, cl.subject, cl.teacher_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS teacher_name,
           a.assessment_id, a.name AS assessment_name, a.date, a.is_published,
           cv.conversation_id
    FROM class_students cs
    JOIN classes cl ON cl.class_id = cs.class_id
    LEFT JOIN users u ON u.user_id = cl.teacher_id
    LEFT JOIN assessments a ON a.class_id = cl.class_id AND a.is_published = TRUE AND COALESCE(a.is_parent, FALSE) = FALSE
    LEFT JOIN conversations cv ON cv.student_id = cs.student_id AND cv.assessment_id = a.assessment_id
    WHERE cs.student_id = $1 AND ($2::uuid IS NULL OR cl.school_year_id = $2) AND ${inCurrentTerm('cl', '$3', '$4')}
    ORDER BY cl.subject, a.sort_order NULLS LAST, a.name
  `,
  // Staff picker. $1 class_id
  selectTeacherTargetStudents: `
    SELECT s.student_id, s.name,
           COALESCE(json_agg(json_build_object(
                      'linkId', ps.parent_student_link_id,
                      'name', COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name),
                      'relation', ps.relation,
                      'email', COALESCE(u.email, ps.parent_email),
                      'hasAccount', ps.parent_id IS NOT NULL AND COALESCE(u.password, '') <> '!',
                      'invitePending', ps.parent_id IS NOT NULL AND u.password = '!',
                      'invitedAt', ps.invited_at))
                    FILTER (WHERE ps.parent_student_link_id IS NOT NULL), '[]') AS guardians
    FROM class_students cs
    JOIN students s ON s.student_id = cs.student_id
    LEFT JOIN parent_students ps ON ps.student_id = s.student_id
    LEFT JOIN users u ON u.user_id = ps.parent_id
    WHERE cs.class_id = $1
    GROUP BY s.student_id, s.name
    ORDER BY s.name
  `,
  // Same guardian summary for a single student (Students page). $1 student_id
  selectTeacherTargetStudentsOne: `
    SELECT s.student_id, s.name,
           COALESCE(json_agg(json_build_object(
                      'linkId', ps.parent_student_link_id,
                      'name', COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name),
                      'relation', ps.relation,
                      'email', COALESCE(u.email, ps.parent_email),
                      'hasAccount', ps.parent_id IS NOT NULL AND COALESCE(u.password, '') <> '!',
                      'invitePending', ps.parent_id IS NOT NULL AND u.password = '!',
                      'invitedAt', ps.invited_at))
                    FILTER (WHERE ps.parent_student_link_id IS NOT NULL), '[]') AS guardians
    FROM students s
    LEFT JOIN parent_students ps ON ps.student_id = s.student_id
    LEFT JOIN users u ON u.user_id = ps.parent_id
    WHERE s.student_id = $1
    GROUP BY s.student_id, s.name
  `,
  selectTeacherTargetAssessments: `
    SELECT assessment_id, name, date, is_published FROM assessments
    WHERE class_id = $1 AND COALESCE(is_parent, FALSE) = FALSE
    ORDER BY sort_order NULLS LAST, name
  `,

  // Chips. $1 user_id, $2 class_id|null, $3 student_id|null, $4 school,
  // $5 caller role (a guardian never learns of an item thread kept from guardians)
  selectStubs: `
    SELECT c.conversation_id, c.student_id, c.class_id, c.assessment_id, c.status,
           ${UNREAD_COUNT_EXPR} AS unread_count
    FROM conversations c
    LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = $1
    WHERE c.school = $4 AND ($2::uuid IS NULL OR c.class_id = $2) AND ($3::uuid IS NULL OR c.student_id = $3)
      AND ($5::text IS DISTINCT FROM 'PARENT' OR NOT ${GUARDIANS_HIDDEN})
  `,

  // ── Phase 2: general threads ────────────────────────────────
  // Everything needed to start a general thread between a student and a
  // teacher. Class matches are current-term only; the homeroom link is not
  // term-bound. $1 student_id, $2 teacher_id, $3 caller user_id,
  // $4 school_year_id|null, $5 current term_id|null, $6 current term name|null
  selectGeneralAnchorContext: `
    SELECT
      s.student_id, s.name AS student_name, s.school AS student_school,
      t.school AS teacher_school, t.role AS teacher_role, t.is_archived AS teacher_archived,
      NULLIF(t.staff_title, '') AS teacher_staff_title,
      TRIM(CONCAT(t.first_name, ' ', t.last_name)) AS teacher_name,
      (s.homeroom_teacher_id = $2) AS is_homeroom,
      (SELECT cl.class_id FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
        WHERE cs.student_id = s.student_id AND ($4::uuid IS NULL OR cl.school_year_id = $4) AND ${inCurrentTerm('cl', '$5', '$6')}
          AND (cl.teacher_id = $2 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $2))
        ORDER BY cl.subject LIMIT 1) AS class_id,
      EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id AND ps.parent_id = $3) AS is_guardian,
      (s.homeroom_teacher_id = $3 OR EXISTS (SELECT 1 FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
        WHERE cs.student_id = s.student_id AND ($4::uuid IS NULL OR cl.school_year_id = $4) AND ${inCurrentTerm('cl', '$5', '$6')}
          AND (cl.teacher_id = $3 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $3)))) AS caller_teaches
    FROM students s
    CROSS JOIN users t
    WHERE s.student_id = $1 AND t.user_id = $2
  `,
  // $1 school, $2 student_id, $3 class_id|null, $4 teacher_id, $5 title, $6 created_by
  insertGeneralConversation: `
    INSERT INTO conversations (school, student_id, class_id, teacher_id, assessment_id, kind, title, created_by)
    VALUES ($1, $2, $3, $4, NULL, 'general', $5, $6)
    RETURNING conversation_id
  `,
  // People a parent may write to about one child: the homeroom teacher, the
  // teachers of the child's current-term classes, then the school's admins
  // who carry a staff title (principal, vice principal). Homeroom and admins
  // are not term-bound. $1 student_id, $2 school_year_id|null,
  // $3 current term_id|null, $4 current term name|null
  selectParentTeacherTargets: `
    SELECT user_id, name, via, role FROM (
    SELECT DISTINCT ON (user_id) user_id, name, via, role, pri FROM (
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name, 'Homeroom' AS via, u.role, 0 AS pri
      FROM students s JOIN users u ON u.user_id = s.homeroom_teacher_id
      WHERE s.student_id = $1 AND u.is_archived = FALSE
      UNION ALL
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), cl.subject, u.role, 1
      FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id JOIN users u ON u.user_id = cl.teacher_id
      WHERE cs.student_id = $1 AND ($2::uuid IS NULL OR cl.school_year_id = $2) AND ${inCurrentTerm('cl', '$3', '$4')} AND u.is_archived = FALSE
      UNION ALL
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), cl.subject, u.role, 2
      FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
      JOIN class_teachers ct ON ct.class_id = cl.class_id JOIN users u ON u.user_id = ct.teacher_id
      WHERE cs.student_id = $1 AND ($2::uuid IS NULL OR cl.school_year_id = $2) AND ${inCurrentTerm('cl', '$3', '$4')} AND u.is_archived = FALSE
      UNION ALL
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.staff_title, u.role, 3
      FROM students s JOIN users u ON u.school = s.school
      WHERE s.student_id = $1 AND u.role = 'ADMIN' AND NULLIF(u.staff_title, '') IS NOT NULL AND u.is_archived = FALSE
    ) x
    ORDER BY user_id, pri, via
    ) y
    ORDER BY pri, name
  `,
  // Staff context strip for a general thread. $1 student_id
  selectStudentContext: `
    SELECT s.student_id, s.name, s.grade, ${studentAvatarSql('s', 'student_avatar')}, ${studentPhotoSql('s', 'student_photo_path')},
           TRIM(CONCAT(h.first_name, ' ', h.last_name)) AS homeroom_teacher_name,
           (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE ga.status = 'PRESENT') / NULLIF(COUNT(*), 0), 0)
              FROM general_attendance ga WHERE ga.student_id = s.student_id AND ga.attendance_date >= CURRENT_DATE - 60) AS attendance_pct
    FROM students s LEFT JOIN users h ON h.user_id = s.homeroom_teacher_id
    WHERE s.student_id = $1
  `,
  // Current-term classes a student is in this year, with whether the caller teaches each.
  // $1 student_id, $2 caller user_id, $3 school_year_id|null, $4 current term_id|null, $5 current term name|null
  selectStudentClassesForStaff: `
    SELECT cl.class_id, cl.subject, cl.grade,
           (cl.teacher_id = $2 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $2)) AS caller_teaches
    FROM class_students cs
    JOIN classes cl ON cl.class_id = cs.class_id
    WHERE cs.student_id = $1 AND ($3::uuid IS NULL OR cl.school_year_id = $3) AND ${inCurrentTerm('cl', '$4', '$5')}
    ORDER BY cl.subject
  `,
  // Leaf assessments for several classes. $1 class_id[]
  selectAssessmentsForClasses: `
    SELECT class_id, assessment_id, name, date, is_published FROM assessments
    WHERE class_id = ANY($1::uuid[]) AND COALESCE(is_parent, FALSE) = FALSE
    ORDER BY sort_order NULLS LAST, name
  `,
  // An explicit class for a General thread: must contain the student and be
  // taught by the thread's teacher. $1 class_id, $2 student_id, $3 teacher_id,
  // $4 current term_id|null, $5 current term name|null
  selectClassAnchorForGeneral: `
    SELECT cl.class_id, cl.school,
           EXISTS (SELECT 1 FROM class_students cs WHERE cs.class_id = cl.class_id AND cs.student_id = $2) AS has_student,
           ${inCurrentTerm('cl', '$4', '$5')} AS in_current_term,
           (cl.teacher_id = $3 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $3)) AS teacher_teaches
    FROM classes cl WHERE cl.class_id = $1
  `,
  // Staff "New message" with nothing in hand (the Messages page): the caller's
  // current-term classes (admin: every current-term class). $1 user_id, $2 school,
  // $3 role, $4 school_year_id|null, $5 current term_id|null, $6 current term name|null
  selectStaffRosterClasses: `
    SELECT cl.class_id, cl.subject, cl.grade::text AS grade, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS teacher_name
    FROM classes cl
    LEFT JOIN users u ON u.user_id = cl.teacher_id
    WHERE cl.school = $2 AND ($4::uuid IS NULL OR cl.school_year_id = $4) AND ${inCurrentTerm('cl', '$5', '$6')}
      AND ($3::text = 'ADMIN' OR cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $1))
    ORDER BY LENGTH(cl.grade::text), cl.grade::text, cl.subject
  `,
  // ...and the students they may write about: those classes' students plus the
  // caller's homeroom students (admin: every student of the year), each with the
  // guardian summary the picker shows and the ids of the roster classes they are in.
  // Same params as selectStaffRosterClasses.
  selectStaffRosterStudents: `
    SELECT s.student_id, s.name, s.grade::text AS grade,
      COALESCE((SELECT ARRAY_AGG(cs.class_id) FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
                 WHERE cs.student_id = s.student_id AND ($4::uuid IS NULL OR cl.school_year_id = $4) AND ${inCurrentTerm('cl', '$5', '$6')}
                   AND ($3::text = 'ADMIN' OR cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $1))), '{}')::uuid[] AS class_ids,
      COALESCE((SELECT json_agg(json_build_object(
                  'linkId', ps.parent_student_link_id,
                  'name', COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name),
                  'relation', ps.relation,
                  'email', COALESCE(u.email, ps.parent_email),
                  'hasAccount', ps.parent_id IS NOT NULL AND COALESCE(u.password, '') <> '!',
                  'invitePending', ps.parent_id IS NOT NULL AND u.password = '!',
                  'invitedAt', ps.invited_at))
                 FROM parent_students ps LEFT JOIN users u ON u.user_id = ps.parent_id
                WHERE ps.student_id = s.student_id), '[]') AS guardians
    FROM students s
    WHERE s.school = $2 AND s.is_archived IS NOT TRUE AND ($4::uuid IS NULL OR s.school_year_id = $4)
      AND ($3::text = 'ADMIN' OR s.homeroom_teacher_id = $1 OR EXISTS (
            SELECT 1 FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
            WHERE cs.student_id = s.student_id AND ($4::uuid IS NULL OR cl.school_year_id = $4) AND ${inCurrentTerm('cl', '$5', '$6')}
              AND (cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $1))))
    ORDER BY LENGTH(s.grade::text), s.grade::text, s.name
  `,
  // Staff opening the picker for one student (Students page). $1 student_id
  selectStudentForStaff: `
    SELECT s.student_id, s.name, s.school, s.homeroom_teacher_id
    FROM students s WHERE s.student_id = $1
  `,

  // ── Phase 2: guardian invites ───────────────────────────────
  // Link rows that have an email but no account. $1 student_id
  selectUnlinkedGuardians: `
    SELECT parent_student_link_id, parent_name, parent_email, relation, invited_at
    FROM parent_students
    WHERE student_id = $1 AND parent_id IS NULL AND parent_email IS NOT NULL AND TRIM(parent_email) <> ''
  `,
  // $1 email, $2 school
  selectUserByEmailInSchool: `
    SELECT user_id, role, password, is_archived FROM users
    WHERE LOWER(email) = LOWER($1) AND school = $2
    LIMIT 1
  `,
  // $1 link_id, $2 user_id, $3 invited_by, $4 conversation_id, $5 record_invite boolean
  linkGuardianToUser: `
    UPDATE parent_students
    SET parent_id = $2,
        invited_at = CASE WHEN $5::boolean THEN NOW() ELSE invited_at END,
        invited_by = CASE WHEN $5::boolean THEN $3::uuid ELSE invited_by END,
        invite_conversation_id = CASE WHEN $5::boolean THEN $4::uuid ELSE invite_conversation_id END
    WHERE parent_student_link_id = $1
    RETURNING parent_student_link_id
  `,
  // $1 link_id, $2 school
  selectLinkForInvite: `
    SELECT ps.parent_student_link_id, ps.parent_id, ps.parent_name, ps.parent_email, ps.relation, ps.invited_at,
           ps.invite_conversation_id, ps.school, s.name AS student_name,
           u.password = '!' AS invite_pending, u.first_name
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id
    LEFT JOIN users u ON u.user_id = ps.parent_id
    WHERE ps.parent_student_link_id = $1 AND ps.school = $2
  `,
  // $1 link_id
  touchInvite: `
    UPDATE parent_students SET invited_at = NOW() WHERE parent_student_link_id = $1
  `,
  // One reminder, three days after the invite, while still pending.
  selectInviteReminderCandidates: `
    SELECT ps.parent_student_link_id, ps.parent_id, ps.parent_name, ps.school, ps.invite_conversation_id,
           s.name AS student_name, u.email, u.first_name,
           TRIM(CONCAT(t.first_name, ' ', t.last_name)) AS invited_by_name
    FROM parent_students ps
    JOIN users u ON u.user_id = ps.parent_id AND u.password = '!'
    JOIN students s ON s.student_id = ps.student_id
    LEFT JOIN users t ON t.user_id = ps.invited_by
    WHERE ps.invited_at IS NOT NULL AND ps.invited_at < NOW() - interval '3 days' AND ps.invite_reminded_at IS NULL
    LIMIT 50
  `,
  // $1 link_id
  markInviteReminded: `
    UPDATE parent_students SET invite_reminded_at = NOW() WHERE parent_student_link_id = $1
  `,

  // Admin oversight: threads with a failed email. $1 conversation_id[]
  selectFailedEmailConversations: `
    SELECT DISTINCT conversation_id FROM message_email_jobs WHERE status = 'failed' AND conversation_id = ANY($1::uuid[])
  `,

  // ── Student portal (T17): students in conversations ─────────
  // The teachers a student may write to: the lead and co-teachers of the
  // student's live current-term classes of the year, plus the homeroom
  // teacher (not term-bound). An admin is a target under exactly the same
  // rule as a teacher (leading or co-teaching one of those classes, or being
  // the homeroom teacher); an admin with none of those relations to the
  // student is never offered. Archived accounts are never offered. Each
  // person once, with the classes they teach the student.
  // $1 student_id, $2 school_year_id|null, $3 current term_id|null, $4 current term name|null
  selectStudentTeacherTargets: `
    SELECT t.user_id, t.name, t.avatar, t.photo_path,
           COALESCE(json_agg(json_build_object('classId', t.class_id, 'subject', t.subject) ORDER BY t.subject, t.class_id)
                    FILTER (WHERE t.class_id IS NOT NULL), '[]') AS classes
    FROM (
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS name, u.avatar, u.photo_path, cl.class_id, cl.subject
      FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
      JOIN users u ON u.user_id = cl.teacher_id
      WHERE cs.student_id = $1 AND cl.archived_at IS NULL AND ($2::uuid IS NULL OR cl.school_year_id = $2)
        AND ${inCurrentTerm('cl', '$3', '$4')} AND u.is_archived = FALSE AND u.role IN ('TEACHER', 'ADMIN')
      UNION
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.avatar, u.photo_path, cl.class_id, cl.subject
      FROM class_students cs JOIN classes cl ON cl.class_id = cs.class_id
      JOIN class_teachers ct ON ct.class_id = cl.class_id JOIN users u ON u.user_id = ct.teacher_id
      WHERE cs.student_id = $1 AND cl.archived_at IS NULL AND ($2::uuid IS NULL OR cl.school_year_id = $2)
        AND ${inCurrentTerm('cl', '$3', '$4')} AND u.is_archived = FALSE AND u.role IN ('TEACHER', 'ADMIN')
      UNION
      SELECT u.user_id, TRIM(CONCAT(u.first_name, ' ', u.last_name)), u.avatar, u.photo_path, NULL::uuid, NULL
      FROM students s JOIN users u ON u.user_id = s.homeroom_teacher_id
      WHERE s.student_id = $1 AND u.is_archived = FALSE AND u.role IN ('TEACHER', 'ADMIN')
    ) t
    GROUP BY t.user_id, t.name, t.avatar, t.photo_path
    ORDER BY t.name, t.user_id
  `,
  // The student's guardians who are in their conversations (linked live accounts). $1 student_id
  selectStudentGuardians: `
    SELECT name, relation, avatar, photo_path FROM (
      SELECT DISTINCT ON (ps.parent_id)
             COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name) AS name, ps.relation,
             u.avatar, u.photo_path
      FROM parent_students ps JOIN users u ON u.user_id = ps.parent_id AND u.is_archived = FALSE
      WHERE ps.student_id = $1 AND ps.parent_id IS NOT NULL
      ORDER BY ps.parent_id, ps.relation NULLS LAST
    ) g
    WHERE name IS NOT NULL
    ORDER BY name
  `,
  // A general thread a student starts with one of their teachers.
  // $1 school, $2 student_id, $3 class_id|null, $4 teacher_id, $5 title, $6 created_by
  insertStudentConversation: `
    INSERT INTO conversations (school, student_id, class_id, teacher_id, assessment_id, kind, title, created_by, includes_student)
    VALUES ($1, $2, $3, $4, NULL, 'general', $5, $6, TRUE)
    RETURNING conversation_id
  `,
  // The student's thread about one piece of classwork, with its message count. $1 student_id, $2 item_id
  findClassworkThread: `
    SELECT c.conversation_id,
           (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id
              AND m.kind = 'message' AND m.deleted_at IS NULL)::int AS message_count,
           ${GUARDIANS_HIDDEN} AS guardians_hidden
    FROM conversations c
    WHERE c.student_id = $1 AND c.classwork_item_id = $2
  `,
  // Creates it once per student × item; a second create lands in the first.
  // $1 school, $2 student_id, $3 class_id, $4 teacher_id|null, $5 title, $6 created_by, $7 item_id
  insertClassworkThread: `
    INSERT INTO conversations (school, student_id, class_id, teacher_id, assessment_id, kind, title, created_by,
                               includes_student, classwork_item_id)
    VALUES ($1, $2, $3, $4, NULL, 'general', $5, $6, TRUE, $7)
    ON CONFLICT (student_id, classwork_item_id) WHERE classwork_item_id IS NOT NULL
      DO UPDATE SET title = conversations.title
    RETURNING conversation_id
  `,
  // What an item thread is created from: the item's class, its lead, its
  // title, whether the class is in the current term (the new-thread gate)
  // and whether the item is live (a thread never names unposted work).
  // $1 item_id, $2 current term_id|null, $3 current term name|null
  selectClassworkThreadAnchor: `
    SELECT i.item_id, i.kind, i.class_id, COALESCE(a.name, i.title) AS title,
           cl.school, cl.teacher_id AS lead_teacher_id, ${inCurrentTerm('cl', '$2', '$3')} AS in_current_term,
           (i.status = 'posted' OR (i.status = 'scheduled' AND i.publish_at <= NOW())) AS is_live
    FROM classwork_items i
    JOIN classes cl ON cl.class_id = i.class_id
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    WHERE i.item_id = $1 AND i.deleted_at IS NULL
  `,
};

messagingQueries.GUARDIANS_HIDDEN = GUARDIANS_HIDDEN;
messagingQueries.STUDENT_SCOPE = STUDENT_SCOPE;

module.exports = messagingQueries;
