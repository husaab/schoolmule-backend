// src/queries/parent.queries.js
const parentQueries = {
  // GET /api/parents?school=X
  selectParentsBySchool: `
    SELECT
      user_id,
      first_name,
      last_name,
      email,
      school,
      created_at
    FROM users
    WHERE role = 'PARENT'
      AND school = $1
    ORDER BY last_name, first_name
  `,
  // GET /api/parents/:id
  selectParentById: `
    SELECT
      user_id,
      first_name,
      last_name,
      email,
      school,
      created_at
    FROM users
    WHERE role = 'PARENT'
      AND user_id = $1
  `,
};

module.exports = parentQueries;
