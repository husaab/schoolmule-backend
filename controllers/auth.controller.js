const db = require("../config/database");
const { v4: uuidv4 } = require('uuid');
const bcrypt = require("bcrypt");
const userQueries = require("../queries/user.queries");
const logger = require("../logger");
const { getVerificationEmailHTML } = require('../utils/emailTemplate');

  const registerUser = async (req, res) => {
    const saltRounds = 10;
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const { username, email, password, school, role } = req.body;

      if (!username || !email || !password || !school || !role) {
        throw { status: 400, message: "Missing required fields" };
      }

      const hashedPassword = await bcrypt.hash(password, saltRounds);
      const [firstName = '', lastName = ''] = username.split(" ");

      const userId = uuidv4();
      const emailToken = uuidv4();
      const isVerified = false;

      const values = [
        userId,
        email,
        username,
        hashedPassword,
        firstName,
        lastName,
        school,
        role,
        emailToken,
        isVerified
      ];

      const result = await client.query(userQueries.createUser, values);
      const user = result.rows[0];

      await client.query('COMMIT');

      const verificationUrl = `${process.env.FRONTEND_URL}/verifyemailtoken?token=${user.email_token}`;
      const html = getVerificationEmailHTML({
        name: user.first_name,
        url: verificationUrl
      });

      await resend.emails.send({
        from: 'verify@schoolmule.ca',
        to: user.email,
        subject: 'Verify your email at School Mule',
        html
      });

      const response = {
        status: 200,
        message: "User registered successfully. A verification email has been sent.",
        data: {
          userId: user.user_id,
          username: user.username,
          fullName: `${user.first_name} ${user.last_name}`,
          email: user.email,
          school: user.school,
          role: user.role,
          isVerified: user.is_verified,
          emailToken: user.email_token,
          createdAt: user.created_at,
          lastModifiedAt: user.last_modified_at
        }
      };

      logger.info(response);
      return res.status(200).json(response);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(error);
      return res.status(error.status || 500).json({
        status: "failed",
        message: error.message || "Internal Server Error"
      });
    } finally {
      client.release();
    }
  };
  

  const login = async (req, res) => {
    const { email, password } = req.body;

    try {
      const sql = userQueries.loginUser;
      const result = await db.query(sql, [email]);

      if (result.rows.length === 0) {
        throw { status: 404, message: "User not found" };
      }

      const user = result.rows[0];
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        throw { status: 401, message: "Invalid credentials" };
      }

      const response = {
        status: 200,
        message: "User login successful",
        data: {
          userId: user.user_id,
          username: user.username,
          fullName: `${user.first_name} ${user.last_name}`,
          email: user.email,
          school: user.school,
          role: user.role,
          isVerified: user.is_verified,
          createdAt: user.created_at,
          lastModifiedAt: user.last_modified_at
        }
      };

      logger.info(response);
      return res.status(200).json(response);
    } catch (error) {
      logger.error(error);
      return res.status(error.status || 500).json({
        status: "failed",
        message: error.message || "Internal Server Error"
      });
    }
  };

  const sendVerificationEmail = async (req, res) => {
    const { email } = req.body;
  
    try {
      const sql = userQueries.selectByEmail;
      const result = await db.query(sql, [email]);
  
      if (result.rows.length === 0) {
        throw { status: 404, message: "User not found" };
      }
  
      const user = result.rows[0];
      if (user.is_verified) {
        return {
          status: 200,
          message: "User already verified"
        };
      }
  
      const verificationUrl = `${process.env.FRONTEND_URL}/verifyemailtoken?token=${user.email_token}`;
      const html = getVerificationEmailHTML({
        name: user.first_name,
        url: verificationUrl
      });

      await resend.emails.send({
        from: 'verify@schoolmule.ca',
        to: email,
        subject: 'Verify your email at School Mule',
        html
      });
  
      return {
        status: 200,
        message: "Verification email sent successfully"
      };
    } catch (error) {
      logger.error("Verification email error:", error);
      throw { status: error.status || 500, message: error.message || "Failed to send verification email" };
    }
  };

  const verifyEmail = async (req, res) => {
    const { token } = req.query;
  
    if (!token) {
      throw { status: 400, message: "Missing email token" };
    }
  
    try {
      const result = await db.query(userQueries.verifyEmailToken, [token]);
  
      if (result.rowCount === 0) {
        throw { status: 400, message: "Invalid or expired token" };
      }
  
      const user = result.rows[0];
      return {
        status: 200,
        message: "Email verified successfully",
        data: {
          id: user.id,
          email: user.email,
          username: user.username,
          isVerified: user.is_verified
        }
      };
    } catch (error) {
      logger.error(error);
      throw { status: error.status || 500, message: error.message || "Failed to verify email" };
    }
  };


module.exports = {
    registerUser,
    login,
    sendVerificationEmail,
    verifyEmail
}