/*
  controllers/adminUser.controller.js
  Admin Users page: list, inspect, invite, edit and remove the accounts in the
  admin's own school. The school always comes from the verified token, never
  from the request, so an admin cannot reach into another tenant.
*/

const db = require("../config/database");
const jwt = require("jsonwebtoken");
const logger = require("../logger");
const adminUserQueries = require("../queries/adminUser.queries");
const schoolYearQueries = require("../queries/schoolYear.queries");
const { getActiveTermForSchool, getSchoolYearContext } = require("../utils/sessionContext");
const { getInviteEmailHTML } = require("../templates/emailTemplate");
const { Resend } = require("resend");
const { toUser } = require("../utils/userMapper");
const { sendOrThrow } = require("../utils/emailUtils");
const resend = new Resend(process.env.RESEND_API_KEY);

const ROLES = ["ADMIN", "TEACHER", "PARENT"];
// Roles an admin may preview. Previewing another admin shows the same UI the
// admin already has, so it is not offered.
const IMPERSONATABLE_ROLES = ["TEACHER", "PARENT"];
// Preview sessions are short: long enough to click through every page, short
// enough that a forgotten tab does not stay signed in as someone else.
const IMPERSONATION_TTL = "2h";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


const toBlockers = (row) => ({
  classes: row?.classes ?? [],
  homeroomStudents: row?.homeroom_students ?? 0,
});

