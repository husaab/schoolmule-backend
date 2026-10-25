// queries/push.queries.js
//
// Push notifications (services/push): devices, preferences, the push_jobs
// queue and Expo's receipt tickets.
//
// Who may be told about an event reuses the fragments the emails are built on
// (IN_AUDIENCE, GUARDIANS_HIDDEN, ITEM_VISIBLE, the work state), so the two
// can't disagree about the audience. The one deliberate difference: a
// student is pushed whenever they can sign in to the app, whether or not the
// school emails their grade, because the student portal is theirs to use.
// Every enqueue only writes rows for people with a device.

const { GRADE_RANK } = require('../utils/gradeRank');
const { PERSON_NAME } = require('./personName');
const { IN_AUDIENCE } = require('./announcement.queries');
const { GUARDIANS_HIDDEN } = require('./messaging.queries');
const { ITEM_VISIBLE } = require('./classwork.queries');
const { GRADE_VISIBLE, TURN_IN_ITEM, WORK_STATE_AT, WORK_JOINS } = require('./workState');

const HAS_DEVICE = (userId) => `EXISTS (SELECT 1 FROM push_devices d WHERE d.user_id = ${userId})`;

// A student row `s` and its own login `su` that can sign in right now, as
// services/classroom/studentLogin.js judges it: classrooms on, consent on
// file, the active year's link, the grade at or above the sign-in grade, a
// live login (not archived, invite accepted). Aliases sal, say, su, sacc, scs.
const STUDENT_LOGIN_FROM = (s) => `
  JOIN student_account_links sal ON sal.student_id = ${s}.student_id
  JOIN school_years say ON say.school_year_id = sal.school_year_id AND say.is_active
  JOIN users su ON su.user_id = sal.user_id AND su.is_archived = FALSE AND su.password <> '!'
  JOIN student_accounts sacc ON sacc.user_id = su.user_id AND sacc.consent_at IS NOT NULL
  JOIN school_classroom_settings scs ON scs.school = ${s}.school AND scs.enabled`;
const STUDENT_LOGIN_OK = (s) => `(${s}.is_archived IS NOT TRUE
  AND ${GRADE_RANK(`${s}.grade::text`)} >= ${GRADE_RANK('scs.login_from_grade')}
  AND ${HAS_DEVICE('su.user_id')})`;
// The same test for a student user id (a message recipient).
const STUDENT_CAN_SIGN_IN = (userId) => `EXISTS (
  SELECT 1 FROM students st ${STUDENT_LOGIN_FROM('st')}
  WHERE su.user_id = ${userId} AND st.is_archived IS NOT TRUE
    AND ${GRADE_RANK('st.grade::text')} >= ${GRADE_RANK('scs.login_from_grade')})`;

const JOB_COLUMNS = '(kind, category, recipient_id, dedupe_key, title, subtitle, body, path, thread_key, payload, send_after)';

