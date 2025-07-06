const db = require("../config/database");
const { v4: uuidv4 } = require('uuid');
const bcrypt = require("bcrypt");
const userQueries = require("../queries/user.queries");
const passwordQueries = require('../queries/password.queries');
const logger = require("../logger");
const { getVerificationEmailHTML, getConfirmedEmailHTML, getApprovalEmailHTML, getAdminNotifyEmailHTML, getDeclineEmailHTML
  , getResetEmailHTML
 } = require('../utils/emailTemplate');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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
      const isVerifiedSchool = false;

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
        isVerified,
        isVerifiedSchool
      ];

      const result = await client.query(userQueries.createUser, values);
      const user = result.rows[0];

      await client.query('COMMIT');

      const verificationUrl = `${process.env.FRONTEND_URL}/verify-email-token?token=${user.email_token}`;
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

      return {
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
          isVerifiedSchool: user.is_verified_school,
          emailToken: user.email_token,
          createdAt: user.created_at,
          lastModifiedAt: user.last_modified_at
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(error);
      if (error.code === '23505' && error.constraint === 'users_duplicate_email_key') {
        return {
          status: 400,
          message: "An account with this email already exists.",
        };
      }

      return {
        status: 500,
        message: error.message || "Internal Server Error"
      };
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

      if (user.role === 'ADMIN') {
        user.is_verified = true;
        user.is_verified_school = true;
      }

      res.cookie('user_id', user.user_id, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });

      res.cookie('is_verified_email', user.is_verified, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });

      res.cookie('is_verified_school', user.is_verified_school, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });

      return {
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
          isVerifiedSchool: user.is_verified_school,
          createdAt: user.created_at,
          lastModifiedAt: user.last_modified_at
        }
      };

    } catch (error) {
      logger.error(error);
      return {
        status: 500,
        message: error.message || "Internal Server Error"
      };
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
  
      const verificationUrl = `${process.env.FRONTEND_URL}/verify-email-token?token=${user.email_token}`;
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
  
      return res.status(200).json({
        success: true,
        message: "Verification email sent successfully"
      });
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

      const html = getConfirmedEmailHTML({ name: user.username });

      await resend.emails.send({
        from: 'verify@schoolmule.ca',
        to: user.email,
        subject: 'Your Email Has Been Verified at School Mule',
        html,
      });

      const admins = await db.query(userQueries.getAdminsBySchool, [user.school]);

      console.log("Admins found for school:", user.school, admins.rows);

      for (const admin of admins.rows) {
        const adminHtml = getAdminNotifyEmailHTML({
          name: admin.first_name,
          school: user.school,
        });
        console.log("Notifying admin:", admin.email);
        await resend.emails.send({
          from: 'notification@schoolmule.ca',
          to: admin.email,
          subject: 'New User Awaiting School Approval',
          html: adminHtml,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Email verified successfully",
        data: {
          id: user.user_id,
          email: user.email,
          username: user.username,
          isVerified: user.is_verified
        }
      });
    } catch (error) {
      logger.error(error);
      throw { status: error.status || 500, message: error.message || "Failed to verify email" };
    }
  };

const approveUserForSchool = async (req, res) => {
  const { userId } = req.body;
  try {
    const result = await db.query(userQueries.approveUserSchool, [userId]);

    if (result.rows.length === 0) {
      throw { status: 404, message: "User not found or already approved" };
    }

    const user = result.rows[0];
    const html = getApprovalEmailHTML({ name: user.username });

    await resend.emails.send({
      from: 'verify@schoolmule.ca',
      to: user.email,
      subject: 'Your School Mule Account Has Been Approved',
      html,
    });

    return res.status(200).json({
      success: true,
      message: "User approved and email sent",
    });

  } catch (error) {
    logger.error(error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to approve user",
    });
  }
};

const getPendingApprovals = async (req, res) => {
  const { school } = req.query;

  if (!school) {
    return res.status(400).json({
      success: false,
      message: 'Missing school identifier',
    });
  }

  try {
    const result = await db.query(userQueries.getPendingSchoolApprovals, [school]);

    return res.status(200).json({
      success: true,
      users: result.rows,
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch pending approvals',
    });
  }
};

