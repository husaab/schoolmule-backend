const db = require("../config/database");
const bcrypt = require("bcrypt");
const userQueries = require("../queries/user.queries");
const logger = require("../logger");

const getAllUser = async (req, res) => {
  try {
    const sql = userQueries.selectAllUsers;
    const result = await db.query(sql);

    logger.info("All users fetched successfully");
    return res.status(200).json({
      status: "success",
      users: result.rows.map(user => ({
        id: user.id,
        username: user.username,
        fullName: `${user.first_name} ${user.last_name}`,
        email: user.email,
        createdAt: user.created_at,
        lastModifiedAt: user.last_modified_at,
        isVerified: user.is_verified,
        emailToken: user.email_token
      }))
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching users" });
  }
};

const getUserByEmail = async (req, res) => {
  const { email } = req.params;
  if (!email) {
    return res.status(400).json({ status: "failed", message: "Email is required" });
  }

  try {
    const sql = userQueries.selectByEmail;
    const result = await db.query(sql, [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "User not found" });
    }

    const user = result.rows[0];
    return res.status(200).json({
      status: "success",
      data: {
        id: user.id,
        username: user.username,
        fullName: `${user.first_name} ${user.last_name}`,
        email: user.email,
        createdAt: user.created_at,
        lastModifiedAt: user.last_modified_at,
        isVerified: user.is_verified,
        emailToken: user.email_token
      }
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Internal Server Error" });
  }
};

const getUser = async (req, res) => {
  const id = req.params.id;
  try {
    const sql = userQueries.selectById;
    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ status: "failed", message: `User with id ${id} not found` });
    }

    const user = result.rows[0];
    return res.status(200).json({
      status: "success",
      user: {
        id: user.id,
        username: user.username,
        fullName: `${user.first_name} ${user.last_name}`,
        email: user.email,
        createdAt: user.created_at,
        lastModifiedAt: user.last_modified_at,
        isVerified: user.is_verified,
        emailToken: user.email_token
      }
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching user" });
  }
};

const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const sql = userQueries.deleteUser;
    const result = await db.query(sql, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ status: "failed", message: "User not found or already deleted" });
    }

    logger.info({ status: "success", message: "User deleted" });
    return res.status(200).json({ status: "success", message: "User deleted successfully" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting user" });
  }
};

const updateUser = async (req, res) => {
  const { id } = req.params;
  const { email, username } = req.body;

  const [firstName = "", lastName = ""] = username.split(" ");

  try {
    const sql = userQueries.updateUserById;
    const result = await db.query(sql, [email, username, firstName, lastName, id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ status: "failed", message: "User not found or not updated" });
    }

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

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query("SELECT password FROM users WHERE id = $1", [id]);

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
  updatePassword
};
