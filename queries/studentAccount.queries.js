// queries/studentAccount.queries.js
//
// Student logins (users.role 'STUDENT') for Admin Panel → Student accounts.
// A login is tied to one student row per school year through
// student_account_links; student_accounts holds the consent record and the QR
// card. Every statement is pinned to a school by the caller's token.

// One StudentAccountRow per student row: the linked login (if any), its
// consent and QR state, and the first conflict on the student's own address
// (another account already uses it, or it is a parent's address on file).
// students.grade is the "GRADE" enum in prod, so it is read as text.
// student_avatar: the displayed avatar (the login's own pick over the teacher-set one).
const { studentAvatarSql } = require('../utils/avatar');
const { GRADE_RANK } = require('../utils/gradeRank');
const { conflictLateral } = require('../services/classroom/emailProblems');

// The latest invite of the login (inv.*) and the first conflict on the
// student's own address (services/classroom/emailProblems.js conflictLateral).
const ROW_SELECT = `
SELECT s.student_id, s.name, s.grade::text AS grade, s.student_email, s.school_year_id,
       ${studentAvatarSql('s', 'student_avatar')},
       NULLIF(TRIM(CONCAT(h.first_name, ' ', h.last_name)), '') AS homeroom_teacher_name,
       u.user_id, u.email AS account_email, u.is_archived, (u.password = '!') AS invite_pending,
       (u.google_sub IS NOT NULL) AS has_google,
       u.created_at AS account_created_at, u.last_login_at, u.last_seen_at,
       sa.consent_at, sa.consent_notice_version, NULLIF(TRIM(CONCAT(cb.first_name, ' ', cb.last_name)), '') AS consent_by_name,
       sa.qr_issued_at, sa.qr_voided_at, (sa.qr_secret_hash IS NOT NULL AND sa.qr_voided_at IS NULL) AS qr_active,
       sa.activated_at, sa.activated_via,
       inv.send_status AS invite_send_status, inv.sent_at AS invite_sent_at, inv.expires_at AS invite_expires_at,
       inv.ended_at AS invite_ended_at, inv.end_reason AS invite_end_reason, inv.send_error AS invite_send_error,
       cf.kind AS conflict_kind, cf.role AS conflict_role, cf.same_school AS conflict_same_school,
       cf.other_name AS conflict_other_name, cf.other_grade AS conflict_other_grade
FROM students s
LEFT JOIN users h ON h.user_id = s.homeroom_teacher_id
LEFT JOIN student_account_links sal ON sal.student_id = s.student_id
LEFT JOIN users u ON u.user_id = sal.user_id
LEFT JOIN student_accounts sa ON sa.user_id = u.user_id
LEFT JOIN users cb ON cb.user_id = sa.consent_by
LEFT JOIN LATERAL (
  SELECT si.send_status, si.sent_at, si.expires_at, si.ended_at, si.end_reason, si.send_error
    FROM student_invites si WHERE si.user_id = u.user_id ORDER BY si.created_at DESC LIMIT 1) inv ON TRUE
${conflictLateral('s', 's.student_email', 'u.user_id')}`;

