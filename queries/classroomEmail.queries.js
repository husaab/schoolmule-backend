// queries/classroomEmail.queries.js
//
// The classroom email outbox (classroom_email_jobs, T21) and the parents'
// email choices (notification_prefs). Enqueues only ever INSERT ... ON
// CONFLICT DO NOTHING on (lower(address), kind, digest key), so a worker tick,
// a restart or a second instance running the same enqueue sends nothing
// twice. A job holds ids and dates; what the email says is read at send time
// (the content queries below), through the same rules the portal uses:
// ITEM_VISIBLE, GRADE_VISIBLE and the WorkStatus rule (WORK_STATE_AT), each
// judged at the scheduler's own clock ($now) so a run is repeatable.
//
// students.grade is the "GRADE" enum in production: always compared ::text.

const { GRADE_RANK } = require('../utils/gradeRank');
const { studentAvatarSql } = require('../utils/avatar');
const { IN_AUDIENCE, STUDENT_EMAIL_JOINS, STUDENT_EMAIL_GRADE_OK } = require('./announcement.queries');
const { ITEM_VISIBLE } = require('./classwork.queries');
const { GRADE_VISIBLE, TURN_IN_ITEM, WORK_STATE_AT, WORK_JOINS } = require('./workState');

const TZ = 'America/Toronto';

// A student row `s` whose own login `su` may get class email: T10's gate
// (classrooms on, student email on for the grade, a login that is not
// archived, not invite-pending, with an address) plus a usable login: consent
// on file and the grade at or above the school's sign-in grade, so nobody is
// sent an "Open in SchoolMule" they can't open. Aliases sal, su, scs, sacc.
const STUDENT_EMAIL_FROM = (s) => `${STUDENT_EMAIL_JOINS(s, `${s}.school`)}
  JOIN student_accounts sacc ON sacc.user_id = su.user_id AND sacc.consent_at IS NOT NULL`;
const STUDENT_EMAIL_OK = (s) => `(${s}.is_archived IS NOT TRUE AND ${STUDENT_EMAIL_GRADE_OK(s)}
  AND ${GRADE_RANK(`${s}.grade::text`)} >= ${GRADE_RANK('scs.login_from_grade')})`;

// A guardian account that can read the email and open the portal.
const GUARDIAN_OK = (u) => `(${u}.is_archived IS NOT TRUE AND ${u}.password <> '!' AND TRIM(COALESCE(${u}.email, '')) <> '')`;

// The student row of the school's active year (rows are per year; a school
// with no year at all keeps its NULL-year rows).
const ACTIVE_YEAR = (s) => `(${s}.school_year_id IS NOT DISTINCT FROM
  (SELECT sy.school_year_id FROM school_years sy WHERE sy.school = ${s}.school AND sy.is_active LIMIT 1))`;

// A Toronto calendar day as the instants it spans: due_at >= DAY_START(d) AND due_at < DAY_START(d + 1).
const DAY_START = (date) => `((${date})::timestamp AT TIME ZONE '${TZ}')`;

// Feedback the student and parent may read (spec 0.8).
const FEEDBACK_VISIBLE = `(sub.published_at IS NOT NULL AND (i.assessment_id IS NULL OR COALESCE(a.is_published, FALSE)))`;

// Work that became missing after `since`: derived (due after `since`, not
// turned in, a child who can sign in) or a Missing the teacher published
// after `since`. The state is judged at `now`.
const NEWLY_MISSING = (now, since) => `(${WORK_STATE_AT(now)} = 'missing' AND CASE WHEN ${GRADE_VISIBLE}
    THEN COALESCE(sub.published_at, a.published_at) > ${since}
    ELSE i.due_at > ${since} END)`;

const TEACHER_NAME = (u1, u2) => `COALESCE(NULLIF(TRIM(CONCAT(${u1}.first_name, ' ', ${u1}.last_name)), ''),
  NULLIF(TRIM(CONCAT(${u2}.first_name, ' ', ${u2}.last_name)), ''), c.teacher_name)`;

