// src/routes/term.routes.js

const express = require('express');
const router = express.Router();
const termController = require('../controllers/term.controller');

// GET /api/terms?school=SCHOOL_ENUM - Get all terms for a school
router.get('/', termController.getTermsBySchool);

// GET /api/terms/school-id/:schoolId - Get all terms for a school by school_id
router.get('/school-id/:schoolId', termController.getTermsBySchoolId);

// GET /api/terms/active?school=SCHOOL_ENUM - Get active term for a school
router.get('/active', termController.getActiveTermBySchool);

// GET /api/terms/current?school=SCHOOL_ENUM&date=YYYY-MM-DD - Get current term by date
router.get('/current', termController.getCurrentTermBySchool);

// GET /api/terms/academic-year?school=SCHOOL_ENUM&year=2024-2025 - Get terms for academic year
router.get('/academic-year', termController.getTermsByAcademicYear);

// GET /api/terms/:id - Get term by ID
router.get('/:id', termController.getTermById);

// POST /api/terms - Create new term
router.post('/', termController.createTerm);

// PUT /api/terms/:id - Update term
router.put('/:id', termController.updateTerm);

// PUT /api/terms/:id/activate - Set term as active
router.put('/:id/activate', termController.activateTerm);

// PUT /api/terms/:id/status - Update term status (active/inactive)
router.put('/:id/status', termController.updateTermStatus);

// DELETE /api/terms/:id - Delete term
router.delete('/:id', termController.deleteTerm);

module.exports = router;