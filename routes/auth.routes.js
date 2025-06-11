const express = require("express");
const { registerUser, login, sendVerificationEmail, verifyEmail, approveUserForSchool,
getPendingApprovals, resendSchoolApprovalEmail, deleteUserAccount, declineUserForSchool} = require("../controllers/auth.controller");
const responseParser = require("../utils/responseParser");

const router = express.Router();

router.post( "/register", responseParser(registerUser));
router.post( "/login", responseParser(login));
router.post( "/verify-email", sendVerificationEmail);
router.get( "/confirm-email", verifyEmail);
router.post('/approve-school', approveUserForSchool);
router.get('/pending-approvals', getPendingApprovals);
router.post('/resend-approval-email', resendSchoolApprovalEmail);
router.delete('/delete-user', deleteUserAccount);
router.post('/decline-school', declineUserForSchool);

module.exports = router;