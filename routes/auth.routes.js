const express = require("express");
const { registerUser, login, sendVerificationEmail, verifyEmail, approveUserForSchool,
getPendingApprovals, resendSchoolApprovalEmail, deleteUserAccount, declineUserForSchool, logout, requestPasswordReset, 
validateResetToken, resetPassword} = require("../controllers/auth.controller");
const responseParser = require("../utils/responseParser");
const verifyUser = require('../middleware/verifyUserMiddleware');

const router = express.Router();

router.post( "/register", responseParser(registerUser));
router.post( "/login", responseParser(login));
router.post( "/verify-email", sendVerificationEmail);
router.get( "/confirm-email", verifyEmail);

router.post('/approve-school', verifyUser, approveUserForSchool);
router.get('/pending-approvals', verifyUser,  getPendingApprovals);
router.post('/resend-approval-email', resendSchoolApprovalEmail);
router.delete('/delete-user', deleteUserAccount);
router.post('/decline-school', verifyUser, declineUserForSchool);
router.post('/logout', logout);

// Password reset routes
router.post("/request-password-reset", requestPasswordReset);
router.get("/validate-reset-token", validateResetToken);
router.post("/reset-password", resetPassword);

module.exports = router;