const resendSchoolApprovalEmail = async (req, res) => {
  const { userId } = req.body;
  try {
    const result = await db.query(userQueries.resendSchoolApprovalEmail, [userId]);

    if (result.rows.length === 0) {
      throw { status: 404, message: "User not found or already approved" };
    }

    const user = result.rows[0];
    const html = getApprovalEmailHTML({ name: user.username });

    await resend.emails.send({
      from: 'verify@schoolmule.ca',
      to: user.email,
      subject: 'Reminder: Your School Mule Account Was Approved',
      html,
    });

    return res.status(200).json({
      success: true,
      message: "Approval email resent successfully",
    });

  } catch (error) {
    logger.error(error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to resend approval email",
    });
  }
};

const deleteUserAccount = async (req, res) => {
  const { userId } = req.body;

  try {
    const result = await db.query(userQueries.deleteUser, [userId]);

    if (result.rowCount === 0) {
      throw { status: 404, message: "User not found" };
    }

    return res.status(200).json({
      success: true,
      message: "User account deleted",
    });
  } catch (error) {
    logger.error(error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to delete user",
    });
  }
};

const declineUserForSchool = async (req, res) => {
  const { userId } = req.body;

  try {
    const result = await db.query(userQueries.selectById, [userId]);
    if (result.rows.length === 0) {
      throw { status: 404, message: "User not found" };
    }

    const user = result.rows[0];
    const html = getDeclineEmailHTML({ name: user.first_name, school: user.school });

    await resend.emails.send({
      from: 'verify@schoolmule.ca',
      to: user.email,
      subject: 'Your School Mule Account Was Declined',
      html,
    });

    return res.status(200).json({ success: true, message: 'User declined and email sent.' });
  } catch (error) {
    logger.error(error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to decline user",
    });
  }
};

const logout = async (req, res) => {
  res.clearCookie('user_id');
  res.clearCookie('is_verified_email');
  res.clearCookie('is_verified_school');

  return res.status(200).json({
    success: true,
    message: 'Logged out successfully',
  });
};

const requestPasswordReset = async (req, res) => {
  const { email } = req.body;

  try {
    const userResult = await db.query(userQueries.selectByEmail, [email]);
    if (userResult.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'No user found with this email.' });
    }

    const user = userResult.rows[0];

    const tokenResult = await db.query(passwordQueries.createPasswordResetToken, [user.user_id]);
    const token = tokenResult.rows[0].token;

    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    await sendResetEmail(user.email, resetLink);

    res.json({ success: true, message: 'Password reset email sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const sendResetEmail = async (to, url) => {
  const html = getResetEmailHTML({ name: 'there', url }); // you can customize name later
  await resend.emails.send({
    from: 'reset@schoolmule.ca',
    to,
    subject: 'Reset your password',
    html
  });
};

const validateResetToken = async (req, res) => {
  const { token } = req.query;

  try {
    const tokenResult = await db.query(passwordQueries.validatePasswordResetToken, [token]);

    if (tokenResult.rowCount === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token.' });
    }

    res.json({ success: true, message: 'Token is valid.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;

  try {
    const tokenResult = await db.query(passwordQueries.validatePasswordResetToken, [token]);
    if (tokenResult.rowCount === 0) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token.' });
    }

    const { user_id } = tokenResult.rows[0];

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query(userQueries.updatePassword, [hashedPassword, user_id]);
    await db.query(passwordQueries.deletePasswordResetToken, [token]);

    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const validateSession = async (req, res) => {
  const userId = req.cookies['user_id'];
  const isEmailVerified = req.cookies['is_verified_email'] === 'true';
  const isSchoolVerified = req.cookies['is_verified_school'] === 'true';

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'No session found'
    });
  }

  try {
    const result = await db.query(userQueries.selectById, [userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const user = result.rows[0];
    
    return res.status(200).json({
      success: true,
      message: 'Session valid',
      data: {
        userId: user.user_id,
        username: user.username,
        fullName: `${user.first_name} ${user.last_name}`,
        email: user.email,
        school: user.school,
        role: user.role,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        createdAt: user.created_at,
        lastModifiedAt: user.last_modified_at
      }
    });
  } catch (error) {
    logger.error('Session validation error:', error);
    return res.status(500).json({
      success: false,
      message: 'Session validation failed'
    });
  }
};

module.exports = {
    registerUser,
    login,
    sendVerificationEmail,
    verifyEmail,
    approveUserForSchool,
    getPendingApprovals,
    resendSchoolApprovalEmail,
    deleteUserAccount,
    declineUserForSchool,
    logout,
    requestPasswordReset,
    validateResetToken,
    resetPassword,
    validateSession
}