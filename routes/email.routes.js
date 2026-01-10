// src/routes/email.routes.js
const express = require('express');
const { sendContactEmail, sendTicketEmail } = require('../controllers/email.controller');
const responseParser = require('../utils/responseParser');
const verifyUser    = require('../middleware/verifyUserMiddleware');
const { contactFormLimiter, honeypotValidation, validateInput } = require('../middleware/spamProtection');

const router = express.Router();

// Public contact form - with rate limiting, honeypot, and input validation
router.post('/contact', contactFormLimiter, honeypotValidation, validateInput, sendContactEmail);

// Authenticated support ticket
router.post('/ticket', verifyUser, sendTicketEmail);

module.exports = router;