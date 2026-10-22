// utils/userMapper.js
// One camelCase shape for a users row, shared by the admin Users page and the
// Approvals page so a user looks the same wherever an admin meets them.

const toUser = (row) => ({
  userId: row.user_id,
  username: row.username,
  fullName: `${row.first_name} ${row.last_name}`.trim(),
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  school: row.school,
  role: row.role,
  /** Admins only: shown to parents as the role they can message (e.g. Principal). */
  staffTitle: row.staff_title ?? null,
  /** Staff only: Mr. | Ms. | Mrs. | Dr. before the name parents see ("Ms. Doha Chahade"); null = plain name. */
  honorific: row.honorific ?? null,
  isVerified: row.is_verified,
  isVerifiedSchool: row.is_verified_school,
  isArchived: row.is_archived,
  archivedAt: row.archived_at,
  declinedAt: row.declined_at ?? null,
  invitePending: row.invite_pending,
  /** RBAC access role (staff_roles); null = the built-in role for `role`. */
  accessRoleId: row.staff_role_id ?? null,
  accessRoleName: row.staff_role_name ?? null,
  /** An ADMIN on the built-in Admin role: only another full admin may change them. */
  isFullAdmin: row.role === 'ADMIN' && !row.staff_role_id,
  /** {style, skin, bg}; null = the neutral avatar (and for rows from queries that do not select it). */
  avatar: row.avatar ?? null,
  /** Signed photo URL, when the caller signed one (withPhotoUrls sets photo_url); never the stored path. */
  photoUrl: row.photo_url ?? null,
  createdAt: row.created_at,
  lastModifiedAt: row.last_modified_at,
});

module.exports = { toUser };
