// Queries for the admin Users page (/api/admin/users). Every statement is
// pinned to a school so an admin can only ever see or touch their own tenant.

const adminUserQueries = {
  //  $1 = school
  selectUsersBySchool: `
    SELECT
      user_id, email, username, first_name, last_name, school, role,
      is_verified, is_verified_school, created_at, last_modified_at,
      (password = '!') AS invite_pending
    FROM users
    WHERE school = $1
    ORDER BY lower(last_name), lower(first_name)
  `,

  //  $1 = user_id, $2 = school
  selectUserInSchool: `
    SELECT
      user_id, email, username, first_name, last_name, school, role,
      is_verified, is_verified_school, created_at, last_modified_at,
      (password = '!') AS invite_pending
    FROM users
    WHERE user_id = $1 AND school = $2
  `,

  //  Classes a user teaches in a school year, as lead or additional teacher.
  //  $1 = user_id, $2 = school_year_id
  selectClassesForUser: `
    SELECT c.class_id, c.grade, c.subject, c.term_name,
           (c.teacher_id = $1) AS is_lead
    FROM classes c
    WHERE c.school_year_id = $2
      AND (c.teacher_id = $1
           OR EXISTS (SELECT 1 FROM class_teachers ct
                      WHERE ct.class_id = c.class_id AND ct.teacher_id = $1))
    ORDER BY c.grade, c.subject
  `,

  //  Homeroom groups: grades where the user is the homeroom teacher.
  //  $1 = user_id, $2 = school_year_id
  selectHomeroomForUser: `
    SELECT grade, COUNT(*)::int AS student_count
    FROM students
    WHERE homeroom_teacher_id = $1
      AND school_year_id = $2
      AND is_archived = false
    GROUP BY grade
    ORDER BY grade
  `,

  //  Staff directory entry matched on email (the two tables are not linked).
  //  $1 = email, $2 = school
  selectStaffByEmail: `
    SELECT staff_id, full_name, staff_role, teaching_assignments, homeroom_grade,
           email, phone, preferred_contact, phone_contact_hours, email_contact_hours
    FROM staff
    WHERE lower(email) = lower($1) AND school = $2
    LIMIT 1
  `,

  //  $1 = parent user_id, $2 = school
  selectChildrenForParent: `
    SELECT s.student_id, s.name, s.grade, ps.relation
    FROM parent_students ps
    JOIN students s ON s.student_id = ps.student_id
    WHERE ps.parent_id = $1 AND ps.school = $2
      AND s.is_archived = false
    ORDER BY s.name
  `,

  //  Invited accounts get the unusable password '!' (bcrypt never matches it)
  //  until they set one through the invite link.
  //  $1 = email, $2 = username, $3 = first_name, $4 = last_name, $5 = school, $6 = role
  insertInvitedUser: `
    INSERT INTO users
      (user_id, email, username, password, first_name, last_name, school, role,
       is_verified, is_verified_school, created_at, last_modified_at)
    VALUES
      (gen_random_uuid(), $1, $2, '!', $3, $4, $5, $6, true, true, NOW(), NOW())
    RETURNING user_id, email, username, first_name, last_name, school, role,
              is_verified, is_verified_school, created_at, last_modified_at,
              true AS invite_pending
  `,

  //  $1 = first_name, $2 = last_name, $3 = role, $4 = is_verified_school,
  //  $5 = user_id, $6 = school
  updateUserInSchool: `
    UPDATE users
    SET first_name = $1,
        last_name = $2,
        username = trim($1 || ' ' || $2),
        role = $3,
        is_verified_school = $4,
        last_modified_at = NOW()
    WHERE user_id = $5 AND school = $6
    RETURNING user_id, email, username, first_name, last_name, school, role,
              is_verified, is_verified_school, created_at, last_modified_at,
              (password = '!') AS invite_pending
  `,

  //  $1 = user_id, $2 = school
  deleteUserInSchool: `
    DELETE FROM users WHERE user_id = $1 AND school = $2
  `,

  //  $1 = school
  countAdminsInSchool: `
    SELECT COUNT(*)::int AS count FROM users WHERE school = $1 AND role = 'ADMIN'
  `,

  //  $1 = school
  selectSchoolName: `
    SELECT name FROM schools WHERE school_code = $1
  `,

  //  Invite links reuse password_reset_tokens with a longer lifetime.
  //  $1 = user_id
  createInviteToken: `
    INSERT INTO password_reset_tokens (user_id, expires_at)
    VALUES ($1, NOW() + interval '7 days')
    RETURNING token
  `,

  //  $1 = user_id
  deleteTokensForUser: `
    DELETE FROM password_reset_tokens WHERE user_id = $1
  `,
};

module.exports = adminUserQueries;
