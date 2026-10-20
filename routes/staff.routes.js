const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staff.controller');
const { requirePermission } = require('../middleware/access');

// The directory is read by every role (the parent portal has one too) and is
// always the caller's own school; changing it is part of managing users.
const managesUsers = requirePermission('users');
// GET /api/staff?school=<school> - Get all staff for a school
router.get('/', staffController.getStaffBySchool);

// GET /api/staff/:staffId - Get specific staff member
router.get('/:staffId', staffController.getStaffById);

// POST /api/staff - Create new staff member
router.post('/', managesUsers, staffController.createStaff);

// PATCH /api/staff/:staffId - Update staff member
router.patch('/:staffId', managesUsers, staffController.updateStaff);

// DELETE /api/staff/:staffId - Delete staff member
router.delete('/:staffId', managesUsers, staffController.deleteStaff);

module.exports = router;