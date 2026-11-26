// routes/aiUsage.routes.js
//
// The web app's AI routes (schoolmule/src/app/api/ai) run on the web server
// and call OpenAI with the school's shared key. They can't count usage
// themselves, so each one reports here with the caller's own token: once
// before it calls the model (start: refused with 429 when a limit is
// reached, counted otherwise) and once after (record: the tokens it used).
// Limits and counting live in services/aiUsage.js.
const express = require('express');
const router = express.Router();
const { requireStaffAccess } = require('../middleware/access');
const { startRequest, recordUsage } = require('../controllers/aiUsage.controller');

// Staff views only, as the AI routes themselves are.
router.use(requireStaffAccess);

router.post('/start', startRequest);
router.post('/record', recordUsage);

module.exports = router;
