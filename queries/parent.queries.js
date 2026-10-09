// src/queries/parent.queries.js
//
// Accounts a student can be linked to. Any active account in the school
// qualifies: parents, and staff who are also parents (they get the parent
// view on their staff account). `role` lets the picker mark the staff ones.
const parentQueries = {
  // GET /api/parents?school=X
  selectParentsBySchool: `
    SELECT
      user_id,
      first_name,
      last_name,
      email,
      school,
      role,
      created_at
    FROM users
    WHERE school = $1
      AND is_archived = FALSE
    ORDER BY (role <> 'PARENT'), last_name, first_name
  `,
  // GET /api/parents/:id
  selectParentById: `
    SELECT
      user_id,
      first_name,
      last_name,
      email,
      school,
      role,
      created_at
    FROM users
    WHERE user_id = $1
  `,
};

module.exports = parentQueries;
