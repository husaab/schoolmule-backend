const express = require('express');
const requireStaff = require('../middleware/requireStaff');
const { getAllParents, getParentById } = require('../controllers/parent.controller');
const router = express.Router();

// Parent accounts are listed for the admin link picker; a parent has no
// business reading other families' accounts.
router.use(requireStaff);

// GET /api/parents
router.get('/', getAllParents);

// GET /api/parents/:id
router.get('/:id', getParentById);

module.exports = router;
