// queries/replyReminder.queries.js
//
// Reads behind services/replyReminders.js: which conversations are waiting
// on someone, who to email, and what the email shows. A "real" message is a
// kind 'message' that wasn't deleted (system lines never count). Classwork
// private comments (classwork_item_id) are left out throughout.
//
// Progress is read from the reminders' own email_outbox rows: subject_type
// 'conversation', subject_id = the conversation, payload { step, day }.

const { PERSON_NAME } = require('./personName');

const REAL = (m) => `${m}.kind = 'message' AND ${m}.deleted_at IS NULL`;
const STAFF_ROLES = `('TEACHER', 'ADMIN')`;
const FAMILY_ROLES = `('PARENT', 'STUDENT')`;
const HAS_REAL = (roles) => `EXISTS (SELECT 1 FROM messages x WHERE x.conversation_id = c.conversation_id
    AND ${REAL('x')} AND x.sender_role IN ${roles})`;
// The student's row of the school's current year: last year's threads are left alone.
const CURRENT_STUDENT = `JOIN students s ON s.student_id = c.student_id AND s.is_archived IS NOT TRUE
  AND EXISTS (SELECT 1 FROM school_years sy WHERE sy.school_year_id = s.school_year_id AND sy.is_active)`;
const TORONTO_DAY = (at) => `to_char(${at} AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD')`;

