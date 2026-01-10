const express = require("express");
const { registerUser, login, sendVerificationEmail, verifyEmail, approveUserForSchool,
getPendingApprovals, resendSchoolApprovalEmail, deleteUserAccount, declineUserForSchool, logout, requestPasswordReset,
validateResetToken, resetPassword, validateSession} = require("../controllers/auth.controller");
const responseParser = require("../utils/responseParser");
const verifyUser = require('../middleware/verifyUserMiddleware');
const { signupLimiter, loginLimiter, verificationEmailLimiter, passwordResetLimiter } = require('../middleware/spamProtection');

const router = express.Router();

router.post( "/register", signupLimiter, responseParser(registerUser));
router.post( "/login", loginLimiter, responseParser(login));
router.post( "/verify-email", verificationEmailLimiter, sendVerificationEmail);
router.get( "/confirm-email", verifyEmail);

router.post('/approve-school', verifyUser, approveUserForSchool);
router.get('/pending-approvals', verifyUser,  getPendingApprovals);
router.post('/resend-approval-email', verificationEmailLimiter, resendSchoolApprovalEmail);
router.delete('/delete-user', deleteUserAccount);
router.post('/decline-school', verifyUser, declineUserForSchool);
router.post('/logout', logout);

// Password reset routes
router.post("/request-password-reset", passwordResetLimiter, requestPasswordReset);
router.get("/validate-reset-token", validateResetToken);
router.post("/reset-password", resetPassword);

// Session validation
router.get("/me", validateSession);

module.exports = router;