// Queries for the admin Approvals page (/api/admin/approvals). A signup is
// "pending" once the email is verified and until an admin approves it;
// declining archives the account and stamps declined_at. Every statement is
// pinned to a school so an admin only ever sees their own tenant.

const USER_COLUMNS = `
  user_id, email, username, first_name, last_name, school, role,
  is_verified, is_verified_school, is_archived, archived_at, declined_at,
  created_at, last_modified_at,
  (password = '!') AS invite_pending
`;

const adminApprovalQueries = {
  //  Pending signups plus declined ones, in one trip. The page splits them.
  //  Each row carries the active-year students whose family email matches the
  //  signup's email, so the queue shows "children on file" before review.
  //  $1 = school
  selectApprovalUsers: `
    SELECT ${USER_COLUMNS},
      COALESCE((
        SELECT json_agg(json_build_object('studentId', s.student_id, 'name', s.name, 'grade', s.grade)
                        ORDER BY s.grade, s.name)
        FROM students s
        WHERE s.school = users.school
          AND s.is_archived = false
          AND s.school_year_id = (SELECT school_year_id FROM school_years WHERE school = $1 AND is_active LIMIT 1)
          AND (lower(s.mother_email) = lower(users.email) OR lower(s.father_email) = lower(users.email))
      ), '[]'::json) AS matched_children
    FROM users
    WHERE school = $1
      AND is_verified = true
      AND is_verified_school = false
      AND (is_archived = false OR declined_at IS NOT NULL)
    ORDER BY is_archived, created_at DESC
  `,

  //  Locks the row for the rest of the transaction so two admins can't both
  //  approve (or approve and decline) the same signup.
  //  $1 = user_id, $2 = school
  selectUserForUpdate: `
    SELECT ${USER_COLUMNS}
    FROM users
    WHERE user_id = $1 AND school = $2
    FOR UPDATE
  `,

  //  $1 = user_id, $2 = school
  selectUserInSchool: `
    SELECT ${USER_COLUMNS}
    FROM users
    WHERE user_id = $1 AND school = $2
  `,

  //  Approve: fix the role the person picked at signup (if the admin changed
  //  it) and grant school access in the same statement.
  //  $1 = role, $2 = user_id, $3 = school
  approveUser: `
    UPDATE users
    SET role = $1,
        is_verified_school = true,
        declined_at = NULL,
        last_modified_at = NOW()
    WHERE user_id = $2 AND school = $3
      AND is_verified = true AND is_verified_school = false AND is_archived = false
    RETURNING ${USER_COLUMNS}
  `,

  //  Change the role of a signup while it is still pending.
  //  $1 = role, $2 = user_id, $3 = school
  updatePendingRole: `
    UPDATE users
    SET role = $1,
        last_modified_at = NOW()
    WHERE user_id = $2 AND school = $3
      AND is_verified = true AND is_verified_school = false AND is_archived = false
    RETURNING ${USER_COLUMNS}
  `,

  //  Fix the name on a pending signup. Parents sometimes register under their
  //  child's name; username is what greets them, so it tracks the full name.
  //  $1 = first_name, $2 = last_name, $3 = user_id, $4 = school
  updatePendingName: `
    UPDATE users
    SET first_name = $1::text,
        last_name = $2::text,
        username = trim($1::text || ' ' || $2::text),
        last_modified_at = NOW()
    WHERE user_id = $3 AND school = $4
      AND is_verified = true AND is_verified_school = false AND is_archived = false
    RETURNING ${USER_COLUMNS}
  `,

  //  Decline: archive the account (can't sign in, hidden from pending) and
  //  stamp declined_at so it shows under "Declined" rather than with staff who
  //  were archived from the Users page.
  //  $1 = user_id, $2 = school, $3 = admin user_id
  declineUser: `
    UPDATE users
    SET is_archived = true,
        archived_at = NOW(),
        archived_by = $3,
        declined_at = NOW(),
        is_verified_school = false,
        last_modified_at = NOW()
    WHERE user_id = $1 AND school = $2
      AND is_verified = true AND is_verified_school = false AND is_archived = false
    RETURNING ${USER_COLUMNS}
  `,

  //  Restore a declined signup to the pending queue. Deliberately leaves
  //  is_verified_school false: restoring is "take another look", not approve.
  //  $1 = user_id, $2 = school
  restoreDeclined: `
    UPDATE users
    SET is_archived = false,
        archived_at = NULL,
        archived_by = NULL,
        declined_at = NULL,
        last_modified_at = NOW()
    WHERE user_id = $1 AND school = $2
      AND is_archived = true AND declined_at IS NOT NULL
    RETURNING ${USER_COLUMNS}
  `,

  //  Students in the active school year, with the contact emails the family
  //  gave at registration so approvalActions can suggest a parent's children.
  //  $1 = school, $2 = school_year_id
  selectActiveYearStudents: `
    SELECT student_id, name, grade, mother_email, father_email
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = false
    ORDER BY grade, name
  `,

  //  Which of the submitted students really belong to this school and year.
  //  $1 = school, $2 = school_year_id, $3 = uuid[]
  selectStudentsByIds: `
    SELECT student_id, name
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = false
      AND student_id = ANY($3::uuid[])
  `,

  //  $1 = parent user_id
  selectLinkedStudentIds: `
    SELECT student_id FROM parent_students WHERE parent_id = $1
  `,

  //  A contact row the school typed in by hand for this email (no account
  //  yet) gets claimed by the new account instead of duplicated.
  //  $1 = parent user_id, $2 = relation, $3 = student_id, $4 = email
  claimManualLink: `
    UPDATE parent_students
    SET parent_id = $1,
        relation = COALESCE(relation, $2)
    WHERE student_id = $3 AND parent_id IS NULL AND lower(parent_email) = lower($4)
    RETURNING parent_student_link_id
  `,

  //  $1 = student_id, $2 = parent user_id, $3 = parent_name, $4 = parent_email,
  //  $5 = relation, $6 = school
  insertLink: `
    INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING parent_student_link_id
  `,
};

module.exports = adminApprovalQueries;
