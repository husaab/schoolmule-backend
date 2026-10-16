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
const ROW_SELECT = `
SELECT s.student_id, s.name, s.grade::text AS grade, s.student_email, s.school_year_id,
       NULLIF(TRIM(CONCAT(h.first_name, ' ', h.last_name)), '') AS homeroom_teacher_name,
       u.user_id, u.email AS account_email, u.is_archived, (u.password = '!') AS invite_pending,
       u.created_at AS account_created_at, u.last_login_at, u.last_seen_at,
       sa.consent_at, sa.consent_notice_version, NULLIF(TRIM(CONCAT(cb.first_name, ' ', cb.last_name)), '') AS consent_by_name,
       sa.qr_issued_at, sa.qr_voided_at, (sa.qr_secret_hash IS NOT NULL AND sa.qr_voided_at IS NULL) AS qr_active,
       cf.kind AS conflict_kind, cf.role AS conflict_role
FROM students s
LEFT JOIN users h ON h.user_id = s.homeroom_teacher_id
LEFT JOIN student_account_links sal ON sal.student_id = s.student_id
LEFT JOIN users u ON u.user_id = sal.user_id
LEFT JOIN student_accounts sa ON sa.user_id = u.user_id
LEFT JOIN users cb ON cb.user_id = sa.consent_by
LEFT JOIN LATERAL (
  SELECT 'email_in_use' AS kind, x.role::text AS role FROM users x
   WHERE s.student_email IS NOT NULL AND LOWER(x.email) = LOWER(s.student_email) AND x.user_id IS DISTINCT FROM u.user_id
  UNION ALL
  SELECT 'family_address', NULL
   WHERE s.student_email IS NOT NULL
     AND LOWER(s.student_email) IN (LOWER(TRIM(COALESCE(s.mother_email, ''))), LOWER(TRIM(COALESCE(s.father_email, ''))))
  UNION ALL
  SELECT 'family_address', NULL FROM parent_students ps LEFT JOIN users pu ON pu.user_id = ps.parent_id
   WHERE ps.student_id = s.student_id AND s.student_email IS NOT NULL
     AND LOWER(s.student_email) = LOWER(TRIM(COALESCE(pu.email, ps.parent_email, '')))
  LIMIT 1) cf ON TRUE`;

const studentAccountQueries = {
  //  $1 = school, $2 = school_year_id
  selectStudentAccountRows: `${ROW_SELECT}
WHERE s.school = $1 AND s.school_year_id = $2 AND s.is_archived IS NOT TRUE
ORDER BY LENGTH(s.grade::text), s.grade::text, s.name`,

  //  $1 = school, $2 = student_id
  selectStudentAccountRow: `${ROW_SELECT}
WHERE s.school = $1 AND s.student_id = $2`,

  //  $1 = school, $2 = student_id[]
  selectStudentAccountRowsByIds: `${ROW_SELECT}
WHERE s.school = $1 AND s.student_id = ANY($2::uuid[])`,

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

  //  Anyone else already signing in with this address (users.email is unique
  //  across every school). $1 = email, $2 = user_id to ignore (or NULL)
  selectOtherUserByEmail: `
    SELECT user_id, role::text AS role
    FROM users
    WHERE LOWER(email) = LOWER($1) AND user_id IS DISTINCT FROM $2::uuid
    LIMIT 1
  `,

  //  $1 = student_id, $2 = school, $3 = student_email (lowercased) | NULL
  updateStudentEmail: `
    UPDATE students
    SET student_email = $3, last_modified_at = NOW()
    WHERE student_id = $1 AND school = $2
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
    SELECT user_id, email, first_name, last_name, is_archived, (password = '!') AS invite_pending
    FROM users
    WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT'
  `,

  //  $1 = user_id, $2 = school_year_id
  selectLinkForUserYear: `
    SELECT student_id FROM student_account_links WHERE user_id = $1 AND school_year_id = $2
  `,

  //  $1 = student_id
  deleteLinkByStudent: `
    DELETE FROM student_account_links WHERE student_id = $1 RETURNING user_id
  `,

  //  Cascades to student_accounts, every year's link and any open tokens.
  //  $1 = user_id, $2 = school
  deleteStudentUser: `
    DELETE FROM users WHERE user_id = $1 AND school = $2 AND role::text = 'STUDENT'
  `,

  //  The linked login of a student row, for the student form's email guard.
  //  $1 = student_id
  selectLinkedAccountEmail: `
    SELECT u.user_id, u.email
    FROM student_account_links sal
    JOIN users u ON u.user_id = sal.user_id
    WHERE sal.student_id = $1
  `,
};

module.exports = studentAccountQueries;
