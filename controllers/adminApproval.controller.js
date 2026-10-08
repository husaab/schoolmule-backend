/*
  controllers/adminApproval.controller.js
  Approvals page: the queue of people who signed up for the admin's school and
  are waiting to be let in. The school always comes from the verified token.
  State changes live in services/approvalActions.js.
*/

const db = require("../config/database");
const logger = require("../logger");
const queries = require("../queries/adminApproval.queries");
const actions = require("../services/approvalActions");
const { toUser } = require("../utils/userMapper");

const fail = (res, error, fallback) => {
  if (error instanceof actions.ApprovalError) {
    return res.status(error.status).json({ status: "failed", message: error.message, data: error.data });
  }
  logger.error({ err: error }, fallback);
  return res.status(500).json({ status: "failed", message: fallback });
};

// GET /api/admin/approvals — pending and declined signups
const listApprovals = async (req, res) => {
  try {
    const { rows } = await db.query(queries.selectApprovalUsers, [req.user.school]);
    const data = rows.map((row) => ({ ...toUser(row), matchedChildren: row.matched_children ?? [] }));
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    return fail(res, error, "Error fetching approvals");
  }
};

// GET /api/admin/approvals/:id/children — students to link, with suggestions
const getChildCandidates = async (req, res) => {
  try {
    const data = await actions.childCandidates({ school: req.user.school, userId: req.params.id });
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    return fail(res, error, "Error loading students");
  }
};

// POST /api/admin/approvals/:id/approve  { role?, children?: [{studentId, relation}], sendEmail? }
const approve = async (req, res) => {
  const { role, children, sendEmail } = req.body ?? {};
  try {
    const data = await actions.approveSignup({
      school: req.user.school,
      userId: req.params.id,
      role,
      children: children ?? [],
      sendEmail: sendEmail !== false,
    });
    const message = data.emailSent
      ? "Approved and emailed"
      : sendEmail === false
        ? "Approved"
        : "Approved, but the email could not be sent";
    return res.status(200).json({ status: "success", message, data });
  } catch (error) {
    return fail(res, error, "Error approving user");
  }
};

// PATCH /api/admin/approvals/:id/role  { role }
const changeRole = async (req, res) => {
  try {
    const data = await actions.changePendingRole({
      school: req.user.school,
      userId: req.params.id,
      role: req.body?.role,
    });
    return res.status(200).json({ status: "success", message: "Role updated", data });
  } catch (error) {
    return fail(res, error, "Error updating role");
  }
};

// PATCH /api/admin/approvals/:id/name  { firstName, lastName }
const rename = async (req, res) => {
  try {
    const data = await actions.renamePendingSignup({
      school: req.user.school,
      userId: req.params.id,
      firstName: req.body?.firstName,
      lastName: req.body?.lastName,
    });
    return res.status(200).json({ status: "success", message: "Name updated", data });
  } catch (error) {
    return fail(res, error, "Error updating name");
  }
};

// POST /api/admin/approvals/:id/decline  { sendEmail? }
const decline = async (req, res) => {
  const sendEmail = req.body?.sendEmail !== false;
  try {
    const data = await actions.declineSignup({
      school: req.user.school,
      userId: req.params.id,
      adminId: req.user.userId,
      sendEmail,
    });
    const message = data.emailSent
      ? "Declined and emailed"
      : sendEmail
        ? "Declined, but the email could not be sent"
        : "Declined";
    return res.status(200).json({ status: "success", message, data });
  } catch (error) {
    return fail(res, error, "Error declining user");
  }
};

// POST /api/admin/approvals/:id/restore
const restore = async (req, res) => {
  try {
    const data = await actions.restoreSignup({ school: req.user.school, userId: req.params.id });
    return res.status(200).json({ status: "success", message: "Back in the pending queue", data });
  } catch (error) {
    return fail(res, error, "Error restoring user");
  }
};

module.exports = { listApprovals, getChildCandidates, approve, changeRole, rename, decline, restore };
