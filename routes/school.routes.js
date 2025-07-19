// src/routes/school.routes.js

const express = require('express');
const router = express.Router();
const schoolController = require('../controllers/school.controller');

// GET /api/schools - Get all schools
router.get('/', schoolController.getAllSchools);

// GET /api/schools/:code - Get school by code (enum)
router.get('/:code', schoolController.getSchoolByCode);

// GET /api/schools/id/:id - Get school by ID
router.get('/id/:id', schoolController.getSchoolById);

// POST /api/schools - Create new school
router.post('/', schoolController.createSchool);

// PUT /api/schools/:id - Update school
router.put('/:id', schoolController.updateSchool);

// DELETE /api/schools/:id - Delete school
router.delete('/:id', schoolController.deleteSchool);

module.exports = router;