const express = require('express');
const router = express.Router();
const controller = require('../controllers/googleSheets.controller');

// Google redirects the browser here with no Authorization header, so this route
// is mounted before verifyUser in server.js. The school is recovered from the
// HMAC-signed `state` the authenticated auth-url endpoint issued, which is what
// stops a forged callback attaching a Google account to another tenant.
router.get('/callback', controller.oauthCallback);

module.exports = router;
