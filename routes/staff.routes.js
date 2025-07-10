const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staff.controller');
// GET /api/staff?school=<school> - Get all staff for a school
router.get('/', staffController.getStaffBySchool);

// GET /api/staff/:staffId - Get specific staff member
router.get('/:staffId', staffController.getStaffById);

// POST /api/staff - Create new staff member
router.post('/', staffController.createStaff);

// PATCH /api/staff/:staffId - Update staff member
router.patch('/:staffId', staffController.updateStaff);

// DELETE /api/staff/:staffId - Delete staff member
router.delete('/:staffId', staffController.deleteStaff);

module.exports = router;