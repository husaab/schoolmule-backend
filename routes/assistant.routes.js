// routes/assistant.routes.js
//
// Muley, the in-product assistant. Mounted at /api/assistant after the token
// check and the parent gate, and ahead of resolveSchoolYear (the controller
// resolves the year itself: see yearOf there).
//
//   settings        any signed-in account: is Muley on for me?
//   turns           one message in, a stream of JSON lines out
//   conversations   the caller's own, in their current view
//   platform/...    the platform owner switches a school on
//
// Students never reach this router (the student fence), and an admin "view
// as" preview is refused: see middleware/requireAssistant.js.
const express = require('express');
const router = express.Router();
const requireAssistant = require('../middleware/requireAssistant');
const requirePlatformOwner = require('../middleware/requirePlatformOwner');
const { createGlobalLimiter } = require('../middleware/globalRateLimit');
const assistant = require('../controllers/assistant.controller');
const config = require('../services/assistant/config');

// A person sends a message every few seconds at most: this stops a loop.
const turnLimiter = createGlobalLimiter({ windowMs: 60_000, max: config.turnsPerMinute() });

router.get('/settings', assistant.getSettings);

router.post('/turns', requireAssistant, turnLimiter, assistant.startTurn);

router.get('/conversations', requireAssistant, assistant.listConversations);
router.get('/conversations/:conversationId', requireAssistant, assistant.getConversation);
router.patch('/conversations/:conversationId', requireAssistant, assistant.renameConversation);
router.delete('/conversations/:conversationId', requireAssistant, assistant.deleteConversation);

router.get('/platform/settings/:school', requirePlatformOwner, assistant.getSchoolSettings);
router.put('/platform/settings/:school', requirePlatformOwner, assistant.saveSchoolSettings);

module.exports = router;
