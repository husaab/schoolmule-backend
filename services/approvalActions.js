// services/approvalActions.js
//
// The three things an admin can do with a signup: approve it (optionally
// fixing the role and linking a parent's children), decline it, or restore a
// declined one. Shared by the Approvals API and the legacy /api/auth routes so
// both paths change state the same way.
//
// Every action commits its database work first and only then sends email.
// A mail failure is reported as emailSent:false, never as a failed request:
// the approval already happened, and telling the admin otherwise just makes
// them click again.

const db = require("../config/database");
const logger = require("../logger");
const queries = require("../queries/adminApproval.queries");
const schoolYearQueries = require("../queries/schoolYear.queries");
const { getApprovalEmailHTML, getDeclineEmailHTML } = require("../templates/emailTemplate");
const { toUser } = require("../utils/userMapper");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

// Roles a signup can be approved as. ADMIN is granted only from the Users page.
const SIGNUP_ROLES = ["TEACHER", "PARENT"];
const RELATIONS = ["Mother", "Father", "Guardian", "Grandparent", "Other"];
const MAX_CHILDREN = 20;

class ApprovalError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

const sendSafely = async (payload, context) => {
  try {
    await resend.emails.send(payload);
    return true;
  } catch (error) {
    logger.error({ err: error, ...context }, "Approval email failed to send");
    return false;
  }
};

const withTransaction = async (work) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// Which state a users row is in, from the Approvals page's point of view.
const stateOf = (row) => {
  if (!row) return "missing";
  if (row.is_archived) return row.declined_at ? "declined" : "archived";
  if (!row.is_verified) return "unverified";
  return row.is_verified_school ? "approved" : "pending";
};

const expectState = (row, wanted, verb) => {
  const state = stateOf(row);
  if (state === "missing") throw new ApprovalError(404, "User not found");
  if (state !== wanted) {
    const why = {
      approved: "This account is already approved.",
      declined: "This signup was declined. Restore it first.",
      archived: "This account is archived. Restore it from the Users page.",
      unverified: "They haven't verified their email yet.",
      pending: "This signup is still pending.",
    }[state];
    throw new ApprovalError(409, `Can't ${verb}: ${why}`, { state });
  }
};

const activeYearId = async (client, school) => {
  const { rows } = await client.query(schoolYearQueries.selectActiveYearBySchool, [school]);
  return rows[0]?.school_year_id ?? null;
};

// Normalise the children list from the request: dedupe, validate relation.
const normaliseChildren = (children) => {
  if (!Array.isArray(children)) throw new ApprovalError(400, "children must be a list");
  if (children.length > MAX_CHILDREN) throw new ApprovalError(400, `Link at most ${MAX_CHILDREN} children at once`);
  const seen = new Map();
  for (const child of children) {
    const studentId = child?.studentId;
    if (typeof studentId !== "string" || !studentId) throw new ApprovalError(400, "Each child needs a studentId");
    const relation = child.relation && RELATIONS.includes(child.relation) ? child.relation : "Guardian";
    seen.set(studentId, relation);
  }
  return seen;
};

/**
 * Link a parent account to students inside an open transaction. Claims
 * hand-typed contact rows for the same email, skips students already linked,
 * inserts the rest. Returns the number of children now linked.
 */
const linkChildren = async (client, user, children) => {
  if (children.size === 0) return 0;

  const yearId = await activeYearId(client, user.school);
  if (!yearId) throw new ApprovalError(409, "Set an active school year before linking children");

  const ids = [...children.keys()];
  const { rows: valid } = await client.query(queries.selectStudentsByIds, [user.school, yearId, ids]);
  if (valid.length !== ids.length) {
    throw new ApprovalError(400, "One or more students aren't in this school's active year");
  }

  const { rows: existing } = await client.query(queries.selectLinkedStudentIds, [user.user_id]);
  const already = new Set(existing.map((r) => r.student_id));
  const parentName = `${user.first_name} ${user.last_name}`.trim();

  for (const [studentId, relation] of children) {
    if (already.has(studentId)) continue;
    const claimed = await client.query(queries.claimManualLink, [user.user_id, relation, studentId, user.email]);
    if (claimed.rowCount === 0) {
      await client.query(queries.insertLink, [studentId, user.user_id, parentName, user.email, relation, user.school]);
    }
  }
  return children.size;
};

/**
 * Approve a pending signup.
 * @param {object} opts
 * @param {string} opts.school    admin's school (from the token)
 * @param {string} opts.userId    signup to approve
 * @param {string} [opts.role]    TEACHER | PARENT; defaults to what they picked
 * @param {Array}  [opts.children] [{studentId, relation}] for parents
 * @param {boolean} [opts.sendEmail=true]
 */
