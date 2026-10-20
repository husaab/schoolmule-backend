/*
  controllers/adminUser.controller.js
  Admin Users page: list, inspect, invite, edit and remove the accounts in the
  admin's own school. The school always comes from the verified token, never
  from the request, so an admin cannot reach into another tenant.

  RBAC: the routes need the `users` permission. Someone holding it who is not
  a full admin is held back by services/access/escalation.js: they can't touch
  a full admin, make anyone an admin, give or change access roles, or preview
  anyone but a student.
*/

const db = require("../config/database");
const jwt = require("jsonwebtoken");
const logger = require("../logger");
const adminUserQueries = require("../queries/adminUser.queries");
const schoolYearQueries = require("../queries/schoolYear.queries");
const { getActiveTermForSchool, getSchoolYearContext, getRolesForUser } = require("../utils/sessionContext");
const { getInviteEmailHTML } = require("../templates/emailTemplate");
const { toUser } = require("../utils/userMapper");
const { getResend, sendOrThrow } = require("../utils/emailUtils");
const { platformSender } = require("../services/email/senderIdentity");
const { assertStudentCanSignIn } = require("../services/classroom/studentLogin");
const escalation = require("../services/access/escalation");
const { sessionAccess } = require("../services/access/access");
const { invalidateUser } = require("../services/access/accessStore");
const staffRoleQueries = require("../queries/staffRole.queries");

const ROLES = ["ADMIN", "TEACHER", "PARENT"];
// Roles an admin may preview. A full admin is never previewed (it shows the
// same UI the admin already has); an admin on a restricted access role is, so
// a full admin can check what that role sees (escalation.checkImpersonate). A
// STUDENT preview keeps role STUDENT, so the student fence and the read-only
// rule both apply to it.
const IMPERSONATABLE_ROLES = ["ADMIN", "TEACHER", "PARENT", "STUDENT"];
// Why a student can't be previewed: the student sign-in gate's verdicts, in
// the admin's words. The preview would otherwise end at its first /auth/me.
const STUDENT_PREVIEW_REFUSALS = {
  NO_STUDENT_LINK: "This student account isn't linked to this school year.",
  CLASSROOM_DISABLED: "Student sign-in is turned off for your school, so there is nothing to preview yet. Turn it on in Classroom settings first.",
  CONSENT_REQUIRED: "This student has no parental consent on file, so the account can't sign in yet.",
  GRADE_NOT_ENABLED: "This student's grade doesn't use student sign-in yet.",
};
// The portals a preview can open in. A dual-role teacher (also a parent) may
// be previewed in either; the view is one the target actually holds.
const PREVIEW_VIEWS = ["ADMIN", "TEACHER", "PARENT"];
// Preview sessions are short: long enough to click through every page, short
// enough that a forgotten tab does not stay signed in as someone else.
const IMPERSONATION_TTL = "2h";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Student logins are managed on Admin Panel → Student accounts. To the Users
// page routes they do not exist: every :id that is a STUDENT answers 404, so
// a student can never be re-roled into staff or archived from here.
const isStudentLogin = (user) => String(user?.role ?? "") === "STUDENT";

const refuse = (res, verdict) => res.status(verdict.status).json({ status: "failed", message: verdict.message });

