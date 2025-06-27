// src/routes/email.routes.js
const express = require('express');
const { sendContactEmail, sendTicketEmail } = require('../controllers/email.controller');
const responseParser = require('../utils/responseParser');
const verifyUser    = require('../middleware/verifyUserMiddleware');

const router = express.Router();

// Public contact form
router.post('/contact', sendContactEmail);

// Authenticated support ticket
router.post('/ticket', verifyUser, sendTicketEmail);

module.exports = router;