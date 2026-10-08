// queries/announcement.queries.js
//
// Audience is never stored. `IN_AUDIENCE(s)` says whether student alias `s`
// is in the audience of announcement alias `a`; every list, guard, count
// and enqueue is built on it so they can never disagree.

const IN_AUDIENCE = (s) => `
  (${s}.school = a.school AND ${s}.is_archived IS NOT TRUE AND (
     (a.scope = 'class'  AND EXISTS (SELECT 1 FROM class_students cs WHERE cs.class_id = a.class_id AND cs.student_id = ${s}.student_id))
  OR (a.scope = 'grade'  AND ${s}.grade = a.grade AND (a.school_year_id IS NULL OR ${s}.school_year_id = a.school_year_id))
  OR (a.scope = 'school' AND (a.school_year_id IS NULL OR ${s}.school_year_id = a.school_year_id))))`;

// Teacher-side visibility (also the teacher's own posts). `u` = user id param.
const TEACHER_SEES = (u) => `
  (a.author_id = ${u}
   OR a.scope = 'school'
   OR (a.scope = 'class' AND (cl.teacher_id = ${u} OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = a.class_id AND ct.teacher_id = ${u})))
   OR (a.scope = 'grade' AND (
        EXISTS (SELECT 1 FROM students hs WHERE hs.school = a.school AND hs.grade = a.grade AND hs.homeroom_teacher_id = ${u}
                  AND hs.is_archived IS NOT TRUE AND (a.school_year_id IS NULL OR hs.school_year_id = a.school_year_id))
     OR EXISTS (SELECT 1 FROM classes gc WHERE gc.school = a.school AND gc.grade = a.grade
                  AND (a.school_year_id IS NULL OR gc.school_year_id = a.school_year_id)
                  AND (gc.teacher_id = ${u} OR EXISTS (SELECT 1 FROM class_teachers ct2 WHERE ct2.class_id = gc.class_id AND ct2.teacher_id = ${u}))))))`;

const PARENT_SEES = (u) => `
  EXISTS (SELECT 1 FROM parent_students ps JOIN students s ON s.student_id = ps.student_id
          WHERE ps.parent_id = ${u} AND ${IN_AUDIENCE('s')})`;

const VISIBLE = (u, role) => `(${role} = 'ADMIN' OR (${role} = 'TEACHER' AND ${TEACHER_SEES(u)}) OR (${role} = 'PARENT' AND ${PARENT_SEES(u)}))`;

// Guardian accounts that can read: linked, not archived, not invite-pending.
const AUDIENCE_COUNT = `
  (SELECT COUNT(DISTINCT ps.parent_id) FROM students s
     JOIN parent_students ps ON ps.student_id = s.student_id AND ps.parent_id IS NOT NULL
     JOIN users u ON u.user_id = ps.parent_id AND u.is_archived = FALSE AND u.password <> '!'
   WHERE ${IN_AUDIENCE('s')})::int`;
const SEEN_COUNT = `
  (SELECT COUNT(*) FROM announcement_reads r JOIN users ru ON ru.user_id = r.user_id AND ru.role = 'PARENT'
   WHERE r.announcement_id = a.announcement_id)::int`;

const IS_PINNED = `(a.pinned_until IS NOT NULL AND a.pinned_until >= (NOW() AT TIME ZONE 'America/Toronto')::date)`;

const BASE_COLUMNS = `
  a.announcement_id, a.school, a.school_year_id, a.scope, a.class_id, a.grade, a.title, a.body,
  a.author_id, a.author_role, a.published_at, a.edited_at, a.deleted_at, a.created_at,
  TO_CHAR(a.pinned_until, 'YYYY-MM-DD') AS pinned_until,  -- DATE as the YYYY-MM-DD the API promises, not a JS Date
  cl.subject AS class_subject, cl.grade AS class_grade,
  TRIM(CONCAT(au.first_name, ' ', au.last_name)) AS author_name,
  ${IS_PINNED} AS is_pinned,
  (SELECT COUNT(*) FROM announcement_attachments x WHERE x.announcement_id = a.announcement_id)::int AS attachment_count`;

const BASE_FROM = `
  FROM announcements a
  LEFT JOIN classes cl ON cl.class_id = a.class_id
  LEFT JOIN users au ON au.user_id = a.author_id`;

