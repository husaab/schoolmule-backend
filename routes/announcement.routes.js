// routes/announcement.routes.js
//
// One-to-many announcements. Collection routes are staff-or-parent scoped
// inside the controller; /:id routes run requireAnnouncementAccess first.
const express = require('express');
const requireStaff = require('../middleware/requireStaff');
const requireAnnouncementAccess = require('../middleware/requireAnnouncementAccess');
const { uploadFiles } = require('../utils/attachmentUpload');
const c = require('../controllers/announcement.controller');

const router = express.Router();

// Fixed paths before /:id so "targets" is never read as an announcement id.
router.get('/', c.list);
router.get('/unread-count', c.unreadCount);
router.get('/targets', requireStaff, c.targets);
router.get('/preview', requireStaff, c.preview);
router.post('/', requireStaff, uploadFiles, c.create);

router.get('/:id', requireAnnouncementAccess, c.get);
router.patch('/:id', requireAnnouncementAccess, uploadFiles, c.update);
router.delete('/:id', requireAnnouncementAccess, c.remove);
router.post('/:id/read', requireAnnouncementAccess, c.markRead);
router.post('/:id/emails/retry', requireAnnouncementAccess, c.retryEmails);
router.get('/:id/attachments/:attachmentId/url', requireAnnouncementAccess, c.attachmentUrl);

module.exports = router;
