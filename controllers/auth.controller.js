const db = require("../config/database");
const { v4: uuidv4 } = require('uuid');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userQueries = require("../queries/user.queries");
const passwordQueries = require('../queries/password.queries');
const termQueries = require('../queries/term.queries');
const logger = require("../logger");
const { getVerificationEmailHTML, getConfirmedEmailHTML, getApprovalEmailHTML, getAdminNotifyEmailHTML, getDeclineEmailHTML
  , getResetEmailHTML
 } = require('../utils/emailTemplate');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper function to get active term for a school
const getActiveTermForSchool = async (school) => {
  try {
    const result = await db.query(termQueries.selectActiveTermBySchool, [school]);
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    logger.error('Error fetching active term:', error);
    return null;
  }
};

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

      // Get active term for the user's school
      const activeTerm = await getActiveTermForSchool(user.school);

      // Create JWT token with user data
      const tokenPayload = {
        userId: user.user_id,
        username: user.username,
        email: user.email,
        school: user.school,
        role: user.role,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        activeTerm: activeTerm ? activeTerm.name : null
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
        expiresIn: '7d'
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
          lastModifiedAt: user.last_modified_at,
          activeTerm: activeTerm ? activeTerm.name : null,
          token: token
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

      // Get active term for the user's school
      const activeTerm = await getActiveTermForSchool(user.school);

      // Create JWT token with user data
      const tokenPayload = {
        userId: user.user_id,
        username: user.username,
        email: user.email,
        school: user.school,
        role: user.role,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        activeTerm: activeTerm ? activeTerm.name : false
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, {
        expiresIn: '7d'
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
          lastModifiedAt: user.last_modified_at,
          activeTerm: activeTerm ? activeTerm.name : false,
          token: token
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
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'No token provided'
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Optional: Verify user still exists in database (recommended for security)
    const result = await db.query(userQueries.selectById, [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token - user not found'
      });
    }

    const user = result.rows[0];
    
    // Get active term for the user's school
    const activeTerm = await getActiveTermForSchool(user.school);
    
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
        lastModifiedAt: user.last_modified_at,
        activeTerm: activeTerm ? activeTerm.name : false
      }
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    } else {
      logger.error('Session validation error:', error);
      return res.status(500).json({
        success: false,
        message: 'Session validation failed'
      });
    }
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