const studentAccountQueries = {
  //  $1 = school, $2 = school_year_id
  //  JK and SK first, then Grades 1-8 (GRADE_RANK, the T7 ruling); by name within a grade.
  selectStudentAccountRows: `${ROW_SELECT}
WHERE s.school = $1 AND s.school_year_id = $2 AND s.is_archived IS NOT TRUE
ORDER BY ${GRADE_RANK('s.grade::text')}, s.name, s.student_id`,

  //  $1 = school, $2 = student_id
  selectStudentAccountRow: `${ROW_SELECT}
WHERE s.school = $1 AND s.student_id = $2`,

  //  Invite only reaches the year's current (not withdrawn) rows, so a login
  //  is never linked to a stale row. $1 = school, $2 = student_id[], $3 = school_year_id
  selectStudentAccountRowsByIds: `${ROW_SELECT}
WHERE s.school = $1 AND s.student_id = ANY($2::uuid[]) AND s.school_year_id = $3 AND s.is_archived IS NOT TRUE`,

  //  Consent is confirmed by the admin in the invite request and recorded on
  //  the account row created in the same transaction as the login.
  //  $1 = user_id, $2 = school, $3 = admin user_id, $4 = consent notice version
  insertStudentAccount: `
    INSERT INTO student_accounts (user_id, school, consent_by, consent_at, consent_notice_version, created_by)
    VALUES ($1, $2, $3, NOW(), $4, $3)
  `,

  //  $1 = user_id, $2 = student_id, $3 = school_year_id, $4 = linked_by
  insertStudentAccountLink: `
    INSERT INTO student_account_links (user_id, student_id, school_year_id, linked_by)
    VALUES ($1, $2, $3, $4)
  `,

  //  A relinked student with no address of their own takes the login's.
  //  $1 = student_id, $2 = email
  fillBlankStudentEmail: `
    UPDATE students
    SET student_email = $2, last_modified_at = NOW()
    WHERE student_id = $1 AND NULLIF(TRIM(student_email), '') IS NULL
  `,

  //  $1 = user_id, $2 = school, $3 = email (lowercased)
  updateStudentUserEmail: `
    UPDATE users
    SET email = $3, last_modified_at = NOW()
    WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT'
  `,

  //  Archive keeps every record and revokes sign-in, like an archived staff
  //  account. $1 = user_id, $2 = school, $3 = archived_by
  archiveStudentUser: `
    UPDATE users
    SET is_archived = true,
        archived_at = NOW(),
        archived_by = $3,
        is_verified_school = false,
        last_modified_at = NOW()
    WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT' AND is_archived = false
    RETURNING user_id
  `,

  //  $1 = user_id, $2 = school
  unarchiveStudentUser: `
    UPDATE users
    SET is_archived = false,
        archived_at = NULL,
        archived_by = NULL,
        is_verified_school = true,
        last_modified_at = NOW()
    WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT' AND is_archived = true
    RETURNING user_id
  `,

  //  Rows for printing QR cards: only current rows of the ACTIVE year, the
  //  row the sign-in gate judges the grade on. A past year's row (or a past
  //  year's class roster) never mints a card. $1 = school, $2 = student_id[]
  selectStudentAccountRowsForCards: `${ROW_SELECT}
JOIN school_years cur ON cur.school_year_id = s.school_year_id AND cur.is_active
WHERE s.school = $1 AND s.student_id = ANY($2::uuid[]) AND s.is_archived IS NOT TRUE`,

  //  Printing a card always reissues it: only the hash is stored, so the
  //  new secret voids any older card. $1 = user_id, $2 = sha-256 hex
  setQrSecret: `
    UPDATE student_accounts
    SET qr_secret_hash = $2, qr_issued_at = NOW(), qr_voided_at = NULL, updated_at = NOW()
    WHERE user_id = $1
  `,

  //  Void the live QR cards of these students' logins. $1 = school, $2 = student_id[]
  voidQrForStudents: `
    UPDATE student_accounts sa
    SET qr_voided_at = NOW(), updated_at = NOW()
    FROM student_account_links sal
    JOIN students s ON s.student_id = sal.student_id
    WHERE sa.user_id = sal.user_id
      AND s.school = $1 AND s.student_id = ANY($2::uuid[])
      AND sa.qr_secret_hash IS NOT NULL AND sa.qr_voided_at IS NULL
    RETURNING sa.user_id
  `,

  //  A QR card's login: the user row plus its card hash. $1 = user_id
  selectQrLoginUser: `
    SELECT u.*, sa.qr_secret_hash, sa.qr_voided_at
    FROM users u
    JOIN student_accounts sa ON sa.user_id = u.user_id
    WHERE u.user_id = $1
  `,

  //  Which of these students are on the class roster. $1 = class_id, $2 = student_id[]
  selectEnrolledStudentIds: `
    SELECT student_id FROM class_students WHERE class_id = $1 AND student_id = ANY($2::uuid[])
  `,

  //  The sign-in address, avatar and photo of a student login. $1 = user_id
  selectStudentUserEmail: `
    SELECT email, avatar, photo_path FROM users WHERE user_id = $1
  `,

  //  A student row's displayed avatar (the login's pick over the teacher-set one), as Home shows it. $1 = student_id
  selectStudentDisplayAvatar: `
    SELECT ${studentAvatarSql('s')} FROM students s WHERE s.student_id = $1
  `,

  //  An issued, not yet voided QR card stops working. $1 = user_id
  voidQr: `
    UPDATE student_accounts
    SET qr_voided_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND qr_secret_hash IS NOT NULL AND qr_voided_at IS NULL
  `,

  //  Student logins of the school with no link for the given year, for the
  //  relink picker. $1 = school, $2 = school_year_id (NULL: none are linked)
  selectUnlinkedStudentUsers: `
    SELECT u.user_id,
           NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS name,
           u.email,
           (SELECT sy.label
              FROM student_account_links l
              JOIN school_years sy ON sy.school_year_id = l.school_year_id
             WHERE l.user_id = u.user_id
             ORDER BY sy.start_date DESC
             LIMIT 1) AS last_school_year_label
    FROM users u
    WHERE u.school = $1 AND u.role::text = 'STUDENT'
      AND NOT EXISTS (
        SELECT 1 FROM student_account_links l
         WHERE l.user_id = u.user_id AND l.school_year_id = $2::uuid
      )
    ORDER BY lower(u.last_name), lower(u.first_name), u.email
  `,

  //  $1 = user_id, $2 = school
  selectStudentUserInSchool: `
    SELECT u.user_id, u.email, u.first_name, u.last_name, u.is_archived, (u.password = '!') AS invite_pending, sa.consent_at
    FROM users u
    LEFT JOIN student_accounts sa ON sa.user_id = u.user_id
    WHERE u.user_id = $1 AND u.school = $2 AND u.role::text = 'STUDENT'
  `,

  //  A changed address is a new sign-in: the password goes back to the
  //  invite placeholder, the Google link is dropped, every session from before
  //  ends and the account reads as never activated. $1 = user_id, $2 = school
  resetStudentSignIn: `
    WITH u AS (
      UPDATE users SET password = '!', google_sub = NULL, last_modified_at = NOW()
      WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT'
      RETURNING user_id
    )
    UPDATE student_accounts sa
    SET sessions_revoked_at = NOW(), activated_at = NULL, activated_via = NULL, updated_at = NOW()
    FROM u WHERE sa.user_id = u.user_id
  `,

  //  $1 = user_id, $2 = school_year_id
  selectLinkForUserYear: `
    SELECT student_id FROM student_account_links WHERE user_id = $1 AND school_year_id = $2
  `,

  //  Cascades to student_accounts, every year's link and any open tokens.
  //  $1 = user_id, $2 = school
  deleteStudentUser: `
    DELETE FROM users WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT'
  `,

  //  A student of the school and its linked login (user_id NULL when none),
  //  for the student form's email guard. $1 = student_id, $2 = school
  selectStudentWithLogin: `
    SELECT s.student_id, u.user_id, u.email
    FROM students s
    LEFT JOIN student_account_links sal ON sal.student_id = s.student_id
    LEFT JOIN users u ON u.user_id = sal.user_id
    WHERE s.student_id = $1 AND s.school = $2
  `,

  //  The roster of one class of the school. $1 = class_id, $2 = school
  selectClassRosterIds: `
    SELECT cs.student_id
    FROM class_students cs
    JOIN classes c ON c.class_id = cs.class_id
    WHERE cs.class_id = $1 AND c.school = $2
  `,

  //  $1 = student_id
  selectLinkByStudent: `
    SELECT user_id FROM student_account_links WHERE student_id = $1
  `,
};

module.exports = studentAccountQueries;