// Archive blockers are always judged against the school's *active* year, not
// the year the admin happens to have selected in the year switcher
// (req.schoolYear follows the X-School-Year header).
const loadArchiveBlockers = async (userId, role, school) => {
  if (role === "PARENT") return toBlockers(null);
  const { rows: years } = await db.query(schoolYearQueries.selectActiveYearBySchool, [school]);
  if (years.length === 0) return toBlockers(null);
  const { rows } = await db.query(adminUserQueries.selectArchiveBlockers, [userId, years[0].school_year_id]);
  return toBlockers(rows[0]);
};

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

  // Throws when Resend rejects the email, so inviteUser/resendInvite report it.
  await sendOrThrow(resend, {
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

    const [classes, homeroom, staff, children, blockers] = await Promise.all([
      schoolYearId && user.role !== "PARENT"
        ? db.query(adminUserQueries.selectClassesForUser, [id, schoolYearId])
        : { rows: [] },
      schoolYearId && user.role !== "PARENT"
        ? db.query(adminUserQueries.selectHomeroomForUser, [id, schoolYearId])
        : { rows: [] },
      db.query(adminUserQueries.selectStaffByEmail, [user.email, school]),
      // Every role: a teacher or admin linked to a student is also a parent.
      db.query(adminUserQueries.selectChildrenForParent, [id, school]),
      loadArchiveBlockers(id, user.role, school),
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
        archiveBlockers: blockers,
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

// PATCH /api/admin/users/:id  { firstName, lastName, role, isVerifiedSchool, staffTitle? }
const MAX_STAFF_TITLE = 60;
const updateUser = async (req, res) => {
  const { id } = req.params;
  const { school, userId: selfId } = req.user;
  const firstName = req.body?.firstName?.trim();
  const lastName = req.body?.lastName?.trim();
  const { role, isVerifiedSchool } = req.body ?? {};
  const rawTitle = req.body?.staffTitle;
  const staffTitle = typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : null;

  if (!firstName || !lastName || !role || typeof isVerifiedSchool !== "boolean") {
    return res.status(400).json({ status: "failed", message: "First name, last name, role and access are required" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ status: "failed", message: "Invalid role" });
  }
  if (rawTitle != null && typeof rawTitle !== "string") {
    return res.status(400).json({ status: "failed", message: "Invalid title" });
  }
  if (staffTitle && staffTitle.length > MAX_STAFF_TITLE) {
    return res.status(400).json({ status: "failed", message: `Title must be ${MAX_STAFF_TITLE} characters or fewer` });
  }
  if (id === selfId && (role !== "ADMIN" || !isVerifiedSchool)) {
    return res.status(400).json({ status: "failed", message: "You can't remove your own admin role or access" });
  }

  try {
    const { rows } = await db.query(adminUserQueries.updateUserInSchool, [
      firstName, lastName, role, isVerifiedSchool, id, school, staffTitle,
    ]);
    if (rows.length === 0) {
      // Either not ours, or archived (the update only touches active accounts).
      const existing = await db.query(adminUserQueries.selectUserInSchool, [id, school]);
      if (existing.rows[0]?.is_archived) {
        return res.status(409).json({ status: "failed", message: "This account is archived. Restore it before editing." });
      }
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    return res.status(200).json({ status: "success", message: "User updated", data: toUser(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, "Failed to update user");
    return res.status(500).json({ status: "failed", message: "Error updating user" });
  }
};

// POST /api/admin/users/:id/archive
// Keeps every record, hides them from staff lists and pickers, revokes access.
// Refused while they still lead a class or homeroom in the active school year,
// so nothing in the current year points at a hidden account.
const archiveUser = async (req, res) => {
  const { id } = req.params;
  const { school, userId: selfId } = req.user;

  if (id === selfId) {
    return res.status(400).json({ status: "failed", message: "You can't archive your own account" });
  }

  try {
    const { rows: existing } = await db.query(adminUserQueries.selectUserInSchool, [id, school]);
    if (existing.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    if (existing[0].is_archived) {
      return res.status(409).json({ status: "failed", message: "This account is already archived" });
    }

    const blockers = await loadArchiveBlockers(id, existing[0].role, school);
    if (blockers.classes.length > 0 || blockers.homeroomStudents > 0) {
      return res.status(409).json({
        status: "failed",
        message: "They still lead classes or homeroom students this year. Reassign those first.",
        data: { blockers },
      });
    }

    const [{ rows }] = await Promise.all([
      db.query(adminUserQueries.archiveUserInSchool, [id, school, selfId]),
      db.query(adminUserQueries.deleteTokensForUser, [id]),
    ]);
    if (rows.length === 0) {
      return res.status(409).json({ status: "failed", message: "This account is already archived" });
    }
    return res.status(200).json({ status: "success", message: "User archived", data: toUser(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, "Failed to archive user");
    return res.status(500).json({ status: "failed", message: "Error archiving user" });
  }
};

// POST /api/admin/users/:id/unarchive
const unarchiveUser = async (req, res) => {
  const { id } = req.params;
  const { school } = req.user;

  try {
    const { rows } = await db.query(adminUserQueries.unarchiveUserInSchool, [id, school]);
    if (rows.length === 0) {
      const existing = await db.query(adminUserQueries.selectUserInSchool, [id, school]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ status: "failed", message: "User not found" });
      }
      return res.status(409).json({ status: "failed", message: "This account isn't archived" });
    }
    return res.status(200).json({ status: "success", message: "User restored", data: toUser(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, "Failed to restore user");
    return res.status(500).json({ status: "failed", message: "Error restoring user" });
  }
};

// DELETE /api/admin/users/:id
const deleteUser = async (req, res) => {
  const { id } = req.params;

  if (id === req.user.userId) {
    return res.status(400).json({ status: "failed", message: "You can't delete your own account from here" });
  }

  try {
    // Never let a delete cascade through a teacher's classes.
    const { rows: lead } = await db.query(adminUserQueries.countLeadClasses, [id]);
    if (lead[0].count > 0) {
      return res.status(409).json({
        status: "failed",
        message: "This user still leads classes. Reassign those first, or archive them instead.",
      });
    }

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

// POST /api/admin/users/:id/impersonate
// "View as": issues a short-lived, read-only token for a teacher or parent in
// the admin's school so the admin can see exactly what that user sees. The
// token is the target's normal session payload plus `impersonator`, which
// verifyUser uses to refuse every non-GET request and /auth/me echoes back so
// the preview banner survives a reload. The response mirrors /auth/login so
// the frontend can hydrate its stores the same way.
const impersonateUser = async (req, res) => {
  const { id } = req.params;
  const admin = req.user;

  // A preview token can't reach here: verifyUser refuses every non-GET
  // request that carries one, and requireAdmin rejects its TEACHER/PARENT role.
  if (id === admin.userId) {
    return res.status(400).json({ status: "failed", message: "You're already signed in as yourself" });
  }

  try {
    const { rows } = await db.query(adminUserQueries.selectUserInSchool, [id, admin.school]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    const user = rows[0];

    if (!IMPERSONATABLE_ROLES.includes(user.role)) {
      return res.status(400).json({ status: "failed", message: "Only teachers and parents can be previewed" });
    }
    if (user.is_archived) {
      return res.status(409).json({ status: "failed", message: "Archived users can't be previewed. Restore them first." });
    }
    if (!user.is_verified || !user.is_verified_school) {
      return res.status(409).json({
        status: "failed",
        message: "This account can't sign in yet, so there is nothing to preview. Give it school access first.",
      });
    }

    const [{ rows: adminRows }, activeTerm, yearContext] = await Promise.all([
      db.query(adminUserQueries.selectUserInSchool, [admin.userId, admin.school]),
      getActiveTermForSchool(user.school),
      getSchoolYearContext(user.school),
    ]);
    const target = toUser(user);
    const adminRow = adminRows[0];
    const impersonator = {
      userId: admin.userId,
      username: adminRow?.username ?? admin.username,
      fullName: adminRow ? toUser(adminRow).fullName : admin.username,
    };

    const token = jwt.sign(
      {
        userId: user.user_id,
        username: user.username,
        email: user.email,
        school: user.school,
        role: user.role,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        activeTerm: activeTerm ? activeTerm.name : false,
        impersonator,
      },
      process.env.JWT_SECRET,
      { expiresIn: IMPERSONATION_TTL }
    );

    logger.info(
      { adminUserId: admin.userId, targetUserId: user.user_id, targetRole: user.role, school: admin.school },
      "Admin started a view-as preview"
    );

    return res.status(200).json({
      status: "success",
      message: `Previewing as ${target.fullName}`,
      data: {
        userId: target.userId,
        username: target.username,
        fullName: target.fullName,
        email: target.email,
        school: target.school,
        role: target.role,
        isVerified: target.isVerified,
        isVerifiedSchool: target.isVerifiedSchool,
        activeTerm: activeTerm ? activeTerm.name : false,
        activeSchoolYear: yearContext.activeSchoolYear,
        schoolYears: yearContext.schoolYears,
        impersonator,
        token,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to start view-as preview");
    return res.status(500).json({ status: "failed", message: "Error starting preview" });
  }
};

module.exports = {
  listUsers,
  getUserDetails,
  inviteUser,
  resendInvite,
  updateUser,
  archiveUser,
  unarchiveUser,
  deleteUser,
  impersonateUser,
};
