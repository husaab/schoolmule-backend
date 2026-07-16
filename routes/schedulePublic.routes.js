const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/schedulePublic.controller');

// Public read-only endpoint — 60 requests per IP per 15 minutes
const publicScheduleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { status: 'failed', message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
});

router.get('/:schoolSlug/:shareToken', publicScheduleLimiter, controller.getPublicSchedule);

module.exports = router;
