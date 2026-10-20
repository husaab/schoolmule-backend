const express = require('express');
const { requirePermission } = require('../middleware/access');
const { getAllParents, getParentById } = require('../controllers/parent.controller');
const router = express.Router();

// Parent accounts are listed for the admin link picker; a parent has no
// business reading other families' accounts.
// Parent accounts are listed for the Relations page: managing users.
router.use(requirePermission('users'));

// GET /api/parents
router.get('/', getAllParents);

// GET /api/parents/:id
router.get('/:id', getParentById);

module.exports = router;
