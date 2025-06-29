const express = require('express');
const { getAllParents, getParentById } = require('../controllers/parent.controller');
const router = express.Router();

// GET /api/parents?school=X
router.get('/', getAllParents);

// GET /api/parents/:id
router.get('/:id', getParentById);

module.exports = router;