const announcementQueries = {
  // $1 announcement_id, $2 user_id
  selectAnnouncementAccess: `
    SELECT ${BASE_COLUMNS},
      (a.author_id = $2) AS is_author,
      ${PARENT_SEES('$2')} AS is_guardian,
      ${TEACHER_SEES('$2')} AS is_class_teacher
    ${BASE_FROM}
    WHERE a.announcement_id = $1
  `,

  // $1 user_id, $2 school, $3 role, $4 school_year_id|null, $5 class_id|null, $6 scope|null,
  // $7 grade|null, $8 author_id|null, $9 mine, $10 unread_only, $11 q|null, $12 student_id|null, $13 limit
  listAnnouncements: `
    SELECT ${BASE_COLUMNS},
      (r.user_id IS NOT NULL OR a.author_id = $1) AS read,  -- your own post is never unread
      ${AUDIENCE_COUNT} AS audience_count,
      ${SEEN_COUNT} AS seen_count,
      (SELECT COALESCE(json_agg(json_build_object('studentId', s.student_id, 'name', s.name) ORDER BY s.name), '[]')
         FROM students s JOIN parent_students ps ON ps.student_id = s.student_id AND ps.parent_id = $1
        WHERE ${IN_AUDIENCE('s')}) AS children
    ${BASE_FROM}
    LEFT JOIN announcement_reads r ON r.announcement_id = a.announcement_id AND r.user_id = $1
    WHERE a.school = $2 AND a.deleted_at IS NULL
      AND ($4::uuid IS NULL OR a.school_year_id = $4 OR a.school_year_id IS NULL)
      AND ($5::uuid IS NULL OR a.class_id = $5)
      AND ($6::text IS NULL OR a.scope = $6)
      AND ($7::text IS NULL OR a.grade = $7 OR cl.grade = $7)
      AND ($8::uuid IS NULL OR a.author_id = $8)
      AND ($9::boolean IS FALSE OR a.author_id = $1)
      AND ($10::boolean IS FALSE OR (r.user_id IS NULL AND a.author_id IS DISTINCT FROM $1))
      AND ($11::text IS NULL OR a.title ILIKE '%' || $11 || '%' OR a.body ILIKE '%' || $11 || '%')
      AND ($12::uuid IS NULL OR EXISTS (SELECT 1 FROM students s WHERE s.student_id = $12 AND ${IN_AUDIENCE('s')}))
      AND ${VISIBLE('$1', '$3')}
    ORDER BY ${IS_PINNED} DESC, a.published_at DESC
    LIMIT $13
  `,

  // $1 user_id, $2 school, $3 role, $4 school_year_id|null
  countUnreadAnnouncements: `
    SELECT COUNT(*)::int AS unread_announcements
    ${BASE_FROM}
    LEFT JOIN announcement_reads r ON r.announcement_id = a.announcement_id AND r.user_id = $1
    WHERE a.school = $2 AND a.deleted_at IS NULL AND r.user_id IS NULL AND a.author_id IS DISTINCT FROM $1
      AND ($4::uuid IS NULL OR a.school_year_id = $4 OR a.school_year_id IS NULL)
      AND ${VISIBLE('$1', '$3')}
  `,

  // $1 school, $2 school_year_id, $3 scope, $4 class_id, $5 grade, $6 title, $7 body, $8 author_id, $9 author_role, $10 pinned_until
  insertAnnouncement: `
    INSERT INTO announcements (school, school_year_id, scope, class_id, grade, title, body, author_id, author_role, pinned_until)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING announcement_id, published_at
  `,
  // $1 id, $2 title, $3 body, $4 pinned_until
  updateAnnouncement: `
    UPDATE announcements SET title = $2, body = $3, pinned_until = $4, edited_at = NOW()
    WHERE announcement_id = $1 RETURNING edited_at
  `,
  // $1 id, $2 user_id
  softDeleteAnnouncement: `
    UPDATE announcements SET deleted_at = NOW(), deleted_by = $2 WHERE announcement_id = $1 AND deleted_at IS NULL RETURNING deleted_at
  `,

  // $1 announcement_id, $2 file_path, $3 file_name, $4 mime_type, $5 size_bytes
  insertAttachment: `
    INSERT INTO announcement_attachments (announcement_id, file_path, file_name, mime_type, size_bytes)
    VALUES ($1, $2, $3, $4, $5) RETURNING attachment_id
  `,
  selectAttachments: `
    SELECT attachment_id, announcement_id, file_path, file_name, mime_type, size_bytes
    FROM announcement_attachments WHERE announcement_id = $1 ORDER BY created_at
  `,
  // $1 attachment_id, $2 announcement_id
  selectAttachment: `
    SELECT attachment_id, file_path, file_name, mime_type FROM announcement_attachments
    WHERE attachment_id = $1 AND announcement_id = $2
  `,
  selectAttachmentPaths: `SELECT file_path FROM announcement_attachments WHERE announcement_id = $1`,
  // $1 announcement_id, $2 attachment_id[]
  deleteAttachmentsByIds: `
    DELETE FROM announcement_attachments WHERE announcement_id = $1 AND attachment_id = ANY($2::uuid[]) RETURNING file_path
  `,
  deleteAllAttachments: `DELETE FROM announcement_attachments WHERE announcement_id = $1`,

  // $1 announcement_id, $2 user_id
  upsertRead: `
    INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1, $2)
    ON CONFLICT (announcement_id, user_id) DO UPDATE SET read_at = announcement_reads.read_at
    RETURNING read_at
  `,

  // Who has / has not seen it, one row per guardian account or email-only link. $1 announcement_id
  selectReceipts: `
    WITH a AS (SELECT * FROM announcements WHERE announcement_id = $1),
    g AS (
      SELECT ps.parent_id, LOWER(TRIM(COALESCE(u.email, ps.parent_email))) AS email,
             COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name, ps.parent_email) AS name,
             MIN(ps.relation) AS relation,
             ARRAY_AGG(DISTINCT s.name ORDER BY s.name) AS student_names,
             BOOL_OR(u.password = '!') AS invite_pending, BOOL_OR(u.is_archived) AS archived
      FROM a JOIN students s ON ${IN_AUDIENCE('s')}
      JOIN parent_students ps ON ps.student_id = s.student_id
      LEFT JOIN users u ON u.user_id = ps.parent_id
      WHERE COALESCE(u.email, ps.parent_email) IS NOT NULL
      GROUP BY ps.parent_id, LOWER(TRIM(COALESCE(u.email, ps.parent_email))),
               COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name, ps.parent_email)
    )
    SELECT g.parent_id AS user_id, g.name, g.relation, g.student_names, r.read_at,
      CASE WHEN r.read_at IS NOT NULL THEN 'seen'
           WHEN g.parent_id IS NULL THEN 'no-account'
           WHEN g.invite_pending THEN 'invited'
           WHEN j.status = 'failed' THEN 'failed'
           WHEN j.status = 'sent' THEN 'emailed'
           ELSE 'pending' END AS state
    FROM g
    LEFT JOIN announcement_reads r ON r.announcement_id = $1 AND r.user_id = g.parent_id
    LEFT JOIN announcement_email_jobs j ON j.announcement_id = $1 AND LOWER(j.recipient_email) = g.email
    WHERE g.archived IS NOT TRUE
    ORDER BY (r.read_at IS NULL), r.read_at, g.name
  `,
  selectEmailStats: `
    SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
           COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
           COUNT(*) FILTER (WHERE kind = 'signup')::int AS signup,
           COUNT(*) FILTER (WHERE kind = 'invite')::int AS invite
    FROM announcement_email_jobs WHERE announcement_id = $1
  `,

  // ── Outbox ──────────────────────────────────────────────────
  // One job per distinct lower-cased email in the audience, never the author.
  // $1 announcement_id, $2 delay (interval text)
  enqueueAnnouncementJobs: `
    INSERT INTO announcement_email_jobs (announcement_id, recipient_id, recipient_email, kind, school, send_after)
    SELECT DISTINCT ON (email) $1, parent_id, email, kind, school, NOW() + $2::interval
    FROM (
      SELECT a.school, ps.parent_id, LOWER(TRIM(COALESCE(u.email, ps.parent_email))) AS email,
             CASE WHEN ps.parent_id IS NULL THEN 'signup' WHEN u.password = '!' THEN 'invite' ELSE 'account' END AS kind,
             CASE WHEN ps.parent_id IS NULL THEN 2 WHEN u.password = '!' THEN 1 ELSE 0 END AS pri
      FROM announcements a
      JOIN students s ON ${IN_AUDIENCE('s')}
      JOIN parent_students ps ON ps.student_id = s.student_id
      LEFT JOIN users u ON u.user_id = ps.parent_id
      LEFT JOIN users author ON author.user_id = a.author_id
      WHERE a.announcement_id = $1
        AND COALESCE(u.email, ps.parent_email) IS NOT NULL AND TRIM(COALESCE(u.email, ps.parent_email)) <> ''
        AND (u.user_id IS NULL OR u.is_archived = FALSE)
        AND (a.author_id IS NULL OR ps.parent_id IS DISTINCT FROM a.author_id)
        AND (author.email IS NULL OR LOWER(TRIM(COALESCE(u.email, ps.parent_email))) <> LOWER(author.email))
    ) x
    ORDER BY email, pri
    ON CONFLICT DO NOTHING
  `,
  cancelPendingAnnouncementJobs: `
    UPDATE announcement_email_jobs SET status = 'skipped', last_error = 'announcement removed'
    WHERE announcement_id = $1 AND status = 'pending'
  `,
  retryFailedAnnouncementJobs: `
    UPDATE announcement_email_jobs SET status = 'pending', attempts = 0, last_error = NULL, send_after = NOW()
    WHERE announcement_id = $1 AND status = 'failed' RETURNING job_id
  `,
  // Claim by pushing send_after forward so another instance leaves it alone
  // while this one works; a crash mid-send simply retries in 5 minutes.
  claimDueAnnouncementJob: `
    UPDATE announcement_email_jobs
    SET attempts = attempts + 1, send_after = NOW() + interval '5 minutes'
    WHERE job_id = (
      SELECT job_id FROM announcement_email_jobs
      WHERE status = 'pending' AND send_after <= NOW()
      ORDER BY send_after
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING job_id, announcement_id, recipient_id, recipient_email, kind, school, attempts
  `,
  // Everything the email needs, read at send time so an edit inside the window ships corrected. $1 job_id
  selectAnnouncementJobContext: `
    SELECT j.job_id, j.kind, j.recipient_id, j.recipient_email, j.school,
      a.announcement_id, a.title, a.body, a.scope, a.grade, a.deleted_at, a.author_id,
      cl.subject AS class_subject, cl.grade AS class_grade,
      TRIM(CONCAT(au.first_name, ' ', au.last_name)) AS author_name,
      COALESCE(u.first_name, split_part(pl.parent_name, ' ', 1)) AS recipient_first_name,
      u.is_archived AS recipient_archived,
      (SELECT COUNT(*) FROM announcement_attachments x WHERE x.announcement_id = a.announcement_id)::int AS attachment_count,
      (SELECT ARRAY_AGG(DISTINCT s.name ORDER BY s.name) FROM students s
         JOIN parent_students ps ON ps.student_id = s.student_id
        WHERE ${IN_AUDIENCE('s')} AND (ps.parent_id = j.recipient_id OR LOWER(TRIM(ps.parent_email)) = j.recipient_email)) AS child_names
    FROM announcement_email_jobs j
    JOIN announcements a ON a.announcement_id = j.announcement_id
    LEFT JOIN classes cl ON cl.class_id = a.class_id
    LEFT JOIN users au ON au.user_id = a.author_id
    LEFT JOIN users u ON u.user_id = j.recipient_id
    LEFT JOIN LATERAL (SELECT parent_name FROM parent_students WHERE LOWER(TRIM(parent_email)) = j.recipient_email LIMIT 1) pl ON TRUE
    WHERE j.job_id = $1
  `,
  // $1 job_id, $2 status, $3 last_error|null
  finishAnnouncementJob: `
    UPDATE announcement_email_jobs
    SET status = $2::text, last_error = $3, sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE sent_at END
    WHERE job_id = $1
  `,
  // $1 job_id, $2 error, $3 max_attempts
  retryOrFailAnnouncementJob: `
    UPDATE announcement_email_jobs
    SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
        last_error = $2, send_after = NOW() + (attempts * interval '5 minutes')
    WHERE job_id = $1
  `,
  selectFailedEmailAnnouncements: `
    SELECT DISTINCT announcement_id FROM announcement_email_jobs WHERE status = 'failed' AND announcement_id = ANY($1::uuid[])
  `,

  // ── Targets, scope checks, preview ──────────────────────────
  // $1 user_id, $2 school, $3 role, $4 school_year_id|null
  selectStaffClasses: `
    SELECT cl.class_id, cl.subject, cl.grade,
           (SELECT COUNT(*) FROM class_students cs JOIN students s ON s.student_id = cs.student_id
             WHERE cs.class_id = cl.class_id AND s.is_archived IS NOT TRUE)::int AS student_count
    FROM classes cl
    WHERE cl.school = $2 AND ($4::uuid IS NULL OR cl.school_year_id = $4)
      AND ($3 = 'ADMIN' OR cl.teacher_id = $1 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $1))
    ORDER BY cl.grade, cl.subject
  `,
  selectStaffGrades: `
    SELECT s.grade, COUNT(*)::int AS student_count
    FROM students s
    WHERE s.school = $2 AND s.is_archived IS NOT TRUE AND ($4::uuid IS NULL OR s.school_year_id = $4)
    GROUP BY s.grade
    HAVING $3 = 'ADMIN' OR BOOL_OR(s.homeroom_teacher_id = $1)
    ORDER BY LENGTH(s.grade), s.grade
  `,
  // $1 class_id, $2 user_id, $3 school_year_id|null
  canPostToClass: `
    SELECT cl.school, cl.subject, cl.grade,
      (($3::uuid IS NULL OR cl.school_year_id = $3) AND (cl.teacher_id = $2 OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = cl.class_id AND ct.teacher_id = $2))) AS allowed
    FROM classes cl WHERE cl.class_id = $1
  `,
  // $1 grade, $2 user_id, $3 school, $4 school_year_id|null
  canPostToGrade: `
    SELECT EXISTS (SELECT 1 FROM students s WHERE s.school = $3 AND s.grade = $1 AND s.homeroom_teacher_id = $2
                     AND s.is_archived IS NOT TRUE AND ($4::uuid IS NULL OR s.school_year_id = $4)) AS allowed
  `,
  // $1 school, $2 scope, $3 class_id|null, $4 grade|null, $5 school_year_id|null
  selectAudiencePreview: `
    WITH a AS (SELECT $1::school AS school, $2::text AS scope, $3::uuid AS class_id, $4::text AS grade, $5::uuid AS school_year_id),
    st AS (SELECT s.student_id, s.name FROM a, students s WHERE ${IN_AUDIENCE('s')}),
    g AS (
      SELECT LOWER(TRIM(COALESCE(u.email, ps.parent_email))) AS email,
             BOOL_OR(ps.parent_id IS NOT NULL AND u.password <> '!' AND u.is_archived = FALSE) AS has_account,
             BOOL_OR(ps.parent_id IS NOT NULL AND u.password = '!') AS invite_pending
      FROM st JOIN parent_students ps ON ps.student_id = st.student_id LEFT JOIN users u ON u.user_id = ps.parent_id
      WHERE COALESCE(u.email, ps.parent_email) IS NOT NULL AND TRIM(COALESCE(u.email, ps.parent_email)) <> ''
      GROUP BY 1
    )
    SELECT (SELECT COUNT(*) FROM st)::int AS students,
           (SELECT COUNT(*) FROM g WHERE has_account)::int AS guardians_with_account,
           (SELECT COUNT(*) FROM g WHERE NOT has_account AND invite_pending)::int AS guardians_invite_pending,
           (SELECT COUNT(*) FROM g WHERE NOT has_account AND NOT invite_pending)::int AS guardians_email_only,
           (SELECT COALESCE(json_agg(json_build_object('studentId', st.student_id, 'name', st.name) ORDER BY st.name), '[]')
              FROM st WHERE NOT EXISTS (SELECT 1 FROM parent_students ps LEFT JOIN users u ON u.user_id = ps.parent_id
                                        WHERE ps.student_id = st.student_id AND TRIM(COALESCE(u.email, ps.parent_email, '')) <> '')) AS students_without_email
  `,
  // "Ask about this": is this parent + child in the audience of this (live) announcement? $1 announcement_id, $2 parent_id, $3 student_id
  selectParentAnnouncementContext: `
    SELECT a.announcement_id, a.author_id, a.scope, a.class_id, a.school, a.deleted_at,
      EXISTS (SELECT 1 FROM students s WHERE s.student_id = $3 AND ${IN_AUDIENCE('s')}) AS student_in_audience,
      EXISTS (SELECT 1 FROM parent_students ps WHERE ps.student_id = $3 AND ps.parent_id = $2) AS is_guardian
    FROM announcements a WHERE a.announcement_id = $1
  `,
};

module.exports = announcementQueries;
module.exports.IN_AUDIENCE = IN_AUDIENCE;
