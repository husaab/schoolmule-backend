/*
  controllers/staffRole.controller.js
  Admin Panel → People → Roles: a school's custom staff roles (RBAC). Full
  admins only (routes/staffRole.routes.js). A role is a name, a description
  and a set of permission keys from config/permissions.js; the built-in Admin
  and Teacher roles are listed alongside but never stored.
*/

const db = require("../config/database");
const logger = require("../logger");
const queries = require("../queries/staffRole.queries");
const perms = require("../config/permissions");
const { invalidateAll } = require("../services/access/accessStore");

const MAX_NAME = 60;
const MAX_DESCRIPTION = 300;

const toRole = (row) => ({
  roleId: row.role_id,
  name: row.name,
  description: row.description,
  permissions: (row.permissions || []).filter(perms.isKnownPermission),
  userCount: row.user_count ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Validates the fields present in body. partial=true (PATCH) allows any to be
 * missing. -> { error } or { name, description, permissions } (undefined = keep)
 */
const readRole = (body, { partial }) => {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { error: "A role needs a name" };
    if (name.length > MAX_NAME) return { error: `Role names are ${MAX_NAME} characters or fewer` };
    if (perms.RESERVED_ROLE_NAMES.has(name.toLowerCase())) return { error: `"${name}" is a built-in role. Pick another name.` };
    out.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") return { error: "Invalid description" };
    const description = body.description.trim();
    if (description.length > MAX_DESCRIPTION) return { error: `Descriptions are ${MAX_DESCRIPTION} characters or fewer` };
    out.description = description;
  } else if (!partial) {
    out.description = "";
  }
  if (body.permissions !== undefined || !partial) {
    const { valid, unknown, notArray } = perms.normalizePermissions(body.permissions);
    if (notArray) return { error: "Permissions must be a list" };
    if (unknown.length) return { error: "Unknown permission", unknown };
    out.permissions = valid;
  }
  return out;
};

const DUPLICATE = { status: "failed", message: "A role with this name already exists" };

// GET /api/admin/roles/catalog
const getCatalog = (req, res) => res.status(200).json({ status: "success", data: perms.catalogForApi() });

// GET /api/admin/roles
const listRoles = async (req, res) => {
  const { school } = req.user;
  try {
    const [{ rows }, { rows: counts }] = await Promise.all([
      db.query(queries.list, [school]),
      db.query(queries.builtInCounts, [school]),
    ]);
    const builtInCounts = { admin: counts[0]?.admins ?? 0, teacher: counts[0]?.teachers ?? 0 };
    return res.status(200).json({
      status: "success",
      data: {
        roles: rows.map(toRole),
        builtIns: perms.catalogForApi().builtIns.map((b) => ({ ...b, userCount: builtInCounts[b.id] })),
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to list staff roles");
    return res.status(500).json({ status: "failed", message: "Error loading roles" });
  }
};

// POST /api/admin/roles  { name, description?, permissions }
const createRole = async (req, res) => {
  const { school, userId } = req.user;
  const role = readRole(req.body ?? {}, { partial: false });
  if (role.error) return res.status(400).json({ status: "failed", message: role.error, unknown: role.unknown });

  try {
    const { rows } = await db.query(queries.insert, [school, role.name, role.description, role.permissions, userId]);
    invalidateAll();
    logger.info({ actor: userId, school, roleId: rows[0].role_id, permissions: role.permissions }, "Staff role created");
    return res.status(201).json({ status: "success", message: "Role created", data: toRole(rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json(DUPLICATE);
    logger.error({ err: error }, "Failed to create staff role");
    return res.status(500).json({ status: "failed", message: "Error creating role" });
  }
};

// PATCH /api/admin/roles/:id  { name?, description?, permissions? }
const updateRole = async (req, res) => {
  const { school, userId } = req.user;
  const role = readRole(req.body ?? {}, { partial: true });
  if (role.error) return res.status(400).json({ status: "failed", message: role.error, unknown: role.unknown });

  try {
    const { rows } = await db.query(queries.update, [
      req.params.id, school, role.name ?? null, role.description ?? null, role.permissions ?? null,
    ]);
    if (rows.length === 0) return res.status(404).json({ status: "failed", message: "Role not found" });
    // Holders get the new set on their next request (on this instance at once).
    invalidateAll();
    logger.info({ actor: userId, school, roleId: req.params.id, permissions: rows[0].permissions }, "Staff role updated");
    return res.status(200).json({ status: "success", message: "Role updated", data: toRole(rows[0]) });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json(DUPLICATE);
    logger.error({ err: error }, "Failed to update staff role");
    return res.status(500).json({ status: "failed", message: "Error updating role" });
  }
};

const inUse = (count) => ({
  status: "failed",
  code: "ROLE_IN_USE",
  userCount: count,
  message: count === 1
    ? "1 person has this role. Give them another role first."
    : `${count} people have this role. Give them another role first.`,
});

// DELETE /api/admin/roles/:id
// Refused while anyone (archived included) holds it: deleting a role must
// never quietly change someone's access. The FK (ON DELETE RESTRICT) backs this.
const deleteRole = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const { rows: [{ count }] } = await db.query(queries.countHolders, [req.params.id]);
    if (count > 0) return res.status(409).json(inUse(count));

    const { rowCount } = await db.query(queries.remove, [req.params.id, school]);
    if (rowCount === 0) return res.status(404).json({ status: "failed", message: "Role not found" });
    invalidateAll();
    logger.info({ actor: userId, school, roleId: req.params.id }, "Staff role deleted");
    return res.status(200).json({ status: "success", message: "Role deleted" });
  } catch (error) {
    if (error.code === "23503") {
      const { rows: [{ count }] } = await db.query(queries.countHolders, [req.params.id]);
      return res.status(409).json(inUse(count));
    }
    logger.error({ err: error }, "Failed to delete staff role");
    return res.status(500).json({ status: "failed", message: "Error deleting role" });
  }
};

// GET /api/admin/roles/:id/users
const listRoleUsers = async (req, res) => {
  const { school } = req.user;
  try {
    const { rows: found } = await db.query(queries.byId, [req.params.id, school]);
    if (found.length === 0) return res.status(404).json({ status: "failed", message: "Role not found" });
    const { rows } = await db.query(queries.holders, [req.params.id, school]);
    return res.status(200).json({
      status: "success",
      data: rows.map((r) => ({
        userId: r.user_id,
        fullName: `${r.first_name} ${r.last_name}`.trim(),
        email: r.email,
        role: r.role,
        isArchived: Boolean(r.is_archived),
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to list role holders");
    return res.status(500).json({ status: "failed", message: "Error loading role holders" });
  }
};

module.exports = { getCatalog, listRoles, createRole, updateRole, deleteRole, listRoleUsers };
