// File: src/routes/excludedAssessment.routes.js

const express = require('express')
const router = express.Router()
const {
  createExclusion,
  deleteExclusion,
  getExclusionsByStudentAndClass,
  checkExclusion,
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
// GET /api/excluded-assessments/:studentId/:classId
// Get all excluded assessments for a student in a specific class
//
router.get('/:studentId/:classId', getExclusionsByStudentAndClass)

//
// GET /api/excluded-assessments/:studentId/:classId/:assessmentId/check
// Check if specific assessment is excluded for student in class
//
router.get('/:studentId/:classId/:assessmentId/check', checkExclusion)

module.exports = router