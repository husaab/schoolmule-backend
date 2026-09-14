/*
  controllers/adminUser.controller.js
  Admin Users page: list, inspect, invite, edit and remove the accounts in the
  admin's own school. The school always comes from the verified token, never
  from the request, so an admin cannot reach into another tenant.
*/

const db = require("../config/database");
const logger = require("../logger");
const adminUserQueries = require("../queries/adminUser.queries");
const { getInviteEmailHTML } = require("../templates/emailTemplate");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

const ROLES = ["ADMIN", "TEACHER", "PARENT"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  invitePending: row.invite_pending,
  createdAt: row.created_at,
  lastModifiedAt: row.last_modified_at,
});

const sendInvite = async (user, invitedBy) => {
  const [{ rows: tokenRows }, { rows: schoolRows }] = await Promise.all([
    db.query(adminUserQueries.createInviteToken, [user.user_id]),
    db.query(adminUserQueries.selectSchoolName, [user.school]),
  ]);

  const url = `${process.env.FRONTEND_URL}/reset-password?token=${tokenRows[0].token}&invite=1`;
  const html = getInviteEmailHTML({
    name: user.first_name,
    schoolName: schoolRows[0]?.name || user.school,
    invitedBy,
    role: user.role,
    url,
  });

  await resend.emails.send({
    from: "verify@schoolmule.ca",
    to: user.email,
    subject: "You're invited to School Mule",
    html,
  });
};

// GET /api/admin/users
const listUsers = async (req, res) => {
  try {
    const { rows } = await db.query(adminUserQueries.selectUsersBySchool, [req.user.school]);
    return res.status(200).json({ status: "success", data: rows.map(toUser) });
  } catch (error) {
    logger.error({ err: error }, "Failed to list school users");
    return res.status(500).json({ status: "failed", message: "Error fetching users" });
  }
};

// GET /api/admin/users/:id
const getUserDetails = async (req, res) => {
  const { id } = req.params;
  const { school } = req.user;
  const schoolYearId = req.schoolYear?.schoolYearId ?? null;

  try {
    const { rows } = await db.query(adminUserQueries.selectUserInSchool, [id, school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    const user = rows[0];

    const [classes, homeroom, staff, children] = await Promise.all([
      schoolYearId && user.role !== "PARENT"
        ? db.query(adminUserQueries.selectClassesForUser, [id, schoolYearId])
        : { rows: [] },
      schoolYearId && user.role !== "PARENT"
        ? db.query(adminUserQueries.selectHomeroomForUser, [id, schoolYearId])
        : { rows: [] },
      db.query(adminUserQueries.selectStaffByEmail, [user.email, school]),
      user.role === "PARENT"
        ? db.query(adminUserQueries.selectChildrenForParent, [id, school])
        : { rows: [] },
    ]);

    const staffRow = staff.rows[0];

    return res.status(200).json({
      status: "success",
      data: {
        ...toUser(user),
        classes: classes.rows.map((c) => ({
          classId: c.class_id,
          grade: c.grade,
          subject: c.subject,
          termName: c.term_name,
          isLead: c.is_lead,
        })),
        homeroom: homeroom.rows.map((h) => ({ grade: h.grade, studentCount: h.student_count })),
        staffProfile: staffRow
          ? {
              staffId: staffRow.staff_id,
              fullName: staffRow.full_name,
              staffRole: staffRow.staff_role,
              teachingAssignments: staffRow.teaching_assignments,
              homeroomGrade: staffRow.homeroom_grade,
              phone: staffRow.phone,
              preferredContact: staffRow.preferred_contact,
              phoneContactHours: staffRow.phone_contact_hours,
              emailContactHours: staffRow.email_contact_hours,
            }
          : null,
        children: children.rows.map((c) => ({
          studentId: c.student_id,
          name: c.name,
          grade: c.grade,
          relation: c.relation,
        })),
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch user details");
    return res.status(500).json({ status: "failed", message: "Error fetching user" });
  }
};

// POST /api/admin/users  { firstName, lastName, email, role }
const inviteUser = async (req, res) => {
  const firstName = req.body?.firstName?.trim();
  const lastName = req.body?.lastName?.trim();
  const email = req.body?.email?.trim().toLowerCase();
  const role = req.body?.role;

  if (!firstName || !lastName || !email || !role) {
    return res.status(400).json({ status: "failed", message: "First name, last name, email and role are required" });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ status: "failed", message: "Enter a valid email address" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ status: "failed", message: "Invalid role" });
  }

  let created;
  try {
    const { rows } = await db.query(adminUserQueries.insertInvitedUser, [
      email, `${firstName} ${lastName}`, firstName, lastName, req.user.school, role,
    ]);
    created = rows[0];
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ status: "failed", message: "An account with this email already exists" });
    }
    logger.error({ err: error }, "Failed to create invited user");
    return res.status(500).json({ status: "failed", message: "Error creating user" });
  }

  // The account exists either way; a failed email is recoverable via "Resend invite".
  let inviteSent = true;
  try {
    await sendInvite(created, req.user.username);
  } catch (error) {
    inviteSent = false;
    logger.error({ err: error, userId: created.user_id }, "Failed to send invite email");
  }

  return res.status(201).json({
    status: "success",
    message: inviteSent
      ? "User created and invite sent"
      : "User created, but the invite email could not be sent. Try resending it.",
    data: { ...toUser(created), inviteSent },
  });
};