// The ISO instant to the microsecond, the identity of one publish of one
// submission (a re-publish after a regrade is a new one).
const PUBLISHED_KEY = `to_char(sub.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const JOB_COLUMNS = '(kind, digest_key, recipient_id, recipient_email, school, payload, send_after)';
const ON_CONFLICT = 'ON CONFLICT (LOWER(recipient_email), kind, digest_key) DO NOTHING';

const classroomEmailQueries = {
  STUDENT_EMAIL_FROM,
  STUDENT_EMAIL_OK,

  // ── Enqueue ─────────────────────────────────────────────────────────────

  //  New work: one job per eligible student the item reaches and can see.
  //  A job skipped because the item was unposted (or hidden, or its email
  //  turned off) inside the 2-minute window comes back when it is posted
  //  again; a pending or sent job is never touched. $1 item ids, $2 now, $3 send after
  enqueueNewWork: `
    INSERT INTO classroom_email_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (LOWER(TRIM(su.email)), i.item_id)
           'new_work', 'item:' || i.item_id::text, su.user_id, LOWER(TRIM(su.email)), c.school,
           jsonb_build_object('itemId', i.item_id, 'studentId', s.student_id), $3::timestamptz
    FROM classwork_items i
    JOIN classes c ON c.class_id = i.class_id AND c.archived_at IS NULL
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN class_students ro ON ro.class_id = i.class_id
    JOIN students s ON s.student_id = ro.student_id AND s.school = c.school
    ${STUDENT_EMAIL_FROM('s')}
    WHERE i.item_id = ANY($1::uuid[]) AND i.email_students AND ${STUDENT_EMAIL_OK('s')}
      AND ${ITEM_VISIBLE('i', 'a', 's', '$2::timestamptz')}
    ORDER BY LOWER(TRIM(su.email)), i.item_id, s.student_id
    ON CONFLICT (LOWER(recipient_email), kind, digest_key) DO UPDATE
      SET status = 'pending', attempts = 0, last_error = NULL, sent_at = NULL,
          send_after = EXCLUDED.send_after, payload = EXCLUDED.payload, recipient_id = EXCLUDED.recipient_id
      WHERE classroom_email_jobs.status = 'skipped'
        AND classroom_email_jobs.last_error IN ('not posted', 'not visible', 'email off for this item')
    RETURNING job_id`,

  //  Due tomorrow: one job per eligible student with visible turn-in work due
  //  that day, reminders on, not turned in. $1 now, $2 the due day 'YYYY-MM-DD'
  enqueueDueReminders: `
    INSERT INTO classroom_email_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (LOWER(TRIM(su.email)))
           'due_reminder', 'due:' || $2::text, su.user_id, LOWER(TRIM(su.email)), s.school,
           jsonb_build_object('dueDate', $2::text, 'studentId', s.student_id), $1::timestamptz
    FROM classwork_items i
    JOIN classes c ON c.class_id = i.class_id AND c.archived_at IS NULL
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    JOIN class_students ro ON ro.class_id = i.class_id
    JOIN students s ON s.student_id = ro.student_id AND s.school = c.school
    ${STUDENT_EMAIL_FROM('s')}
    ${WORK_JOINS('s.student_id')}
    WHERE i.remind_students AND ${TURN_IN_ITEM}
      AND i.due_at >= ${DAY_START('$2::date')} AND i.due_at < ${DAY_START('$2::date + 1')}
      AND ${STUDENT_EMAIL_OK('s')}
      AND ${ITEM_VISIBLE('i', 'a', 's', '$1::timestamptz')}
      AND ${WORK_STATE_AT('$1::timestamptz')} = 'assigned'
    ORDER BY LOWER(TRIM(su.email)), s.student_id
    ${ON_CONFLICT}
    RETURNING job_id`,

  //  Grades published: one job per eligible student per 15-minute bucket.
  //  $1 student ids, $2 school, $3 digest key, $4 bucket end, $5 bucket start
  enqueueGraded: `
    INSERT INTO classroom_email_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (LOWER(TRIM(su.email)))
           'graded', $3::text, su.user_id, LOWER(TRIM(su.email)), s.school,
           jsonb_build_object('studentId', s.student_id, 'since', $5::text), $4::timestamptz
    FROM students s
    ${STUDENT_EMAIL_FROM('s')}
    WHERE s.student_id = ANY($1::uuid[]) AND s.school = $2 AND ${STUDENT_EMAIL_OK('s')}
    ORDER BY LOWER(TRIM(su.email)), s.student_id
    ${ON_CONFLICT}
    RETURNING job_id`,

  //  Missing work: one job per guardian address whose active-year children
  //  (in a school with classrooms on) have work that went missing since $2,
  //  unless the guardian turned the alerts off. $1 now, $2 since, $3 digest key
  enqueueMissingAlerts: `
    WITH kids AS (
      SELECT DISTINCT s.student_id, s.school, s.grade, ps.parent_id
      FROM parent_students ps
      JOIN students s ON s.student_id = ps.student_id AND s.is_archived IS NOT TRUE
      JOIN school_classroom_settings scs ON scs.school = s.school AND scs.enabled
      WHERE ps.parent_id IS NOT NULL AND ${ACTIVE_YEAR('s')}
    ),
    fresh AS (
      SELECT DISTINCT k.parent_id, k.school
      FROM kids k
      JOIN class_students ro ON ro.student_id = k.student_id
      JOIN classes c ON c.class_id = ro.class_id AND c.archived_at IS NULL
      JOIN classwork_items i ON i.class_id = c.class_id
      LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
      ${WORK_JOINS('k.student_id')}
      WHERE ((i.due_at > $2::timestamptz AND i.due_at <= $1::timestamptz)
             OR sub.published_at > $2::timestamptz OR a.published_at > $2::timestamptz)
        AND ${ITEM_VISIBLE('i', 'a', 'k', '$1::timestamptz')}
        AND ${NEWLY_MISSING('$1::timestamptz', '$2::timestamptz')}
    )
    INSERT INTO classroom_email_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (LOWER(TRIM(gu.email)))
           'missing_alert', $3::text, gu.user_id, LOWER(TRIM(gu.email)), f.school,
           jsonb_build_object('since', $2::timestamptz, 'until', $1::timestamptz), $1::timestamptz
    FROM fresh f
    JOIN users gu ON gu.user_id = f.parent_id AND ${GUARDIAN_OK('gu')}
    LEFT JOIN notification_prefs np ON np.user_id = gu.user_id
    WHERE COALESCE(np.missing_alerts, TRUE)
    ORDER BY LOWER(TRIM(gu.email)), gu.user_id
    ${ON_CONFLICT}
    RETURNING job_id`,

  //  The summaries due today: daily ones, and weekly ones whose day (the
  //  parent's, else the school's) is today. Whether there is anything to say
  //  is decided at send time. $1 now, $2 Toronto weekday, $3 weekly key,
  //  $4 daily key, $5 weekly since, $6 daily since
  enqueueSummaries: `
    INSERT INTO classroom_email_jobs ${JOB_COLUMNS}
    SELECT DISTINCT ON (LOWER(TRIM(gu.email)))
           'weekly_summary', CASE WHEN f.daily THEN $4::text ELSE $3::text END,
           gu.user_id, LOWER(TRIM(gu.email)), s.school,
           jsonb_build_object('frequency', CASE WHEN f.daily THEN 'daily' ELSE 'weekly' END,
                              'since', CASE WHEN f.daily THEN $6::timestamptz ELSE $5::timestamptz END,
                              'until', $1::timestamptz),
           $1::timestamptz
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id AND s.is_archived IS NOT TRUE
    JOIN school_classroom_settings scs ON scs.school = s.school AND scs.enabled
    JOIN users gu ON gu.user_id = ps.parent_id AND ${GUARDIAN_OK('gu')}
    LEFT JOIN notification_prefs np ON np.user_id = gu.user_id
    CROSS JOIN LATERAL (SELECT COALESCE(np.summary_frequency, 'weekly') = 'daily' AS daily) f
    WHERE ${ACTIVE_YEAR('s')} AND COALESCE(np.weekly_summary, TRUE)
      AND (f.daily OR COALESCE(np.summary_dow, scs.summary_dow, 5) = $2::int)
    ORDER BY LOWER(TRIM(gu.email)), gu.user_id
    ${ON_CONFLICT}
    RETURNING job_id`,

  // ── Outbox ──────────────────────────────────────────────────────────────

  //  One due job, pushed 5 minutes out while it is processed (another
  //  instance skips it: FOR UPDATE SKIP LOCKED).
  claimDueJob: `
    UPDATE classroom_email_jobs
    SET attempts = attempts + 1, send_after = NOW() + interval '5 minutes'
    WHERE job_id = (
      SELECT job_id FROM classroom_email_jobs
      WHERE status = 'pending' AND send_after <= NOW()
      ORDER BY send_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING job_id, kind, digest_key, recipient_id, recipient_email, school, payload, attempts, created_at`,

  //  $1 job_id, $2 status, $3 error, $4 payload to merge (jsonb or NULL)
  finishJob: `
    UPDATE classroom_email_jobs
    SET status = $2::text, last_error = $3,
        sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END,
        payload = CASE WHEN $4::jsonb IS NULL THEN payload ELSE payload || $4::jsonb END
    WHERE job_id = $1`,

  //  $1 job_id, $2 error, $3 max attempts
  retryOrFailJob: `
    UPDATE classroom_email_jobs
    SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
        last_error = $2, send_after = NOW() + (attempts * interval '5 minutes')
    WHERE job_id = $1`,

  // ── Send-time content ───────────────────────────────────────────────────

  //  $1 user_id
  selectRecipient: `
    SELECT u.user_id, u.first_name, u.last_name, u.role::text AS role, LOWER(TRIM(u.email)) AS email,
           COALESCE(u.is_archived, FALSE) AS is_archived, (u.password = '!') AS invite_pending
    FROM users u WHERE u.user_id = $1`,

  //  Does this login still get class email? $1 user_id
  selectStudentEmailOn: `
    SELECT EXISTS (SELECT 1 FROM students s ${STUDENT_EMAIL_FROM('s')}
                   WHERE su.user_id = $1 AND ${STUDENT_EMAIL_OK('s')}) AS email_on`,

  //  One new item as this student sees it now. $1 item_id, $2 student_id, $3 user_id, $4 now
  selectNewWork: `
    SELECT i.item_id, i.kind, COALESCE(a.name, i.title) AS title, i.instructions, i.due_at,
           TO_CHAR(a.date, 'YYYY-MM-DD') AS date, a.max_score, i.email_students, i.deleted_at,
           (i.status = 'posted' OR (i.status = 'scheduled' AND i.publish_at <= $4::timestamptz)) AS posted,
           c.subject, c.archived_at,
           ${TEACHER_NAME('cu', 'tu')} AS teacher_name,
           CASE WHEN cu.user_id IS NOT NULL THEN cu.avatar ELSE tu.avatar END AS teacher_avatar,
           (c.archived_at IS NULL AND ${ITEM_VISIBLE('i', 'a', 'st', '$4::timestamptz')}) AS visible,
           EXISTS (SELECT 1 FROM students s ${STUDENT_EMAIL_FROM('s')}
                   WHERE s.student_id = st.student_id AND su.user_id = $3 AND ${STUDENT_EMAIL_OK('s')}) AS email_on
    FROM classwork_items i
    JOIN classes c ON c.class_id = i.class_id
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    CROSS JOIN (SELECT $2::uuid AS student_id) st
    LEFT JOIN users cu ON cu.user_id = i.created_by AND cu.is_archived IS NOT TRUE
    LEFT JOIN users tu ON tu.user_id = c.teacher_id AND tu.is_archived IS NOT TRUE
    WHERE i.item_id = $1`,

  //  The login's visible turn-in work due on one day, reminders on, still to
  //  turn in. $1 user_id, $2 'YYYY-MM-DD', $3 now
  selectDueOn: `
    SELECT i.item_id, COALESCE(a.name, i.title) AS title, c.subject, i.due_at
    FROM students s
    ${STUDENT_EMAIL_FROM('s')}
    JOIN class_students ro ON ro.student_id = s.student_id
    JOIN classes c ON c.class_id = ro.class_id AND c.archived_at IS NULL
    JOIN classwork_items i ON i.class_id = c.class_id
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    ${WORK_JOINS('s.student_id')}
    WHERE su.user_id = $1 AND ${STUDENT_EMAIL_OK('s')} AND i.remind_students AND ${TURN_IN_ITEM}
      AND i.due_at >= ${DAY_START('$2::date')} AND i.due_at < ${DAY_START('$2::date + 1')}
      AND ${ITEM_VISIBLE('i', 'a', 's', '$3::timestamptz')}
      AND ${WORK_STATE_AT('$3::timestamptz')} = 'assigned'
    ORDER BY i.due_at, title, i.item_id`,

  //  The login's work published since $2 that the student may see, with a
  //  grade or feedback to show (a Missing is not "graded": the student sees
  //  it in the portal), minus what an earlier graded email already carried.
  //  $1 user_id, $2 since, $3 now, $4 recipient email, $5 this job's id
  selectGradedWork: `
    SELECT sub.submission_id::text AS submission_id, ${PUBLISHED_KEY} AS published_key, sub.published_at,
           i.item_id, i.kind, COALESCE(a.name, i.title) AS title, c.subject, a.max_score,
           CASE WHEN ${GRADE_VISIBLE} THEN sa.score END AS score,
           CASE WHEN ${GRADE_VISIBLE} THEN sa.status END AS status,
           sub.feedback,
           ${TEACHER_NAME('gb', 'tu')} AS teacher_name
    FROM students s
    ${STUDENT_EMAIL_FROM('s')}
    JOIN classwork_submissions sub ON sub.student_id = s.student_id AND sub.published_at > $2::timestamptz
    JOIN classwork_items i ON i.item_id = sub.item_id
    JOIN classes c ON c.class_id = i.class_id AND c.archived_at IS NULL
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = s.student_id
    LEFT JOIN users gb ON gb.user_id = sub.graded_by AND gb.is_archived IS NOT TRUE
    LEFT JOIN users tu ON tu.user_id = c.teacher_id AND tu.is_archived IS NOT TRUE
    WHERE su.user_id = $1 AND ${STUDENT_EMAIL_OK('s')}
      AND ${FEEDBACK_VISIBLE}
      AND ${ITEM_VISIBLE('i', 'a', 's', '$3::timestamptz')}
      AND (${GRADE_VISIBLE} OR sub.feedback IS NOT NULL)
      AND NOT (${GRADE_VISIBLE} AND sa.status = 'missing')
      AND NOT EXISTS (
        SELECT 1 FROM classroom_email_jobs j
        WHERE LOWER(j.recipient_email) = LOWER($4) AND j.kind = 'graded' AND j.status = 'sent' AND j.job_id <> $5
          AND j.payload->'emailed' @> jsonb_build_array(jsonb_build_object('id', sub.submission_id::text, 'at', ${PUBLISHED_KEY})))
    ORDER BY sub.published_at, title, i.item_id`,

  //  A guardian's children of the active year, in schools with classrooms on,
  //  oldest grade first (the P3 board). $1 parent user_id
  selectGuardianChildren: `
    SELECT s.student_id, s.name, s.grade::text AS grade, s.school_year_id, ${studentAvatarSql('s')}
    FROM students s
    JOIN school_classroom_settings scs ON scs.school = s.school AND scs.enabled
    WHERE s.is_archived IS NOT TRUE AND ${ACTIVE_YEAR('s')}
      AND EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id AND ps.parent_id = $1)
    ORDER BY ${GRADE_RANK('s.grade::text')} DESC, s.name, s.student_id`,

  //  The children's visible work that may belong in a summary or alert: due
  //  (or dated) from $4 on, or published after $3. The state and what is
  //  visible are judged at $2; classroomDigest sorts the rows into sections.
  //  $1 student ids, $2 now, $3 since, $4 earliest day 'YYYY-MM-DD'
  selectChildWork: `
    SELECT ro.student_id, i.item_id, i.kind, i.assessment_id, COALESCE(a.name, i.title) AS title, c.subject,
           c.grade::text AS class_grade, i.due_at, TO_CHAR(a.date, 'YYYY-MM-DD') AS date,
           ${WORK_STATE_AT('$2::timestamptz')} AS state,
           ${GRADE_VISIBLE} AS grade_visible,
           CASE WHEN ${GRADE_VISIBLE} THEN sa.score END AS score,
           CASE WHEN ${GRADE_VISIBLE} THEN sa.status END AS status,
           a.max_score,
           CASE WHEN ${GRADE_VISIBLE} THEN COALESCE(sub.published_at, a.published_at) END AS grade_published_at,
           CASE WHEN ${FEEDBACK_VISIBLE} THEN sub.feedback END AS feedback,
           CASE WHEN ${FEEDBACK_VISIBLE} THEN sub.published_at END AS feedback_published_at,
           ${TEACHER_NAME('gb', 'tu')} AS teacher_name
    FROM class_students ro
    JOIN classes c ON c.class_id = ro.class_id AND c.archived_at IS NULL
    JOIN classwork_items i ON i.class_id = c.class_id
    LEFT JOIN assessments a ON a.assessment_id = i.assessment_id
    ${WORK_JOINS('ro.student_id')}
    LEFT JOIN users gb ON gb.user_id = sub.graded_by AND gb.is_archived IS NOT TRUE
    LEFT JOIN users tu ON tu.user_id = c.teacher_id AND tu.is_archived IS NOT TRUE
    WHERE ro.student_id = ANY($1::uuid[])
      AND (i.due_at >= ${DAY_START('$4::date')}
           OR (i.due_at IS NULL AND a.date >= $4::date)
           OR sub.published_at > $3::timestamptz
           OR a.published_at > $3::timestamptz)
      AND ${ITEM_VISIBLE('i', 'a', 'ro', '$2::timestamptz')}
    ORDER BY ro.student_id, i.due_at NULLS LAST, title, i.item_id`,

  //  Posts in the children's audience published in ($2, $3], with whether
  //  this parent has pressed "Got it". $1 student ids, $2 since, $3 now, $4 parent user_id
  selectChildPosts: `
    SELECT s.student_id, a.announcement_id, a.title, a.body, a.ack_requested, a.published_at,
           NULLIF(TRIM(CONCAT(au.first_name, ' ', au.last_name)), '') AS author_name,
           EXISTS (SELECT 1 FROM announcement_acks k WHERE k.announcement_id = a.announcement_id AND k.user_id = $4) AS acked
    FROM students s
    JOIN announcements a ON a.school = s.school AND a.deleted_at IS NULL
                         AND a.published_at > $2::timestamptz AND a.published_at <= $3::timestamptz
    LEFT JOIN classes cl ON cl.class_id = a.class_id
    LEFT JOIN users au ON au.user_id = a.author_id
    WHERE s.student_id = ANY($1::uuid[]) AND ${IN_AUDIENCE('s')}
      AND (cl.class_id IS NULL OR cl.archived_at IS NULL)
      AND (a.school_year_id IS NULL OR a.school_year_id = s.school_year_id)
    ORDER BY a.published_at, a.announcement_id`,

  // ── Preferences ─────────────────────────────────────────────────────────

  //  The parent's saved row (all NULL when none) and the school's day. $1 user_id, $2 school
  selectPrefs: `
    SELECT np.weekly_summary, np.summary_frequency, np.summary_dow, np.missing_alerts,
           (SELECT scs.summary_dow FROM school_classroom_settings scs WHERE scs.school = $2) AS school_dow
    FROM (SELECT $1::uuid AS user_id) me
    LEFT JOIN notification_prefs np ON np.user_id = me.user_id`,

  //  $1 user_id, $2 weekly_summary, $3 summary_frequency, $4 summary_dow, $5 missing_alerts
  upsertPrefs: `
    INSERT INTO notification_prefs (user_id, weekly_summary, summary_frequency, summary_dow, missing_alerts, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET weekly_summary = EXCLUDED.weekly_summary, summary_frequency = EXCLUDED.summary_frequency,
        summary_dow = EXCLUDED.summary_dow, missing_alerts = EXCLUDED.missing_alerts, updated_at = NOW()
    RETURNING weekly_summary, summary_frequency, summary_dow, missing_alerts`,
};

module.exports = classroomEmailQueries;
