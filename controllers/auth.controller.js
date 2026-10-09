const db = require("../config/database");
const { v4: uuidv4 } = require('uuid');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const userQueries = require("../queries/user.queries");
const passwordQueries = require('../queries/password.queries');
const logger = require("../logger");
const { getVerificationEmailHTML, getConfirmedEmailHTML, getApprovalEmailHTML, getAdminNotifyEmailHTML,
  getResetEmailHTML } = require('../templates/emailTemplate');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const approvalActions = require('../services/approvalActions');
const { SIGNUP_ROLES } = approvalActions;

const { getActiveTermForSchool, getSchoolYearContext } = require('../utils/sessionContext');
const { sendOrThrow, sendSafely } = require('../utils/emailUtils');
const observeBuffer = require('../services/observe/eventBuffer');
const { isPlatformOwner } = require('../middleware/requirePlatformOwner');

// Every sign-in attempt, however it ends, becomes a login_events row.
const recordLogin = (req, { email, user, outcome }) => {
  observeBuffer.push('login_events', {
    email: String(email || '').trim().toLowerCase(),
    user_id: user ? user.user_id : null,
    school: user ? user.school : null,
    outcome,
    ip: req.ip || null,
    user_agent: req.headers['user-agent'] || null,
  });
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

      // Public signup can only ask for a teacher or parent account. Admins
      // skip the approval queue at login, so letting a request pick ADMIN
      // would hand out full access to anyone who finds this endpoint.
      if (!SIGNUP_ROLES.includes(role)) {
        await client.query('ROLLBACK');
        return { status: 400, message: "Please sign up as a teacher or a parent." };
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

      // The account is committed either way. A rejected email must not turn a
      // successful signup into a 500 (the next attempt would hit "email already
      // exists"); the verify-email page offers a resend.
      const emailSent = await sendSafely(resend, {
        from: 'verify@schoolmule.ca',
        to: user.email,
        subject: 'Verify your email at School Mule',
        html
      }, "Signup verification email failed to send", { userId: user.user_id });

      // Get active term for the user's school
      const activeTerm = await getActiveTermForSchool(user.school);
      const yearContext = await getSchoolYearContext(user.school);

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
        message: emailSent
          ? "User registered successfully. A verification email has been sent."
          : "User registered, but the verification email could not be sent. Use \"Resend verification email\" to try again.",
        data: {
          emailSent,
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
          activeTerm: activeTerm ? activeTerm.name : null,
          activeSchoolYear: yearContext.activeSchoolYear,
          schoolYears: yearContext.schoolYears,
          token: token
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error }, "User registration failed");
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
    let user = null;

    try {
      const sql = userQueries.loginUser;
      const result = await db.query(sql, [email]);

      if (result.rows.length === 0) {
        recordLogin(req, { email, user: null, outcome: 'unknown_email' });
        throw { status: 404, message: "User not found" };
      }

      user = result.rows[0];
      const isPasswordValid = await bcrypt.compare(password, user.password);

      if (!isPasswordValid) {
        recordLogin(req, { email, user, outcome: 'bad_password' });
        throw { status: 401, message: "Invalid credentials" };
      }

      // Archived accounts keep their history but can't sign in.
      if (user.is_archived) {
        recordLogin(req, { email, user, outcome: 'archived' });
        throw { status: 403, message: "This account has been archived. Contact your school admin." };
      }

      if (user.role === 'ADMIN') {
        user.is_verified = true;
        user.is_verified_school = true;
      }

      recordLogin(req, { email, user, outcome: user.is_verified && user.is_verified_school ? 'success' : 'not_verified' });
      db.query(userQueries.touchLastLogin, [user.user_id]).catch((err) => {
        logger.warn({ observe: true, err }, 'last_login_at update failed');
      });

      // Get active term for the user's school
      const activeTerm = await getActiveTermForSchool(user.school);
      const yearContext = await getSchoolYearContext(user.school);

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
          isPlatformOwner: isPlatformOwner(user.email),
          createdAt: user.created_at,
          lastModifiedAt: user.last_modified_at,
          activeTerm: activeTerm ? activeTerm.name : false,
          activeSchoolYear: yearContext.activeSchoolYear,
          schoolYears: yearContext.schoolYears,
          token: token
        }
      };

    } catch (error) {
      // A thrown { status, message } is a verdict, not a failure: keep its
      // status so a wrong password is a 401 and never counts as a 500.
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) logger.error({ err: error }, "Login failed");
      return {
        status,
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

      await sendOrThrow(resend, {
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
      logger.error({ err: error }, "Verification email error");
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

      // The token was consumed above, so the verification itself succeeded.
      // Neither courtesy email below may fail the request: a retry would only
      // see "Invalid or expired token". Log and carry on.
      const html = getConfirmedEmailHTML({ name: user.username });

      await sendSafely(resend, {
        from: 'verify@schoolmule.ca',
        to: user.email,
        subject: 'Your Email Has Been Verified at School Mule',
        html,
      }, "Email-verified confirmation failed to send", { userId: user.user_id });

      const admins = await db.query(userQueries.getAdminsBySchool, [user.school]);

      logger.info({ school: user.school, adminCount: admins.rows.length }, "Admins found for school");
      const recipients = [...new Set(admins.rows.map(a => a.email).filter(Boolean))];

      const adminHtml = getAdminNotifyEmailHTML({
        new_user: user.username,
        school: user.school,
      });

      logger.info({ recipientCount: recipients.length }, "Notifying admins");
      await sendSafely(resend, {
        from: 'notification@schoolmule.ca',
        to: recipients,
        subject: 'New User Awaiting School Approval',
        html: adminHtml,
      }, "Admin approval notification failed to send", { school: user.school, userId: user.user_id });

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
      logger.error({ err: error }, "Email verification failed");
      throw { status: error.status || 500, message: error.message || "Failed to verify email" };
    }
  };

// The old Approvals page called these two; they now run the same actions as
// POST /api/admin/approvals/:id/approve|decline and keep the {success} shape.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const legacyApprovalRoute = (verb, run) => async (req, res) => {
  const { userId } = req.body ?? {};
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return res.status(404).json({ success: false, message: "User not found" });
  }
  try {
    const result = await run(req, userId);
    return res.status(200).json({
      success: true,
      message: result.emailSent ? `User ${verb} and email sent` : `User ${verb}, but the email could not be sent`,
      emailSent: result.emailSent,
    });
  } catch (error) {
    if (error instanceof approvalActions.ApprovalError) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    logger.error({ err: error }, `Failed to run legacy ${verb} route`);
    return res.status(500).json({ success: false, message: `Failed to ${verb === 'approved' ? 'approve' : 'decline'} user` });
  }
};