// POST /api/admin/users/:id/resend-invite
const resendInvite = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(adminUserQueries.selectUserInSchool, [id, req.user.school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    if (!rows[0].invite_pending) {
      return res.status(400).json({ status: "failed", message: "This user has already set a password" });
    }

    // Only the newest link should work.
    await db.query(adminUserQueries.deleteTokensForUser, [id]);
    await sendInvite(rows[0], req.user.username);

    return res.status(200).json({ status: "success", message: "Invite resent" });
  } catch (error) {
    logger.error({ err: error }, "Failed to resend invite");
    return res.status(500).json({ status: "failed", message: "Error resending invite" });
  }
};

// PATCH /api/admin/users/:id  { firstName, lastName, role, isVerifiedSchool }
const updateUser = async (req, res) => {
  const { id } = req.params;
  const { school, userId: selfId } = req.user;
  const firstName = req.body?.firstName?.trim();
  const lastName = req.body?.lastName?.trim();
  const { role, isVerifiedSchool } = req.body ?? {};

  if (!firstName || !lastName || !role || typeof isVerifiedSchool !== "boolean") {
    return res.status(400).json({ status: "failed", message: "First name, last name, role and access are required" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ status: "failed", message: "Invalid role" });
  }
  if (id === selfId && (role !== "ADMIN" || !isVerifiedSchool)) {
    return res.status(400).json({ status: "failed", message: "You can't remove your own admin role or access" });
  }

  try {
    const { rows } = await db.query(adminUserQueries.updateUserInSchool, [
      firstName, lastName, role, isVerifiedSchool, id, school,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    return res.status(200).json({ status: "success", message: "User updated", data: toUser(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, "Failed to update user");
    return res.status(500).json({ status: "failed", message: "Error updating user" });
  }
};

// DELETE /api/admin/users/:id
const deleteUser = async (req, res) => {
  const { id } = req.params;

  if (id === req.user.userId) {
    return res.status(400).json({ status: "failed", message: "You can't delete your own account from here" });
  }

  try {
    const result = await db.query(adminUserQueries.deleteUserInSchool, [id, req.user.school]);
    if (result.rowCount === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    return res.status(200).json({ status: "success", message: "User deleted" });
  } catch (error) {
    // Lead teacher on a class, homeroom teacher, etc. — records still point at them.
    if (error.code === "23503") {
      return res.status(409).json({
        status: "failed",
        message: "This user is still linked to classes or students. Reassign those first, or revoke their access instead.",
      });
    }
    logger.error({ err: error }, "Failed to delete user");
    return res.status(500).json({ status: "failed", message: "Error deleting user" });
  }
};

module.exports = {
  listUsers,
  getUserDetails,
  inviteUser,
  resendInvite,
  updateUser,
  deleteUser,
};
