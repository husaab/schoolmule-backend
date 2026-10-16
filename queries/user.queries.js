const userQueries = {
    createUser: `
     INSERT INTO users 
    (user_id, email, username, password, first_name, last_name, school, role, created_at, last_modified_at, email_token, is_verified, is_verified_school)
    VALUES 
      ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10, $11)
      RETURNING *
    `,
  
    // Every account whose address matches the typed one ignoring case
    // (students' addresses are stored lowercased; older staff and parent rows
    // keep the capitals they signed up with). users.email is unique only as
    // typed, so this can return a few rows: the caller picks the exact
    // spelling and refuses to guess between the others. $1 = the typed
    // address, trimmed.
    loginUser: `
      SELECT user_id, email, username, password, first_name, last_name,
            school, role, email_token, is_verified, is_verified_school, is_archived,
            created_at, last_modified_at
      FROM users 
      WHERE LOWER(email) = LOWER($1)
    `,

    touchLastLogin: `UPDATE users SET last_login_at = NOW() WHERE user_id = $1`,

    // Google sign-in candidates: the account already linked to this Google
    // account, plus every account whose email matches ignoring case (signup
    // never normalised addresses, so 'Jo@x.com' and 'jo@x.com' can coexist).
    selectForGoogleSignIn: `
      SELECT user_id, email, username, password, first_name, last_name,
            school, role, email_token, is_verified, is_verified_school, is_archived,
            google_sub, created_at, last_modified_at
      FROM users
      WHERE google_sub = $1 OR lower(email) = lower($2)
    `,

    // First Google sign-in on an existing account. Google has verified the
    // address, which is what email verification proves. $3 is an unusable
    // password hash when the stored password can't be trusted (the invite
    // sentinel '!', or one set before the email was verified); otherwise null.
    linkGoogleAccount: `
      UPDATE users
      SET google_sub = $2,
          is_verified = true,
          password = COALESCE($3, password),
          last_modified_at = NOW()
      WHERE user_id = $1
      RETURNING user_id, email, username, password, first_name, last_name,
            school, role, email_token, is_verified, is_verified_school, is_archived,
            google_sub, created_at, last_modified_at
    `,

    // Signup with Google: email already verified by Google, school approval
    // still pending, no email_token because there is no link to click.
    createGoogleUser: `
      INSERT INTO users
        (user_id, email, username, password, first_name, last_name, school, role,
         google_sub, is_verified, is_verified_school, created_at, last_modified_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, false, NOW(), NOW())
      RETURNING *
    `,

    selectById: `
      SELECT user_id, email, username, password, first_name, last_name, school, role, email_token, is_verified, is_verified_school, is_archived, created_at, last_modified_at
      FROM users 
      WHERE user_id = $1
    `,
      
    selectByEmail: `
      SELECT user_id, email, username, first_name, last_name, school, role, email_token, is_verified, created_at, last_modified_at
      FROM users
      WHERE email = $1
    `,

    // "Forgot password": the same case-insensitive match as loginUser.
    // $1 = the typed address, trimmed.
    selectByEmailIgnoringCase: `
      SELECT user_id, email, username, first_name, last_name, school, role, email_token, is_verified, created_at, last_modified_at
      FROM users
      WHERE LOWER(email) = LOWER($1)
    `,
  
    selectAllUsers: `
      SELECT user_id, email, username, first_name, last_name, school, role, email_token, is_verified, created_at, last_modified_at
      FROM users
    `,
  
    updateUserById: `
      UPDATE users 
      SET email = $1,
          username = $2,
          first_name = $3,
          last_name = $4,
          school = $5,
          role = $6,
          last_modified_at = NOW()
      WHERE user_id = $7
      RETURNING *
    `,
  
    countLeadClasses: `
      SELECT COUNT(*)::int AS count FROM classes WHERE teacher_id = $1
    `,

    deleteUser: `
      DELETE FROM users 
      WHERE user_id = $1
    `,
  
    updatePassword: `
      UPDATE users 
      SET password = $1,
          last_modified_at = NOW()
      WHERE user_id = $2
      RETURNING *
    `,

    // The token is kept after use so a second click (or a mail scanner's
    // prefetch) finds the account already verified instead of an unknown
    // token. Guarded on is_verified = false so only one request wins.
    verifyEmailToken: `
      UPDATE users 
      SET is_verified = true
      WHERE email_token = $1 AND is_verified = false
      RETURNING user_id, email, username, is_verified, school
    `,

    selectByEmailToken: `
      SELECT user_id, email, username, is_verified, school
      FROM users
      WHERE email_token = $1
    `,

    // Admins skip both checks at login; persist that so /me and the JWT agree.
    markAdminVerified: `
      UPDATE users
      SET is_verified = true, is_verified_school = true, last_modified_at = NOW()
      WHERE user_id = $1 AND role = 'ADMIN'
        AND (is_verified = false OR is_verified_school = false)
    `,

    getPendingSchoolApprovals: `
      SELECT user_id, email, username, first_name, last_name, role, school, created_at
      FROM users
      WHERE is_verified = true AND is_verified_school = false AND is_archived = false AND school = $1
    `,

    resendSchoolApprovalEmail: `
      SELECT user_id, email, username, first_name
      FROM users
      WHERE user_id = $1 AND school = $2 AND is_verified = true AND is_verified_school = false
    `,

    getAdminsBySchool: `
      SELECT email, first_name
      FROM users
      WHERE school = $1 AND role = 'ADMIN'
    `,

      selectUsersBySchool: `
        SELECT
          user_id, email, username, first_name, last_name,
          school, role, email_token, is_verified, created_at, last_modified_at
        FROM users
        WHERE school = $1
          AND is_archived = false
        ORDER BY last_name, first_name
      `,

      selectParentsBySchool: `
        SELECT user_id, first_name, last_name, email
          FROM users
        WHERE school = $1
          AND role   = 'PARENT'
      `
  };
  
module.exports = userQueries;
  