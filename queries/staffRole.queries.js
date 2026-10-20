// queries/staffRole.queries.js
// Staff roles (RBAC): a school's named permission sets. Every statement is
// scoped by school; the school always comes from the verified token.

module.exports = {
  // $1 school
  list: `
    SELECT r.role_id, r.name, r.description, r.permissions, r.created_at, r.updated_at,
           (SELECT COUNT(*)::int FROM users u
             WHERE u.staff_role_id = r.role_id AND u.is_archived IS NOT TRUE) AS user_count
      FROM staff_roles r
     WHERE r.school = $1
     ORDER BY lower(r.name)
  `,

  // $1 school: how many active accounts sit on each built-in role.
  builtInCounts: `
    SELECT COUNT(*) FILTER (WHERE role::text = 'ADMIN' AND staff_role_id IS NULL)::int AS admins,
           COUNT(*) FILTER (WHERE role::text = 'TEACHER' AND staff_role_id IS NULL)::int AS teachers
      FROM users
     WHERE school = $1 AND is_archived IS NOT TRUE
  `,

  // $1 role_id, $2 school
  byId: `
    SELECT role_id, name, description, permissions, created_at, updated_at
      FROM staff_roles
     WHERE role_id = $1 AND school = $2
  `,

  // $1 school, $2 name, $3 description, $4 permissions, $5 created_by
  insert: `
    INSERT INTO staff_roles (school, name, description, permissions, created_by)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING role_id, name, description, permissions, created_at, updated_at, 0 AS user_count
  `,

  // $1 role_id, $2 school, $3 name|null, $4 description|null, $5 permissions|null
  // (null keeps the current value: a partial update)
  update: `
    UPDATE staff_roles
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           permissions = COALESCE($5, permissions),
           updated_at = NOW()
     WHERE role_id = $1 AND school = $2
    RETURNING role_id, name, description, permissions, created_at, updated_at,
              (SELECT COUNT(*)::int FROM users u
                WHERE u.staff_role_id = staff_roles.role_id AND u.is_archived IS NOT TRUE) AS user_count
  `,

  // $1 role_id. Archived holders count too: restoring one would bring the role back.
  countHolders: `SELECT COUNT(*)::int AS count FROM users WHERE staff_role_id = $1`,

  // $1 role_id, $2 school
  remove: `DELETE FROM staff_roles WHERE role_id = $1 AND school = $2`,

  // $1 role_id, $2 school
  holders: `
    SELECT user_id, first_name, last_name, email, role::text AS role, is_archived
      FROM users
     WHERE staff_role_id = $1 AND school = $2
     ORDER BY is_archived, lower(last_name), lower(first_name)
  `,
};
