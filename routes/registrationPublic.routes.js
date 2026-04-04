const express = require('express');
const router = express.Router();
const controller = require('../controllers/registrationPublic.controller');
const { honeypotValidation } = require('../middleware/spamProtection');
const rateLimit = require('express-rate-limit');

// Rate limiter for form submissions — 10 per IP per hour
const registrationSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: 'Too many form submissions. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  },
});

// GET published form (public, no auth)
router.get('/:schoolSlug/:formSlug', controller.getPublicForm);

// POST submit form (public, with spam protection)
router.post(
  '/:schoolSlug/:formSlug/submit',
  registrationSubmitLimiter,
  honeypotValidation,
  controller.submitForm
);

module.exports = router;
