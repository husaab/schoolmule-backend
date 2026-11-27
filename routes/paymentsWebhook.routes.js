const express = require('express');
const controller = require('../controllers/paymentsWebhook.controller');

const router = express.Router();

// Stripe calls this with no JWT; the controller checks Stripe's signature.
// The body is the raw Buffer (see the express.raw mount in server.js).
router.post('/', controller.receive);

module.exports = router;
