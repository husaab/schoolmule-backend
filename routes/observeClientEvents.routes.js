// Mounted at /api/observe/client-events AHEAD of the owner-gated router so
// every signed-in browser can report, but nothing else under /observe opens up.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { postClientEvents } = require('../controllers/observeClientEvents.controller');

const router = express.Router();

const beaconLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'failed', message: 'Too many reports' },
});

router.post('/', beaconLimiter, express.json({ limit: '16kb' }), postClientEvents);

module.exports = router;
