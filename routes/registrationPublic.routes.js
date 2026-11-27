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

// The family's payment link. Fixed paths before /:schoolSlug/:formSlug.
// The token in the link is the secret; these are rate limited per network.
const paymentReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const paymentStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { status: 'failed', message: 'Too many attempts. Please wait a little and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.get('/payments/:token', paymentReadLimiter, controller.getPayment);
router.post('/payments/:token/checkout', paymentStartLimiter, controller.startPayment);

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