// The access role an invite or edit asks for. undefined = not sent (keep);
// null = built-in. -> { error } | { provided, id }
const STAFF_ROLES = ["ADMIN", "TEACHER"];
const readAccessRole = async (body, role, school) => {
  const provided = Object.prototype.hasOwnProperty.call(body ?? {}, "accessRoleId");
  if (!provided) return { provided: false, id: undefined };
  const id = body.accessRoleId || null;
  if (id === null) return { provided: true, id: null };
  if (typeof id !== "string" || !STAFF_ROLES.includes(role)) {
    return { error: "Only admins and teachers can have an access role" };
  }
  const { rows } = await db.query(staffRoleQueries.byId, [id, school]).catch(() => ({ rows: [] }));
  if (rows.length === 0) return { error: "Unknown access role" };
  return { provided: true, id, name: rows[0].name };
};

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
  await sendOrThrow(getResend(), {
    ...platformSender("verify"),
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
    if (rows.length === 0 || isStudentLogin(rows[0])) {
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

// POST /api/admin/users  { firstName, lastName, email, role, accessRoleId? }
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
  const verdict = escalation.checkInvite(req.access, { role, staffRoleId: req.body?.accessRoleId || null });
  if (!verdict.ok) return refuse(res, verdict);

  let created;
  try {
    const accessRole = await readAccessRole(req.body, role, req.user.school);
    if (accessRole.error) return res.status(400).json({ status: "failed", message: accessRole.error });
    const { rows } = await db.query(adminUserQueries.insertInvitedUser, [
      email, `${firstName} ${lastName}`, firstName, lastName, req.user.school, role, accessRole.id ?? null,
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
    if (rows.length === 0 || isStudentLogin(rows[0])) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    const verdict = escalation.checkTouch(req.access, rows[0]);
    if (!verdict.ok) return refuse(res, verdict);
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

// PATCH /api/admin/users/:id  { firstName, lastName, role, isVerifiedSchool, staffTitle?, accessRoleId? }
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
    const { rows: found } = await db.query(adminUserQueries.selectUserInSchool, [id, school]);
    const target = found[0];
    if (!target || isStudentLogin(target)) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    if (target.is_archived) {
      return res.status(409).json({ status: "failed", message: "This account is archived. Restore it before editing." });
    }

    const accessRole = await readAccessRole(req.body, role, school);
    if (accessRole.error) return res.status(400).json({ status: "failed", message: accessRole.error });
    const verdict = escalation.checkEdit(req.access, selfId, target, {
      role, staffRoleProvided: accessRole.provided, staffRoleId: accessRole.id,
    });
    if (!verdict.ok) return refuse(res, verdict);
    // A parent can't hold an access role; moving someone to PARENT drops it.
    const setRole = role === "PARENT" ? { provided: true, id: null } : accessRole;

    const { rows } = await db.query(adminUserQueries.updateUserInSchool, [
      firstName, lastName, role, isVerifiedSchool, id, school, role === "ADMIN" ? staffTitle : null,
      setRole.provided, setRole.id ?? null,
    ]);
    if (rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    invalidateUser(id);
    if ((rows[0].staff_role_id ?? null) !== (target.staff_role_id ?? null) || rows[0].role !== target.role) {
      logger.info(
        { actor: selfId, target: id, school, fromRole: target.role, toRole: rows[0].role, fromAccessRole: target.staff_role_id ?? null, toAccessRole: rows[0].staff_role_id ?? null },
        "User role or access role changed"
      );
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
    if (existing.length === 0 || isStudentLogin(existing[0])) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    const verdict = escalation.checkTouch(req.access, existing[0]);
    if (!verdict.ok) return refuse(res, verdict);
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
    invalidateUser(id);
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
    const { rows: existing } = await db.query(adminUserQueries.selectUserInSchool, [id, school]);
    if (existing.length === 0 || isStudentLogin(existing[0])) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    const verdict = escalation.checkTouch(req.access, existing[0]);
    if (!verdict.ok) return refuse(res, verdict);

    const { rows } = await db.query(adminUserQueries.unarchiveUserInSchool, [id, school]);
    if (rows.length === 0) {
      return res.status(409).json({ status: "failed", message: "This account isn't archived" });
    }
    invalidateUser(id);
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
    const { rows: existing } = await db.query(adminUserQueries.selectUserInSchool, [id, req.user.school]);
    if (existing.length === 0 || isStudentLogin(existing[0])) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }
    const verdict = escalation.checkTouch(req.access, existing[0]);
    if (!verdict.ok) return refuse(res, verdict);

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
    invalidateUser(id);
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

// POST /api/admin/users/:id/impersonate  { view? }
// "View as": issues a short-lived, read-only token for a teacher, parent,
// student or restricted admin in the admin's school (who may preview whom:
// escalation.checkImpersonate; `users` holders preview students only) so the admin can see exactly what that user sees. The
// token is the target's normal session payload plus `impersonator`, which
// verifyUser uses to refuse every non-GET request and /auth/me echoes back so
// the preview banner survives a reload. The response mirrors /auth/login so
// the frontend can hydrate its stores the same way.
//
// `view` picks the portal for a dual-role target (a teacher who is also a
// parent): PARENT opens their parent portal, otherwise the database role. The
// frontend calls this again with the other view (still as the admin) when the
// view switcher is used inside a running preview.
const impersonateUser = async (req, res) => {
  const { id } = req.params;
  const admin = req.user;
  const requestedView = req.body?.view;

  if (requestedView !== undefined && !PREVIEW_VIEWS.includes(requestedView)) {
    return res.status(400).json({ status: "failed", message: "Choose the teacher or the parent view to preview" });
  }

  // A preview token can't reach here: verifyUser refuses every non-GET
  // request that carries one.
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
      return res.status(400).json({ status: "failed", message: "Only teachers, parents and students can be previewed" });
    }
    const verdict = escalation.checkImpersonate(req.access, user);
    if (!verdict.ok) return refuse(res, verdict);
    if (user.is_archived) {
      return res.status(409).json({ status: "failed", message: "Archived users can't be previewed. Restore them first." });
    }
    if (!user.is_verified || !user.is_verified_school) {
      return res.status(409).json({
        status: "failed",
        message: "This account can't sign in yet, so there is nothing to preview. Give it school access first.",
      });
    }
    // A student needs a link to the active year (and the rest of the sign-in
    // gate) for the student portal to have anything to show.
    if (user.role === "STUDENT") {
      try {
        await assertStudentCanSignIn(user);
      } catch (v) {
        if (!v || !STUDENT_PREVIEW_REFUSALS[v.code]) throw v;
        return res.status(409).json({ status: "failed", code: v.code, message: STUDENT_PREVIEW_REFUSALS[v.code] });
      }
    }

    const [{ rows: adminRows }, activeTerm, yearContext] = await Promise.all([
      db.query(adminUserQueries.selectUserInSchool, [admin.userId, admin.school]),
      getActiveTermForSchool(user.school),
      getSchoolYearContext(user.school),
    ]);
    const roles = await getRolesForUser(user);
    const view = requestedView ?? user.role;
    if (!roles.includes(view)) {
      return res.status(400).json({
        status: "failed",
        message: view === "PARENT"
          ? "This account has no parent view: it isn't linked to a student this year"
          : "This account can't be previewed in that view",
      });
    }
    // The previewee's own access, so the preview shows exactly their pages.
    const access = await sessionAccess({ userId: user.user_id, school: user.school, baseRole: user.role }, view);

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
        role: view,
        baseRole: user.role,
        roles,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        activeTerm: activeTerm ? activeTerm.name : false,
        impersonator,
      },
      process.env.JWT_SECRET,
      { expiresIn: IMPERSONATION_TTL }
    );

    logger.info(
      { adminUserId: admin.userId, targetUserId: user.user_id, targetRole: user.role, view, school: admin.school },
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
        role: view,
        baseRole: user.role,
        roles,
        isVerified: target.isVerified,
        isVerifiedSchool: target.isVerifiedSchool,
        avatar: user.avatar ?? null,
        activeTerm: activeTerm ? activeTerm.name : false,
        activeSchoolYear: yearContext.activeSchoolYear,
        schoolYears: yearContext.schoolYears,
        ...access,
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
