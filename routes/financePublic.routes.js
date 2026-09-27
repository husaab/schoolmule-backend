const express = require('express');
const router = express.Router();
const controller = require('../controllers/finance.controller');

// Intuit redirects the browser here with no Authorization header, so this route
// is mounted before verifyUser in server.js. The school is recovered from the
// HMAC-signed `state` the authenticated connect-url endpoint issued.
router.get('/callback', controller.oauthCallback);

module.exports = router;
