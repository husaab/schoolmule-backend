const express = require("express");
const { registerUser, login, sendVerificationEmail, verifyEmail } = require("../controllers/auth.controller");
const { validateUserRegistration, validateUserLogin } = require("../middleware/validation/user.validator");
const responseParser = require("../utils/responseParser");

const router = express.Router();

router.post( "/register", validateUserRegistration, registerUser);
router.post( "/login", validateUserLogin, login);
router.post( "/verify-email", responseParser(sendVerificationEmail));
router.get( "/confirm-email", responseParser(verifyEmail));

module.exports = router;