const replyReminderQueries = {
  // Schools with either switch on.
  selectEnabledSchools: `
    SELECT school::text AS school, reply_reminders, parent_nudge
    FROM school_classroom_settings
    WHERE reply_reminders OR parent_nudge
  `,

  // Open conversations a parent wrote in that no teacher or admin has ever
  // answered, with how far the reminders got. start_day: the Toronto date of
  // the parent's first message; step: the last step queued (0 = none, 1-2 the
  // teacher reminders, 3 the office), day: when. $1 school
  selectWaitingOnStaff: `
    SELECT c.conversation_id, c.class_id, c.student_id,
           ${TORONTO_DAY('fp.first_at')} AS start_day,
           COALESCE(prog.step, 0)::int AS step, prog.day AS last_day
    FROM conversations c
    ${CURRENT_STUDENT}
    JOIN LATERAL (
      SELECT MIN(m.created_at) AS first_at FROM messages m
      WHERE m.conversation_id = c.conversation_id AND ${REAL('m')} AND m.sender_role = 'PARENT'
    ) fp ON fp.first_at IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT MAX((o.payload->>'step')::int) AS step, MAX(o.payload->>'day') AS day
      FROM email_outbox o
      WHERE o.subject_type = 'conversation' AND o.subject_id = c.conversation_id
        AND o.kind IN ('reply_reminder', 'reply_escalation')
    ) prog ON TRUE
    WHERE c.school = $1::school AND c.status = 'open' AND c.classwork_item_id IS NULL
      AND COALESCE(prog.step, 0) < 3
      AND NOT ${HAS_REAL(STAFF_ROLES)}
  `,

  // Open parent conversations a teacher or admin started that nobody in the
  // family has answered, first written after $2 and never nudged. Threads
  // the student is in are left out: the nudge is for parents.
  // $1 school, $2 earliest first staff message (timestamptz)
  selectWaitingOnFamily: `
    SELECT c.conversation_id, c.class_id, c.student_id, ${TORONTO_DAY('fs.first_at')} AS start_day
    FROM conversations c
    ${CURRENT_STUDENT}
    JOIN LATERAL (
      SELECT MIN(m.created_at) AS first_at FROM messages m
      WHERE m.conversation_id = c.conversation_id AND ${REAL('m')} AND m.sender_role IN ${STAFF_ROLES}
    ) fs ON fs.first_at >= $2::timestamptz
    WHERE c.school = $1::school AND c.status = 'open' AND c.classwork_item_id IS NULL
      AND c.includes_student IS NOT TRUE
      AND NOT ${HAS_REAL(FAMILY_ROLES)}
      AND NOT EXISTS (SELECT 1 FROM email_outbox o
                      WHERE o.subject_type = 'conversation' AND o.subject_id = c.conversation_id AND o.kind = 'reply_nudge')
  `,

  // Who answers each conversation: a General thread's addressee (a
  // principal's thread is a General thread addressed to them), else the
  // class's lead teacher, plus the co-teachers on an assessment thread.
  // `reachable`: can be emailed now (not archived, verified, has an address).
  // $1 conversation ids
  selectResponsibleStaff: `
    WITH conv AS (
      SELECT c.conversation_id, c.kind, c.class_id, c.teacher_id, cl.teacher_id AS lead_id
      FROM conversations c LEFT JOIN classes cl ON cl.class_id = c.class_id
      WHERE c.conversation_id = ANY($1::uuid[])
    ), who AS (
      SELECT conversation_id, teacher_id AS user_id FROM conv WHERE kind = 'general' AND teacher_id IS NOT NULL
      UNION
      SELECT conversation_id, lead_id FROM conv WHERE lead_id IS NOT NULL AND (kind <> 'general' OR teacher_id IS NULL)
      UNION
      SELECT conv.conversation_id, ct.teacher_id FROM conv JOIN class_teachers ct ON ct.class_id = conv.class_id
      WHERE conv.kind <> 'general'
    )
    SELECT who.conversation_id, u.user_id, LOWER(TRIM(COALESCE(u.email, ''))) AS email, u.first_name,
           ${PERSON_NAME('u')} AS name,
           (u.is_archived IS NOT TRUE AND u.is_verified IS TRUE AND u.is_verified_school IS TRUE
             AND TRIM(COALESCE(u.email, '')) <> '') AS reachable
    FROM who JOIN users u ON u.user_id = who.user_id
    ORDER BY who.conversation_id, name
  `,

  // The guardians to nudge: parent accounts linked to the child that have
  // signed in at least once (an invite-pending one gets the invite reminder
  // instead), aren't archived and haven't muted the thread. $1 conversation ids
  selectGuardians: `
    SELECT DISTINCT c.conversation_id, c.student_id, u.user_id, LOWER(TRIM(u.email)) AS email, u.first_name
    FROM conversations c
    JOIN parent_students ps ON ps.student_id = c.student_id AND ps.parent_id IS NOT NULL
    JOIN users u ON u.user_id = ps.parent_id
    LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = u.user_id
    WHERE c.conversation_id = ANY($1::uuid[])
      AND u.role::text = 'PARENT' AND u.is_archived IS NOT TRUE AND u.password IS DISTINCT FROM '!'
      AND COALESCE(cp.muted, FALSE) = FALSE AND TRIM(COALESCE(u.email, '')) <> ''
  `,

  // Each conversation as it is now, for the send-time re-check and the email.
  // $1 conversation ids
  selectThreads: `
    SELECT c.conversation_id, c.school::text AS school, c.status, c.kind, c.title, c.student_id, c.class_id,
           s.name AS student_name, s.grade::text AS student_grade,
           COALESCE(cl.subject, NULLIF(lt.staff_title, ''), 'Homeroom') AS class_subject,
           ${HAS_REAL(STAFF_ROLES)} AS has_staff_reply,
           ${HAS_REAL(`('PARENT')`)} AS has_parent_message,
           ${HAS_REAL(FAMILY_ROLES)} AS has_family_reply,
           COALESCE(scs.reply_reminders, FALSE) AS reminders_on,
           COALESCE(scs.parent_nudge, FALSE) AS nudge_on
    FROM conversations c
    JOIN students s ON s.student_id = c.student_id
    LEFT JOIN classes cl ON cl.class_id = c.class_id
    LEFT JOIN users lt ON lt.user_id = c.teacher_id
    LEFT JOIN school_classroom_settings scs ON scs.school = c.school
    WHERE c.conversation_id = ANY($1::uuid[])
  `,

  // Every real message of the conversations, oldest first, with the
  // guardian's relation to the child and the attachments' names.
  // $1 conversation ids
  selectMessages: `
    SELECT m.conversation_id, m.message_id, m.body, m.created_at, m.sender_role::text AS sender_role,
           ${PERSON_NAME('u')} AS sender_name,
           (SELECT ps.relation FROM parent_students ps
             WHERE ps.parent_id = m.sender_id AND ps.student_id = c.student_id LIMIT 1) AS relation,
           ARRAY(SELECT ma.file_name FROM message_attachments ma
                 WHERE ma.message_id = m.message_id ORDER BY ma.created_at) AS file_names
    FROM messages m
    JOIN conversations c ON c.conversation_id = m.conversation_id
    LEFT JOIN users u ON u.user_id = m.sender_id
    WHERE m.conversation_id = ANY($1::uuid[]) AND ${REAL('m')}
    ORDER BY m.conversation_id, m.created_at
  `,

  // When each teacher reminder went out. $1 conversation ids
  selectRemindersSent: `
    SELECT subject_id AS conversation_id, (payload->>'step')::int AS step, MIN(finished_at) AS sent_at
    FROM email_outbox
    WHERE kind = 'reply_reminder' AND status = 'sent' AND subject_type = 'conversation'
      AND subject_id = ANY($1::uuid[])
    GROUP BY 1, 2
    ORDER BY 1, 2
  `,

  // The All Messages badges: reminders sent, when the office was told, when
  // the parent was nudged. $1 conversation ids
  selectBadges: `
    SELECT subject_id AS conversation_id,
           COUNT(DISTINCT payload->>'step') FILTER (WHERE kind = 'reply_reminder' AND status = 'sent')::int AS reminders,
           MIN(finished_at) FILTER (WHERE kind = 'reply_escalation' AND status = 'sent') AS office_told_at,
           MIN(finished_at) FILTER (WHERE kind = 'reply_nudge' AND status = 'sent') AS nudged_at
    FROM email_outbox
    WHERE subject_type = 'conversation' AND subject_id = ANY($1::uuid[])
      AND kind IN ('reply_reminder', 'reply_escalation', 'reply_nudge')
    GROUP BY subject_id
  `,
};

module.exports = replyReminderQueries;