const approveUserForSchool = legacyApprovalRoute('approved', (req, userId) =>
  approvalActions.approveSignup({ school: req.user.school, userId })
);

const getPendingApprovals = async (req, res) => {
  // Always the admin's own school; a ?school= param is ignored.
  const school = req.user?.school;

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
    logger.error({ err: error }, "Failed to fetch pending approvals");
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch pending approvals',
    });
  }
};

const resendSchoolApprovalEmail = async (req, res) => {
  const { userId } = req.body;
  try {
    const result = await db.query(userQueries.resendSchoolApprovalEmail, [userId, req.user.school]);

    if (result.rows.length === 0) {
      throw { status: 404, message: "User not found or already approved" };
    }

    const user = result.rows[0];
    const html = getApprovalEmailHTML({ name: user.username });

    await sendOrThrow(resend, {
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
    logger.error({ err: error }, "Failed to resend approval email");
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to resend approval email",
    });
  }
};

const deleteUserAccount = async (req, res) => {
  // Self-service only: the account to delete comes from the verified token, never
  // from the request body. Trusting a body-supplied userId here would let any
  // authenticated caller delete someone else's account.
  const userId = req.user?.userId;

  if (!userId) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }

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
    logger.error({ err: error }, "Failed to delete user account");
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || "Failed to delete user",
    });
  }
};

const declineUserForSchool = legacyApprovalRoute('declined', (req, userId) =>
  approvalActions.declineSignup({ school: req.user.school, userId, adminId: req.user.userId })
);

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
    logger.error({ err }, "Password reset request failed");
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const sendResetEmail = async (to, url) => {
  const html = getResetEmailHTML({ name: 'there', url }); // you can customize name later
  await sendOrThrow(resend, {
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
    logger.error({ err }, "Reset token validation failed");
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
    logger.error({ err }, "Password reset failed");
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

    // Archived mid-session: the token is still valid, so end the session here.
    if (user.is_archived) {
      return res.status(401).json({
        success: false,
        message: 'This account has been archived'
      });
    }
    
    // Get active term for the user's school
    const activeTerm = await getActiveTermForSchool(user.school);
    const yearContext = await getSchoolYearContext(user.school);

    // Approval or a role change after sign-in leaves the token's claims
    // behind the database. Reissue so an open app recovers without a
    // sign-out. Never for a preview token: that must stay the admin's.
    const claimsDrifted =
      !decoded.impersonator &&
      (decoded.isVerified !== user.is_verified ||
        decoded.isVerifiedSchool !== user.is_verified_school ||
        decoded.role !== user.role);
    const refreshedToken = claimsDrifted
      ? jwt.sign(
          {
            userId: user.user_id,
            username: user.username,
            email: user.email,
            school: user.school,
            role: user.role,
            isVerified: user.is_verified,
            isVerifiedSchool: user.is_verified_school,
            activeTerm: activeTerm ? activeTerm.name : null,
          },
          process.env.JWT_SECRET,
          { expiresIn: '7d' }
        )
      : undefined;

    return res.status(200).json({
      success: true,
      message: 'Session valid',
      data: {
        // Present only when the claims drifted; the client stores it.
        ...(refreshedToken && { token: refreshedToken }),
        userId: user.user_id,
        username: user.username,
        fullName: `${user.first_name} ${user.last_name}`,
        email: user.email,
        school: user.school,
        role: user.role,
        isVerified: user.is_verified,
        isVerifiedSchool: user.is_verified_school,
        isPlatformOwner: isPlatformOwner(user.email),
        createdAt: user.created_at,
        lastModifiedAt: user.last_modified_at,
        activeTerm: activeTerm ? activeTerm.name : false,
        activeSchoolYear: yearContext.activeSchoolYear,
        schoolYears: yearContext.schoolYears,
        // Present only on an admin "view as" preview token (see adminUser.controller
        // impersonateUser) so a page reload can restore the preview banner.
        impersonator: decoded.impersonator ?? null
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
      logger.error({ err: error }, "Session validation error");
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