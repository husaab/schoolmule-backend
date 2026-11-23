// routes/adminOverview.routes.js
// Admin Panel overview (controllers/adminOverview.controller.js): the live
// facts behind each tool row and the "Needs your attention" list. Open to
// anyone who can open the Admin Panel (the web's ADMIN_PANEL_KEYS); each
// block inside is trimmed to the caller's own permissions.

const express = require('express');
const { requirePermission } = require('../middleware/access');
const { getOverview } = require('../controllers/adminOverview.controller');

const router = express.Router();
router.use(requirePermission('users', 'school_setup', 'scheduling', 'forms', 'messages.all'));

router.get('/', getOverview);

module.exports = router;
