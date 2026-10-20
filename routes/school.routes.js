// src/routes/school.routes.js
//
// A school's own record is read and edited by its staff (school setup and the
// schedule planner); listing, creating and deleting schools is the platform
// owner's job only. The controller also pins every read and edit to the
// caller's own school.

const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.controller');
const requirePlatformOwner = require('../middleware/requirePlatformOwner');
const { requirePermission } = require('../middleware/access');

const ownSchoolReaders = requirePermission('school_setup', 'scheduling');

// GET /api/schools - Get all schools
router.get('/', requirePlatformOwner, schoolController.getAllSchools);

// GET /api/schools/:code - Get school by code (enum)
router.get('/:code', ownSchoolReaders, schoolController.getSchoolByCode);

// GET /api/schools/id/:id - Get school by ID
router.get('/id/:id', ownSchoolReaders, schoolController.getSchoolById);

// POST /api/schools - Create new school
router.post('/', requirePlatformOwner, schoolController.createSchool);

// PUT /api/schools/:id - Update school
router.put('/:id', requirePermission('school_setup'), schoolController.updateSchool);

// DELETE /api/schools/:id - Delete school
router.delete('/:id', requirePlatformOwner, schoolController.deleteSchool);

module.exports = router;