const approveSignup = async ({ school, userId, role, children = [], sendEmail = true }) => {
  if (role !== undefined && !SIGNUP_ROLES.includes(role)) {
    throw new ApprovalError(400, "Role must be Teacher or Parent");
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(queries.selectUserForUpdate, [userId, school]);
    expectState(rows[0], "pending", "approve");

    const finalRole = role ?? rows[0].role;
    const wanted = normaliseChildren(children);
    if (wanted.size > 0 && finalRole !== "PARENT") {
      throw new ApprovalError(400, "Only parents can be linked to students");
    }

    const { rows: updated } = await client.query(queries.approveUser, [finalRole, userId, school]);
    const linkedCount = await linkChildren(client, updated[0], wanted);
    return { user: updated[0], linkedCount };
  });

  const emailSent = sendEmail
    ? await sendSafely(
        {
          from: "verify@schoolmule.ca",
          to: result.user.email,
          subject: "Your SchoolMule account is approved",
          html: getApprovalEmailHTML({
            name: result.user.first_name,
            role: result.user.role,
            school: result.user.school,
            childCount: result.linkedCount,
          }),
        },
        { userId, action: "approve" }
      )
    : false;

  return { user: toUser(result.user), linkedCount: result.linkedCount, emailSent };
};

/** Change the role of a signup that is still pending. */
const changePendingRole = async ({ school, userId, role }) => {
  if (!SIGNUP_ROLES.includes(role)) throw new ApprovalError(400, "Role must be Teacher or Parent");
  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(queries.selectUserForUpdate, [userId, school]);
    expectState(rows[0], "pending", "change the role");
    const { rows: updated } = await client.query(queries.updatePendingRole, [role, userId, school]);
    return updated[0];
  });
  return { user: toUser(user) };
};

const NAME_MAX = 60;

/** Correct the name on a pending signup (e.g. a parent who typed their child's name). */
const renamePendingSignup = async ({ school, userId, firstName, lastName }) => {
  const first = typeof firstName === "string" ? firstName.trim() : "";
  const last = typeof lastName === "string" ? lastName.trim() : "";
  if (!first) throw new ApprovalError(400, "First name is required");
  if (first.length > NAME_MAX || last.length > NAME_MAX) {
    throw new ApprovalError(400, `Names must be ${NAME_MAX} characters or fewer`);
  }
  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(queries.selectUserForUpdate, [userId, school]);
    expectState(rows[0], "pending", "rename");
    const { rows: updated } = await client.query(queries.updatePendingName, [first, last, userId, school]);
    return updated[0];
  });
  return { user: toUser(user) };
};

/** Decline a pending signup: archive it and, optionally, tell them. */
const declineSignup = async ({ school, userId, adminId, sendEmail = true }) => {
  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(queries.selectUserForUpdate, [userId, school]);
    expectState(rows[0], "pending", "decline");
    const { rows: updated } = await client.query(queries.declineUser, [userId, school, adminId]);
    return updated[0];
  });

  const emailSent = sendEmail
    ? await sendSafely(
        {
          from: "verify@schoolmule.ca",
          to: user.email,
          subject: "Your SchoolMule registration wasn't approved",
          html: getDeclineEmailHTML({ name: user.first_name, school: user.school }),
        },
        { userId, action: "decline" }
      )
    : false;

  return { user: toUser(user), emailSent };
};

/** Put a declined signup back in the pending queue. Grants nothing. */
const restoreSignup = async ({ school, userId }) => {
  const user = await withTransaction(async (client) => {
    const { rows } = await client.query(queries.selectUserForUpdate, [userId, school]);
    expectState(rows[0], "declined", "restore");
    const { rows: updated } = await client.query(queries.restoreDeclined, [userId, school]);
    return updated[0];
  });
  return { user: toUser(user) };
};

/**
 * Students an admin could link to a pending parent: every active-year
 * student, with the ones whose family email matches flagged as suggestions.
 */
const childCandidates = async ({ school, userId }) => {
  const { rows } = await db.query(queries.selectUserInSchool, [userId, school]);
  expectState(rows[0], "pending", "load students");
  const user = rows[0];

  const yearId = await activeYearId(db, school);
  if (!yearId) return { students: [], suggested: [] };

  const { rows: students } = await db.query(queries.selectActiveYearStudents, [school, yearId]);
  const email = (user.email || "").toLowerCase();
  const matches = (value) => Boolean(email) && Boolean(value) && value.toLowerCase() === email;

  const suggested = [];
  const all = students.map((s) => {
    const relation = matches(s.mother_email) ? "Mother" : matches(s.father_email) ? "Father" : null;
    const student = { studentId: s.student_id, name: s.name, grade: s.grade };
    if (relation) suggested.push({ ...student, relation });
    return student;
  });

  return { students: all, suggested };
};

module.exports = {
  ApprovalError,
  SIGNUP_ROLES,
  approveSignup,
  changePendingRole,
  renamePendingSignup,
  declineSignup,
  restoreSignup,
  childCandidates,
};
