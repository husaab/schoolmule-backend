const db = require("../config/database");
const bcrypt = require("bcrypt");
const userQueries = require("../queries/user.queries");
const logger = require("../logger");

// email_token is a secret (it verifies the account) and is never sent out.
const toUser = (user) => ({
  userId: user.user_id,
  username: user.username,
  fullName: `${user.first_name} ${user.last_name}`,
  firstName: user.first_name,
  lastName: user.last_name,
  email: user.email,
  school: user.school,
  role: user.role,
  createdAt: user.created_at,
  lastModifiedAt: user.last_modified_at,
  isVerified: user.is_verified,
});

const isAdmin = (req) => req.user?.role === "ADMIN";

// A user may act on their own record; an admin may act on anyone in their school.
const canAccess = (req, target) =>
  target.user_id === req.user?.userId || (isAdmin(req) && target.school === req.user?.school);

const forbidden = (res) =>
  res.status(403).json({ status: "failed", message: "You don't have access to this user" });

const getAllUser = async (req, res) => {
  if (!isAdmin(req)) return forbidden(res);

  try {
    const { rows } = await db.query(userQueries.selectUsersBySchool, [req.user.school]);

    logger.info("All users fetched successfully");
    return res.status(200).json({ status: "success", data: rows.map(toUser) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching users" });
  }
};

const getUsersBySchool = async (req, res) => {
  const { school } = req.params;
  if (!isAdmin(req) || school !== req.user.school) return forbidden(res);

  try {
    const { rows } = await db.query(userQueries.selectUsersBySchool, [school]);
    return res.status(200).json({ status: "success", data: rows.map(toUser) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching users by school" });
  }
};

const getUserByEmail = async (req, res) => {
  const { email } = req.params;
  if (!email) {
    return res.status(400).json({ status: "failed", message: "Email is required" });
  }

  try {
    const result = await db.query(userQueries.selectByEmail, [email]);
    const user = result.rows[0];

    // Out-of-scope users read as missing so the endpoint can't probe for emails.
    if (!user || !canAccess(req, user)) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }

    return res.status(200).json({ status: "success", data: toUser(user) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Internal Server Error" });
  }
};

const getUser = async (req, res) => {
  const id = req.params.id;
  try {
    const result = await db.query(userQueries.selectById, [id]);
    const user = result.rows[0];

    if (!user || !canAccess(req, user)) {
      return res.status(404).json({ status: "failed", message: `User with id ${id} not found` });
    }

    return res.status(200).json({ status: "success", data: toUser(user) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching user" });
  }
};

const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(userQueries.selectById, [id]);
    const target = rows[0];

    if (!target) {
      return res.status(404).json({ status: "failed", message: "User not found or already deleted" });
    }
    if (!isAdmin(req) || target.school !== req.user.school) return forbidden(res);

    await db.query(userQueries.deleteUser, [id]);

    logger.info({ status: "success", message: "User deleted" });
    return res.status(200).json({ status: "success", message: "User deleted successfully" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting user" });
  }
};

const updateUser = async (req, res) => {
  const { id } = req.params;
  const { email, username, school, role } = req.body;

  if (!email || !username || !school || !role) {
    return res.status(400).json({ status: "failed", message: "Missing required fields" });
  }

  const [firstName = "", lastName = ""] = username.split(" ");

  try {
    const { rows } = await db.query(userQueries.selectById, [id]);
    const target = rows[0];

    if (!target) {
      return res.status(404).json({ status: "failed", message: "User not found or not updated" });
    }
    if (!canAccess(req, target)) return forbidden(res);

    // Nobody moves an account to another school, and only admins change roles.
    if (school !== target.school || (role !== target.role && !isAdmin(req))) {
      return forbidden(res);
    }

    await db.query(userQueries.updateUserById, [email, username, firstName, lastName, school, role, id]);

    logger.info({ status: "success", message: "User updated" });
    return res.status(200).json({ status: "success", message: "User updated successfully" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Internal Server Error" });
  }
};

const updatePassword = async (req, res) => {
  const { id } = req.params;
  const { oldPassword, newPassword } = req.body;
  const saltRounds = 10;

  if (id !== req.user?.userId) {
    return res.status(403).json({ status: "failed", message: "You can only change your own password" });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query("SELECT password FROM users WHERE user_id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }

    const currentHashedPassword = result.rows[0].password;
    const isMatch = await bcrypt.compare(oldPassword, currentHashedPassword);
    if (!isMatch) {
      return res.status(401).json({ status: "failed", message: "Old password is incorrect" });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, saltRounds);
    await client.query(userQueries.updatePassword, [hashedNewPassword, id]);

    await client.query('COMMIT');
    return res.status(200).json({ status: "success", message: "Password updated successfully" });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Internal Server Error" });
  } finally {
    client.release();
  }
};

module.exports = {
  getAllUser,
  getUser,
  deleteUser,
  updateUser,
  getUserByEmail,
  updatePassword,
  getUsersBySchool
};
