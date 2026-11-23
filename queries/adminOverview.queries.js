// queries/adminOverview.queries.js
//
// The admin panel's overview (GET /api/admin/overview,
// services/adminOverview/blocks.js): one small read per admin area, each
// counting what that area's own page shows, so a number here never disagrees
// with the page it links to. Every statement is pinned to the caller's school
// (the patch notes are platform-wide). Dates leave as text (YYYY-MM-DD).
//
// Blocks that reuse another area's statement as-is (pending student requests,
// new form submissions, the student-accounts roster, the latest QuickBooks
// job) read it from that area's queries file instead.

const { IS_EMAIL, OFFICE_REMOVED } = require('./guardianSql');
const { HAS_UNPUBLISHED_CHANGES } = require('./reportTemplates.queries');
const { LISTED_RUN } = require('./reportGeneration.queries');

module.exports = {
  //  Approvals → Pending: the selectApprovalUsers filter (adminApproval.queries.js)
  //  minus the declined rows. The page splits on isVerified: anything but
  //  false is pending (waiting on an admin), false is unverified (waiting on
  //  their email). $1 school
  approvalCounts: `
    SELECT COUNT(*) FILTER (WHERE is_verified IS NOT FALSE)::int AS pending_signups,
           COUNT(*) FILTER (WHERE is_verified IS FALSE)::int AS unverified_signups
    FROM users
    WHERE school = $1
      AND is_verified_school = false
      AND (is_verified = true OR role <> 'ADMIN')
      AND is_archived = false`,

  //  The Users page's tiles: every account that isn't a student login or
  //  archived, by role; invited = the invite sentinel password (statusOf in
  //  the web's adminUsers/userDisplay.tsx). $1 school
  userCounts: `
    SELECT COUNT(*) FILTER (WHERE role::text = 'ADMIN')::int AS admins,
           COUNT(*) FILTER (WHERE role::text = 'TEACHER')::int AS teachers,
           COUNT(*) FILTER (WHERE role::text = 'PARENT')::int AS parents,
           COUNT(*) FILTER (WHERE password = '!')::int AS invited_not_signed_in
    FROM users
    WHERE school = $1 AND role::text <> 'STUDENT' AND is_archived IS NOT TRUE`,

  //  The year's students, and those nobody can be reached about: no guardian
  //  row and no usable mother/father address on the file. "Usable" is
  //  messaging's STAFF_GUARDIANS rule (messaging.queries.js): a real address,
  //  not removed by the office, and not the address of an archived account or
  //  a student login. $1 school, $2 school_year_id|null
  guardianCoverage: `
    SELECT COUNT(*)::int AS students,
           COUNT(*) FILTER (WHERE
             NOT EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = s.student_id)
             AND NOT EXISTS (
               SELECT 1
               FROM (VALUES (s.mother_email), (s.father_email)) AS f(email)
               LEFT JOIN LATERAL (
                 SELECT u.user_id, u.is_archived, u.role FROM users u
                 WHERE LOWER(u.email) = LOWER(TRIM(f.email)) AND u.school = s.school LIMIT 1
               ) a ON TRUE
               WHERE ${IS_EMAIL('f.email')}
                 AND NOT ${OFFICE_REMOVED('s', 'f.email')}
                 AND (a.user_id IS NULL OR (a.is_archived IS NOT TRUE AND a.role::text <> 'STUDENT'))
             ))::int AS without_guardian
    FROM students s
    WHERE s.school = $1 AND ($2::uuid IS NULL OR s.school_year_id = $2) AND s.is_archived IS NOT TRUE`,

  //  Open threads of the year (by the student, like the admin list) whose last
  //  real message (not removed, not a system line: messaging's needs-reply
  //  rule) came from a family member, how many of those have waited 48 hours
  //  or more since it, and how many open threads have an email that failed
  //  (selectFailedEmailConversations, set-based: the jobs table has no index
  //  on conversation_id beyond pending rows). $1 school, $2 school_year_id|null
  messageCounts: `
    WITH failed AS (
      SELECT DISTINCT conversation_id FROM message_email_jobs WHERE school = $1 AND status = 'failed'
    )
    SELECT COUNT(*) FILTER (WHERE lr.sender_role IN ('PARENT', 'STUDENT'))::int AS awaiting_reply,
           COUNT(*) FILTER (WHERE lr.sender_role IN ('PARENT', 'STUDENT')
                              AND lr.created_at <= NOW() - INTERVAL '48 hours')::int AS waiting_over_two_days,
           COUNT(f.conversation_id)::int AS failed_email_conversations
    FROM conversations c
    JOIN students s ON s.student_id = c.student_id
    LEFT JOIN failed f ON f.conversation_id = c.conversation_id
    LEFT JOIN LATERAL (
      SELECT m.sender_role, m.created_at FROM messages m
      WHERE m.conversation_id = c.conversation_id AND m.kind = 'message' AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC LIMIT 1
    ) lr ON TRUE
    WHERE c.school = $1 AND ($2::uuid IS NULL OR s.school_year_id = $2) AND c.status = 'open'`,

  //  The selected year's terms (terms repeat their names every year, so never
  //  by name). $1 school, $2 school_year_id
  yearTerms: `
    SELECT term_id, name, start_date::text AS start_date, end_date::text AS end_date
    FROM terms
    WHERE school = $1 AND school_year_id = $2
    ORDER BY start_date, name`,

  //  The next day (or days) the school is closed, from today on.
  //  $1 school, $2 school_year_id|null, $3 today (Toronto date)
  nextClosure: `
    SELECT event_id, title, start_date::text AS start_date, COALESCE(end_date, start_date)::text AS end_date
    FROM school_calendar_events
    WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
      AND is_school_closed AND COALESCE(end_date, start_date) >= $3::date
    ORDER BY start_date, title
    LIMIT 1`,

  //  Which of the school's three report images are uploaded. One row even
  //  when the school has none. $1 school
  assetPresence: `
    SELECT COALESCE(bool_or(NULLIF(TRIM(logo_path), '') IS NOT NULL), false) AS logo,
           COALESCE(bool_or(NULLIF(TRIM(principal_signature_path), '') IS NOT NULL), false) AS signature,
           COALESCE(bool_or(NULLIF(TRIM(school_stamp_path), '') IS NOT NULL), false) AS stamp
    FROM school_assets
    WHERE school_code = $1`,

  //  The designer's list (listTemplates), counted: the comparison reads both
  //  docs, so this block runs last. $1 school
  templateCounts: `
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE ${HAS_UNPUBLISHED_CHANGES})::int AS with_unpublished_changes
    FROM report_templates t
    LEFT JOIN report_template_versions v ON v.version_id = t.published_version_id
    WHERE t.school = $1 AND t.archived_at IS NULL`,

  //  Report generation runs the pages still list (selectListedRuns, every
  //  report and term): those still running, and the students that failed to
  //  print on any of them. $1 school, $2 school_year_id|null
  reportRunCounts: `
    WITH listed AS (
      SELECT r.run_id, r.finished_at
      FROM report_generation_runs r
      WHERE r.school = $1 AND r.school_year_id IS NOT DISTINCT FROM $2::uuid
        AND ${LISTED_RUN}
    )
    SELECT (SELECT COUNT(*) FROM listed WHERE finished_at IS NULL)::int AS running,
           (SELECT COUNT(*) FROM report_generation_items i JOIN listed l ON l.run_id = i.run_id
             WHERE i.status = 'failed')::int AS failed_items`,

  //  Every form the caller may list (formCreatorFilter) with its new
  //  submissions, as the Forms page counts them (selectFormsBySchool).
  //  $1 school, $2 created_by|null
  formSummaries: `
    SELECT f.slug, f.title, f.status,
           (SELECT COUNT(*) FROM registration_form_submissions s
             WHERE s.form_id = f.form_id AND s.status = 'new')::int AS new_submissions
    FROM registration_forms f
    WHERE f.school = $1 AND ($2::uuid IS NULL OR f.created_by = $2::uuid)
    ORDER BY f.created_at DESC`,

  //  The year's timetables that say something: the live one, drafts set to
  //  go live, and go-lives that failed (services/schedulePlanner/goLiveWorker.js).
  //  No sessions or snapshots. $1 school, $2 school_year_id|null
  plannerSchedules: `
    SELECT schedule_id, name, status, published_at, go_live_status,
           go_live_on::text AS go_live_on, effective_from::text AS effective_from, updated_at
    FROM planner_schedules
    WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
      AND (status = 'published' OR go_live_status IN ('pending', 'running', 'failed'))
    ORDER BY updated_at DESC`,

  //  The newest agenda (selectAgendasBySchool's order). $1 school
  latestAgenda: `
    SELECT agenda_id, title, academic_year, status
    FROM agendas
    WHERE school = $1
    ORDER BY academic_year DESC
    LIMIT 1`,

  //  The year's parent–teacher meetings events, each with its days (for
  //  services/meetings/time.js phaseOf), its bookings and the students they
  //  cover. $1 school, $2 school_year_id|null
  meetingEvents: `
    SELECT e.event_id, e.title, e.status, e.cutoff_min, e.opens_at, e.last_call_at, e.created_at,
           COALESCE((SELECT json_agg(json_build_object('day_date', d.day_date::text, 'start_min', d.start_min, 'end_min', d.end_min)
                                     ORDER BY d.day_date)
                     FROM ptm_days d WHERE d.event_id = e.event_id), '[]'::json) AS days,
           (SELECT COUNT(*) FROM ptm_bookings b WHERE b.event_id = e.event_id)::int AS bookings,
           (SELECT COUNT(DISTINCT bs.student_id) FROM ptm_booking_students bs WHERE bs.event_id = e.event_id)::int AS students_booked
    FROM ptm_events e
    WHERE e.school = $1 AND ($2::uuid IS NULL OR e.school_year_id = $2)
    ORDER BY e.created_at`,

  //  The QuickBooks connection's health, never its tokens (selectConnection
  //  reads those). $1 school
  financeConnection: `
    SELECT status, last_success_at, last_error, consecutive_failures
    FROM finance_qbo_connections
    WHERE school = $1`,

  //  $1 school
  customRoleCount: `
    SELECT COUNT(*)::int AS n FROM staff_roles WHERE school = $1`,

  //  Platform-wide (patch notes have no school and no draft state): the last
  //  one out, and how many are set to publish later.
  patchNoteCounts: `
    SELECT MAX(published_at) FILTER (WHERE published_at <= NOW()) AS last_published_at,
           COUNT(*) FILTER (WHERE published_at > NOW())::int AS scheduled
    FROM patch_notes`,
};
