const userQueries = {
    createUser: `
     INSERT INTO users 
    (user_id, email, username, password, first_name, last_name, school, role, created_at, last_modified_at, email_token, is_verified, is_verified_school)
    VALUES 
      ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10, $11)
      RETURNING *
    `,
  
    loginUser: `
      SELECT user_id, email, username, password, first_name, last_name,
            school, role, email_token, is_verified, is_verified_school, 
            created_at, last_modified_at
      FROM users 
      WHERE email = $1
    `,

    selectById: `
      SELECT user_id, email, username, password, first_name, last_name, school, role, email_token, is_verified, created_at, last_modified_at
      FROM users 
      WHERE user_id = $1
    `,
      
    selectByEmail: `
      SELECT user_id, email, username, first_name, last_name, school, role, email_token, is_verified, created_at, last_modified_at
      FROM users
      WHERE email = $1
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

    verifyEmailToken: `
      UPDATE users 
      SET is_verified = true , email_token = null
      WHERE email_token = $1
      RETURNING user_id, email, username, is_verified, school
    `,

    approveUserSchool: `
      UPDATE users 
      SET is_verified_school = true,
          last_modified_at = NOW()
      WHERE user_id = $1
      RETURNING user_id, email, username, is_verified_school
    `,

    getPendingSchoolApprovals: `
      SELECT user_id, email, username, first_name, last_name, role, school, created_at
      FROM users
      WHERE is_verified = true AND is_verified_school = false AND school = $1
    `,

    resendSchoolApprovalEmail: `
      SELECT user_id, email, username, first_name
      FROM users
      WHERE user_id = $1 AND is_verified = true AND is_verified_school = false
    `,

    getAdminsBySchool: `
      SELECT email, first_name
      FROM users
      WHERE school = $1 AND role = 'ADMIN'
    `,

    declineUserFromSchool: `
      UPDATE users
      SET is_verified_school = false, last_modified_at = NOW()
      WHERE user_id = $1
    `
  };
  
module.exports = userQueries;
  