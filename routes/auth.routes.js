const express = require("express");
const { registerUser, login, sendVerificationEmail, verifyEmail } = require("../controllers/auth.controller");
const responseParser = require("../utils/responseParser");

const router = express.Router();

router.post( "/register", responseParser(registerUser));
router.post( "/login", responseParser(login));
router.post( "/verify-email", sendVerificationEmail);
router.get( "/confirm-email", verifyEmail);

module.exports = router;