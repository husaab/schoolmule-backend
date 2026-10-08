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
  isVerified: row.is_verified,
  isVerifiedSchool: row.is_verified_school,
  isArchived: row.is_archived,
  archivedAt: row.archived_at,
  declinedAt: row.declined_at ?? null,
  invitePending: row.invite_pending,
  createdAt: row.created_at,
  lastModifiedAt: row.last_modified_at,
});

module.exports = { toUser };
