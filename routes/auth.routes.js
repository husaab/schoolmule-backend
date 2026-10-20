const express = require("express");
const { registerUser, login, googleSignIn, studentQrLogin, sendVerificationEmail, verifyEmail, approveUserForSchool,
getPendingApprovals, resendSchoolApprovalEmail, deleteUserAccount, declineUserForSchool, logout, requestPasswordReset,
validateResetToken, resetPassword, validateSession, switchView} = require("../controllers/auth.controller");
const responseParser = require("../utils/responseParser");
const verifyUser = require('../middleware/verifyUserMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const { signupLimiter, loginLimiter, loginAccountLimiter, qrCardLimiter, inviteTokenLimiter, inviteNetworkLimiter, resetTokenLimiter, verificationEmailLimiter, passwordResetLimiter, studentRequestNetworkLimiter, studentRequestAddressLimiter } = require('../middleware/spamProtection');
const { inspectInvite, acceptInvite } = require('../controllers/studentInvite.controller');
const { submit: submitStudentRequest } = require('../controllers/studentRequest.controller');

const router = express.Router();

router.post( "/register", signupLimiter, responseParser(registerUser));
// Sign-in limits count failures only, per account and per network, so a
// class signing in together from one school IP isn't locked out
// (middleware/spamProtection.js). The account check runs first, so hammering
// one account doesn't drain the whole network's budget.
router.post( "/login", loginAccountLimiter, loginLimiter, responseParser(login));
// Sign in or sign up with Google (code from the Google popup). Per network
// only: every attempt needs a real Google account, so it can't guess.
router.post( "/google", loginLimiter, responseParser(googleSignIn));
// A student's printed QR card (the /qr page posts its token). Same response
// as a password sign-in.
router.post('/student-qr', qrCardLimiter, loginLimiter, responseParser(studentQrLogin));
// A student's invite link (/student-invite#<secret>): who it is for, then
// accepting it with a password or Google (controllers/studentInvite.controller.js).
router.post('/student-invite', inviteTokenLimiter, inviteNetworkLimiter, responseParser(inspectInvite));
router.post('/student-invite/accept', inviteTokenLimiter, inviteNetworkLimiter, responseParser(acceptInvite));
// A student asks for an account from /signup/<school>/student; the office
// approves it on the Approvals page (controllers/studentRequest.controller.js).
router.post('/student-request', studentRequestNetworkLimiter, studentRequestAddressLimiter, submitStudentRequest);
router.post( "/verify-email", verificationEmailLimiter, sendVerificationEmail);
router.get( "/confirm-email", verifyEmail);

router.post('/approve-school', verifyUser, requireAdmin, approveUserForSchool);
router.get('/pending-approvals', verifyUser, requireAdmin, getPendingApprovals);
router.post('/resend-approval-email', verifyUser, requireAdmin, verificationEmailLimiter, resendSchoolApprovalEmail);
// Token-only: a pending signup may delete itself from the waiting page.
router.delete('/delete-user', verifyUser.tokenOnly, deleteUserAccount);
router.post('/decline-school', verifyUser, requireAdmin, declineUserForSchool);
router.post('/logout', logout);

// Password reset routes
router.post("/request-password-reset", passwordResetLimiter, requestPasswordReset);
router.get("/validate-reset-token", resetTokenLimiter, validateResetToken);
router.post("/reset-password", resetTokenLimiter, resetPassword);

// Session validation
router.get("/me", validateSession);

// Dual-role view switch (staff who are also parents). verifyUser already
// refuses a POST from an admin "view as" preview token.
router.post("/view", verifyUser, switchView);

module.exports = router;