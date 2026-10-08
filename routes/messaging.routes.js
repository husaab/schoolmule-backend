// routes/messaging.routes.js
//
// Parent–teacher conversations. Every :id route runs requireConversationAccess
// first; the collection routes derive their own scope from req.user.

const express = require('express');
const requireConversationAccess = require('../middleware/requireConversationAccess');
const c = require('../controllers/messaging.controller');

const router = express.Router();

// Fixed paths before /:id so "unread-count" is never read as a conversation id.
router.get('/conversations', c.listConversations);
router.get('/conversations/unread-count', c.getUnreadSummary);
router.get('/conversations/targets', c.getTargets);
router.get('/conversations/stubs', c.getStubs);
router.post('/conversations', c.uploadFiles, c.createConversation);
router.post('/conversations/invites/:linkId/resend', c.resendInvite);

router.get('/conversations/:id', requireConversationAccess, c.getConversation);
router.post('/conversations/:id/messages', requireConversationAccess, c.uploadFiles, c.postMessage);
router.patch('/conversations/:id/messages/:messageId', requireConversationAccess, c.editMessage);
router.delete('/conversations/:id/messages/:messageId', requireConversationAccess, c.deleteMessage);
router.post('/conversations/:id/read', requireConversationAccess, c.markRead);
router.patch('/conversations/:id/mute', requireConversationAccess, c.setMuted);
router.patch('/conversations/:id', requireConversationAccess, c.setStatus);
router.get('/conversations/:id/attachments/:attachmentId/url', requireConversationAccess, c.getAttachmentUrl);

module.exports = router;
