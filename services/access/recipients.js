// services/access/recipients.js
//
// Who gets an email meant for "the school's admins" (RBAC D12): everyone who
// holds the permission that covers that area, so the list always matches who
// can act on it. Sign-up and student-request notices go to `users` holders,
// QuickBooks sync alerts to `finance` holders.
//
// Full admins hold every key, so they are always included; a custom role is
// included when its permissions name the key; built-in teachers only when
// the teacher default has it. Archived, unverified and address-less accounts
// never receive anything.

const db = require('../../config/database');
const perms = require('../../config/permissions');

// $1 school, $2 key, $3 whether built-in teachers hold it
const SQL = `/* access:recipients */
  SELECT DISTINCT lower(trim(u.email)) AS email
    FROM users u
    LEFT JOIN staff_roles r ON r.role_id = u.staff_role_id AND r.school = u.school
   WHERE u.school = $1
     AND u.is_archived IS NOT TRUE
     AND u.is_verified IS TRUE
     AND u.is_verified_school IS TRUE
     AND TRIM(COALESCE(u.email, '')) <> ''
     AND (
       (u.staff_role_id IS NULL AND u.role::text = 'ADMIN')
       OR (u.staff_role_id IS NULL AND u.role::text = 'TEACHER' AND $3::boolean)
       OR (u.staff_role_id IS NOT NULL AND u.role::text IN ('ADMIN', 'TEACHER') AND $2::text = ANY(r.permissions))
     )`;

/** -> string[] of addresses (deduped, lowercased). */
async function recipientEmails(school, key) {
  if (!perms.isKnownPermission(key)) throw new Error(`Unknown permission key: ${key}`);
  const { rows } = await db.query(SQL, [school, key, perms.TEACHER_DEFAULT.includes(key)]);
  return rows.map((r) => r.email).filter(Boolean);
}

module.exports = { recipientEmails, SQL };
