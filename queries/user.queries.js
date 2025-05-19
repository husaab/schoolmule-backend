const userQueries = {
    createUser: `
      INSERT INTO users 
        (email, username, password, first_name, last_name, created_at, last_modified_at, email_token, is_verified)
      VALUES 
        ($1, $2, $3, $4, $5, NOW(), NOW(), $6, $7)
      RETURNING *
    `,
  
    loginUser: `
      SELECT id, email, username, password, first_name, last_name, email_token, is_verified
      FROM users 
      WHERE email = $1
    `,
  
    selectById: `
      SELECT id, email, username, password, created_at, last_modified_at, first_name, last_name, email_token, is_verified
      FROM users 
      WHERE id = $1
    `,
  
    selectByEmail: `
      SELECT id, email, username, password, created_at, last_modified_at, first_name, last_name, email_token, is_verified
      FROM users 
      WHERE email = $1
    `,
  
    selectAllUsers: `
      SELECT id, email, username, password, created_at, last_modified_at, first_name, last_name, email_token, is_verified
      FROM users
    `,
  
    updateUserById: `
      UPDATE users 
      SET email = $1,
          username = $2,
          first_name = $3,
          last_name = $4,
          last_modified_at = NOW()
      WHERE id = $5
      RETURNING *
    `,
  
    deleteUser: `
      DELETE FROM users 
      WHERE id = $1
    `,
  
    updatePassword: `
      UPDATE users 
      SET password = $1,
          last_modified_at = NOW()
      WHERE id = $2
      RETURNING *
    `,

    verifyEmailToken: `
      UPDATE users 
      SET is_verified = true , email_token = null
      WHERE email_token = $1
      RETURNING id, email, username, is_verified
    `,
  };
  
module.exports = userQueries;
  