module.exports = {
  STUDENT_LOGIN_FROM,
  STUDENT_LOGIN_OK,

  // ── Devices and preferences ────────────────────────────────────────────
  // $1 token, $2 user_id, $3 platform, $4 app_version
  upsertDevice: `
    INSERT INTO push_devices (token, user_id, platform, app_version)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (token) DO UPDATE
      SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
          app_version = EXCLUDED.app_version, last_seen_at = NOW()`,
  // $1 user_id, $2 token: only the caller's own device.
  deleteDevice: 'DELETE FROM push_devices WHERE user_id = $1 AND token = $2',
  // $1 text[] tokens Expo says are gone.
  deleteTokens: 'DELETE FROM push_devices WHERE token = ANY($1::text[])',
  countDevices: 'SELECT COUNT(*)::int AS n FROM push_devices WHERE user_id = $1',
  // Phones that haven't opened the app in 60 days (signed out offline, uninstalled).
  pruneStaleDevices: "DELETE FROM push_devices WHERE last_seen_at < NOW() - INTERVAL '60 days'",

  selectPrefs: 'SELECT messages, announcements, grades, classwork, reminders FROM push_preferences WHERE user_id = $1',
  // $1 user_id, $2..$6 a new value or null to keep (messages, announcements, grades, classwork, reminders)
  upsertPrefs: `
    INSERT INTO push_preferences (user_id, messages, announcements, grades, classwork, reminders)
    VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), COALESCE($4, TRUE), COALESCE($5, TRUE), COALESCE($6, TRUE))
    ON CONFLICT (user_id) DO UPDATE SET
      messages = COALESCE($2, push_preferences.messages),
      announcements = COALESCE($3, push_preferences.announcements),
      grades = COALESCE($4, push_preferences.grades),
      classwork = COALESCE($5, push_preferences.classwork),
      reminders = COALESCE($6, push_preferences.reminders),
      updated_at = NOW()
    RETURNING messages, announcements, grades, classwork, reminders`,

  // ── Enqueue ────────────────────────────────────────────────────────────
  // Rows built in JS: $1 jsonb array of { kind, category, recipient_id,
  // dedupe_key, title, subtitle, body, path, thread_key, payload, delay_seconds }.
  insertJobs: `
    INSERT INTO push_jobs ${JOB_COLUMNS}
    SELECT r.kind, r.category, r.recipient_id, r.dedupe_key, r.title, r.subtitle, r.body, r.path, r.thread_key,
           COALESCE(r.payload, '{}'::jsonb), NOW() + make_interval(secs => COALESCE(r.delay_seconds, 0))
    FROM jsonb_to_recordset($1::jsonb) AS r(kind text, category text, recipient_id uuid, dedupe_key text, title text,
         subtitle text, body text, path text, thread_key text, payload jsonb, delay_seconds int)
    WHERE ${HAS_DEVICE('r.recipient_id')}
    ON CONFLICT (kind, recipient_id, dedupe_key) DO NOTHING
    RETURNING job_id`,

  // A message's other participants who should hear about it now: not
  // archived, invite accepted, thread not muted, a device; a guardian only
  // where guardians may read the thread, a student only in their own thread
  // and while they can sign in. $1 conversation_id, $2 uuid[] recipients
  selectMessageTargets: `
    SELECT u.user_id, u.role::text AS role
    FROM conversations c
    JOIN users u ON u.user_id = ANY($2::uuid[])
    LEFT JOIN conversation_participants cp ON cp.conversation_id = c.conversation_id AND cp.user_id = u.user_id
    WHERE c.conversation_id = $1
      AND u.is_archived = FALSE AND u.password <> '!'
      AND NOT COALESCE(cp.muted, FALSE)
      AND ${HAS_DEVICE('u.user_id')}
      AND (u.role::text <> 'PARENT' OR NOT ${GUARDIANS_HIDDEN})
      AND (u.role::text <> 'STUDENT' OR (c.includes_student
           AND EXISTS (SELECT 1 FROM student_account_links sl WHERE sl.user_id = u.user_id AND sl.student_id = c.student_id)
           AND ${STUDENT_CAN_SIGN_IN('u.user_id')}))`,
  // The message the sender just posted. $1 conversation_id, $2 sender id
  selectLatestMessage: `
    SELECT m.message_id, m.body, ${PERSON_NAME('u')} AS sender_name, c.title, s.name AS student_name,
           (SELECT COUNT(*) FROM message_attachments ma WHERE ma.message_id = m.message_id)::int AS attachment_count
    FROM messages m
    JOIN conversations c ON c.conversation_id = m.conversation_id
    LEFT JOIN students s ON s.student_id = c.student_id
    LEFT JOIN users u ON u.user_id = m.sender_id
    WHERE m.conversation_id = $1 AND m.sender_id = $2 AND m.kind = 'message' AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC
    LIMIT 1`,

  // An announcement's families and students, never its author: the linked
  // guardian accounts of every student in the audience, and each student's
  // own login while they can sign in; with the post for the text and links.
  // $1 announcement_id
  selectAnnouncementTargets: `
    SELECT DISTINCT ON (x.recipient_id) x.recipient_id, x.as_student,
           a.announcement_id, a.title, a.body, a.scope, a.grade, a.class_id,
           cl.subject AS class_subject, cl.grade::text AS class_grade
    FROM (
      SELECT a.announcement_id, ps.parent_id AS recipient_id, FALSE AS as_student
      FROM announcements a
      JOIN students s ON ${IN_AUDIENCE('s')}
      JOIN parent_students ps ON ps.student_id = s.student_id
      JOIN users pu ON pu.user_id = ps.parent_id AND pu.is_archived = FALSE AND pu.password <> '!'
      WHERE a.announcement_id = $1
      UNION ALL
      SELECT a.announcement_id, su.user_id, TRUE
      FROM announcements a
      JOIN students s ON ${IN_AUDIENCE('s')}
      ${STUDENT_LOGIN_FROM('s')}
      WHERE a.announcement_id = $1 AND ${STUDENT_LOGIN_OK('s')}
    ) x
    JOIN announcements a ON a.announcement_id = x.announcement_id AND a.deleted_at IS NULL
    LEFT JOIN classes cl ON cl.class_id = a.class_id
    WHERE x.recipient_id IS DISTINCT FROM a.author_id AND ${HAS_DEVICE('x.recipient_id')}
    ORDER BY x.recipient_id, x.as_student`,

  // Items just posted: each student who can see one, 2 minutes later (edits
  // settle; the send re-checks it is still visible). Items with "email
  // students" off notify nobody. A post that was taken down and put back
  // gets its notification back. $1 item ids, $2 now, $3 send_after
  enqueueNewWork: `
    INSERT INTO push_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (su.user_id, i.item_id)
           'new_work', 'classwork', su.user_id, 'item:' || i.item_id::text,
           CASE i.kind WHEN 'quiz' THEN 'New quiz' WHEN 'material' THEN 'New material'
                       WHEN 'assessment' THEN 'New assessment' ELSE 'New assignment' END,
           c.subject, COALESCE(NULLIF(TRIM(i.title), ''), 'Untitled'),
           '/student/items/' || i.item_id::text, 'class:' || c.class_id::text,
           jsonb_build_object('itemId', i.item_id, 'studentId', s.student_id), $3::timestamptz
    FROM classwork_items i
    JOIN classes c ON c.class_id = i.class_id AND c.archived_at IS NULL
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN class_students ro ON ro.class_id = i.class_id
    JOIN students s ON s.student_id = ro.student_id AND s.school = c.school
    ${STUDENT_LOGIN_FROM('s')}
    WHERE i.item_id = ANY($1::uuid[]) AND i.email_students AND ${STUDENT_LOGIN_OK('s')}
      AND ${ITEM_VISIBLE('i', 'a', 's', '$2::timestamptz')}
    ORDER BY su.user_id, i.item_id, s.student_id
    ON CONFLICT (kind, recipient_id, dedupe_key) DO UPDATE
      SET status = 'pending', attempts = 0, last_error = NULL, sent_at = NULL, send_after = EXCLUDED.send_after,
          title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, body = EXCLUDED.body
      WHERE push_jobs.status = 'skipped' AND push_jobs.last_error = 'not visible'
    RETURNING job_id`,
  // Is the item still visible to the student? $1 item_id, $2 student_id, $3 now
  selectItemVisible: `
    SELECT 1 FROM classwork_items i
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN students s ON s.student_id = $2
    WHERE i.item_id = $1 AND ${ITEM_VISIBLE('i', 'a', 's', '$3::timestamptz')}`,

  // Grades just published to these students: one notification per student
  // per 15-minute bucket, sent when the bucket closes; a pending one counts
  // the repeats. $1 student ids, $2 school, $3 bucket key, $4 bucket end
  enqueueGraded: `
    INSERT INTO push_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (su.user_id)
           'graded', 'grades', su.user_id, $3::text, 'New grades', NULL,
           'Your teacher posted new grades. Tap to see them.', '/student/grades', NULL, '{}'::jsonb, $4::timestamptz
    FROM students s
    ${STUDENT_LOGIN_FROM('s')}
    WHERE s.student_id = ANY($1::uuid[]) AND s.school = $2 AND ${STUDENT_LOGIN_OK('s')}
    ORDER BY su.user_id
    ON CONFLICT (kind, recipient_id, dedupe_key) DO UPDATE SET merged = push_jobs.merged + 1
      WHERE push_jobs.status = 'pending'
    RETURNING job_id`,
  // Whole gradebook columns published: the students with a grade there that
  // is now visible. $1 assessment ids, $2 school, $3 bucket key, $4 bucket end
  enqueueGradedColumns: `
    INSERT INTO push_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (su.user_id)
           'graded', 'grades', su.user_id, $3::text, 'New grades', NULL,
           'Your teacher posted new grades. Tap to see them.', '/student/grades', NULL, '{}'::jsonb, $4::timestamptz
    FROM assessments a
    JOIN student_assessments sa ON sa.assessment_id = a.assessment_id
    JOIN students s ON s.student_id = sa.student_id AND s.school = $2
    ${STUDENT_LOGIN_FROM('s')}
    WHERE a.assessment_id = ANY($1::uuid[]) AND ${GRADE_VISIBLE} AND sa.status <> 'missing'
      AND ${STUDENT_LOGIN_OK('s')}
    ORDER BY su.user_id
    ON CONFLICT (kind, recipient_id, dedupe_key) DO UPDATE SET merged = push_jobs.merged + 1
      WHERE push_jobs.status = 'pending'
    RETURNING job_id`,

  // Due tomorrow (the 5 pm sweep): one notification per student with visible
  // turn-in work due that day, reminders on, not turned in.
  // $1 now, $2 the due day 'YYYY-MM-DD'
  enqueueDueReminders: `
    INSERT INTO push_jobs ${JOB_COLUMNS}
    SELECT 'due_reminder', 'classwork', d.user_id, 'due:' || $2::text, 'Due tomorrow', NULL,
           CASE WHEN d.n = 1 THEN d.first_title ELSE d.n || ' things are due tomorrow' END,
           CASE WHEN d.n = 1 THEN '/student/items/' || d.first_item::text ELSE '/student/todo' END,
           NULL, '{}'::jsonb, $1::timestamptz
    FROM (
      SELECT su.user_id, COUNT(DISTINCT i.item_id)::int AS n,
             (ARRAY_AGG(i.item_id ORDER BY i.due_at, i.item_id))[1] AS first_item,
             (ARRAY_AGG(COALESCE(NULLIF(TRIM(i.title), ''), 'Untitled') ORDER BY i.due_at, i.item_id))[1] AS first_title
      FROM classwork_items i
      JOIN classes c ON c.class_id = i.class_id AND c.archived_at IS NULL
      LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
      JOIN class_students ro ON ro.class_id = i.class_id
      JOIN students s ON s.student_id = ro.student_id AND s.school = c.school
      ${STUDENT_LOGIN_FROM('s')}
      ${WORK_JOINS('s.student_id')}
      WHERE i.remind_students AND ${TURN_IN_ITEM}
        AND i.due_at >= (($2::date)::timestamp AT TIME ZONE 'America/Toronto')
        AND i.due_at < (($2::date + 1)::timestamp AT TIME ZONE 'America/Toronto')
        AND ${STUDENT_LOGIN_OK('s')}
        AND ${ITEM_VISIBLE('i', 'a', 's', '$1::timestamptz')}
        AND ${WORK_STATE_AT('$1::timestamptz')} = 'assigned'
      GROUP BY su.user_id
    ) d
    ON CONFLICT (kind, recipient_id, dedupe_key) DO NOTHING
    RETURNING job_id`,

  // An office address on an email row, as its account. $1 email, $2 school
  selectUserByEmail: `
    SELECT user_id FROM users
    WHERE lower(email) = lower($1) AND school = $2 AND is_archived = FALSE
    ORDER BY (email = $1) DESC
    LIMIT 1`,

  // ── Send ───────────────────────────────────────────────────────────────
  // Leases due rows for 2 minutes: a crash mid-send retries them then.
  // $1 limit
  claimDue: `
    UPDATE push_jobs j SET attempts = j.attempts + 1, send_after = NOW() + INTERVAL '2 minutes'
    WHERE j.job_id IN (
      SELECT job_id FROM push_jobs
      WHERE status = 'pending' AND send_after <= NOW()
      ORDER BY send_after
      LIMIT $1
      FOR UPDATE SKIP LOCKED)
    RETURNING j.*`,
  // Each recipient's devices with their switches. $1 uuid[] user ids
  selectTargets: `
    SELECT d.token, d.user_id, u.is_archived,
           COALESCE(p.messages, TRUE) AS messages, COALESCE(p.announcements, TRUE) AS announcements,
           COALESCE(p.grades, TRUE) AS grades, COALESCE(p.classwork, TRUE) AS classwork,
           COALESCE(p.reminders, TRUE) AS reminders
    FROM push_devices d
    JOIN users u ON u.user_id = d.user_id
    LEFT JOIN push_preferences p ON p.user_id = d.user_id
    WHERE d.user_id = ANY($1::uuid[])`,
  finishSent: "UPDATE push_jobs SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE job_id = ANY($1::uuid[])",
  // $1 ids, $2 reason
  finishSkipped: "UPDATE push_jobs SET status = 'skipped', last_error = $2 WHERE job_id = ANY($1::uuid[])",
  // $1 ids, $2 error, $3 max attempts. The lease already set the retry time.
  retryOrFail: `
    UPDATE push_jobs SET last_error = $2,
           status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END
    WHERE job_id = ANY($1::uuid[])`,

  // ── Receipts and housekeeping ──────────────────────────────────────────
  // $1 jsonb array of { ticket_id, token }
  insertTickets: `
    INSERT INTO push_tickets (ticket_id, token)
    SELECT r.ticket_id, r.token FROM jsonb_to_recordset($1::jsonb) AS r(ticket_id text, token text)
    WHERE EXISTS (SELECT 1 FROM push_devices d WHERE d.token = r.token)
    ON CONFLICT DO NOTHING`,
  selectDueTickets: `
    SELECT ticket_id, token FROM push_tickets
    WHERE created_at < NOW() - INTERVAL '15 minutes'
    ORDER BY created_at
    LIMIT 1000`,
  deleteTickets: 'DELETE FROM push_tickets WHERE ticket_id = ANY($1::text[])',
  // Expo keeps receipts for 24 hours; older tickets can't be checked.
  purgeTickets: "DELETE FROM push_tickets WHERE created_at < NOW() - INTERVAL '24 hours'",
  purgeJobs: "DELETE FROM push_jobs WHERE status <> 'pending' AND created_at < NOW() - INTERVAL '30 days'",
};
