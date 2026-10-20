// routes/adminStudentRequest.routes.js
// Admin Panel → Approvals → Students: students' account requests
// (controllers/studentRequest.controller.js). Admins only, their own school.

const express = require('express');
const { requirePermission } = require('../middleware/access');
const { list, candidates, approve, decline, restore, remove } = require('../controllers/studentRequest.controller');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = express.Router();
router.use(requirePermission('users')); // student accounts are part of users (D13)

router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: 'failed', message: 'Request not found' });
  return next();
});

router.get('/', list);
router.get('/:id/candidates', candidates);
router.post('/:id/approve', approve);
router.post('/:id/decline', decline);
router.post('/:id/restore', restore);
router.delete('/:id', remove);

module.exports = router;
