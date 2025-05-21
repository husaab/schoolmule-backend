const express = require("express");
const { registerUser, login, sendVerificationEmail, verifyEmail } = require("../controllers/auth.controller");

const router = express.Router();

router.post( "/register", registerUser);
router.post( "/login", login);
router.post( "/verify-email", sendVerificationEmail);
router.get( "/confirm-email", verifyEmail);

module.exports = router;