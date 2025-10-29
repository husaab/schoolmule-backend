// File: src/routes/excludedAssessment.routes.js

const express = require('express')
const router = express.Router()
const {
  createExclusion,
  deleteExclusion,
  getExclusionsByStudentAndClass,
  checkExclusion,
  getExclusionsByClass,
} = require('../controllers/excludedAssessment.controller')

//
// POST /api/excluded-assessments
// Create a new assessment exclusion
//
router.post('/', createExclusion)

//
// DELETE /api/excluded-assessments/:studentId/:classId/:assessmentId
// Remove an assessment exclusion
//
router.delete('/:studentId/:classId/:assessmentId', deleteExclusion)

//
// GET /api/excluded-assessments/class/:classId
// Get all excluded assessments for an entire class (PUT THIS FIRST - more specific)
//
router.get('/class/:classId', getExclusionsByClass)

//
// GET /api/excluded-assessments/:studentId/:classId/:assessmentId/check
// Check if specific assessment is excluded for student in class
//
router.get('/:studentId/:classId/:assessmentId/check', checkExclusion)

//
// GET /api/excluded-assessments/:studentId/:classId
// Get all excluded assessments for a student in a specific class
//
router.get('/:studentId/:classId', getExclusionsByStudentAndClass)

module.exports = router