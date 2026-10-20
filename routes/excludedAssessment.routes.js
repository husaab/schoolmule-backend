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
const { requireStaffAccess } = require('../middleware/access')
const requireClassOwnership = require('../middleware/requireClassOwnership')

// RBAC: exclusions are gradebook data of one class: its teachers or classes.all.
router.use(requireStaffAccess)
const bodyClass = requireClassOwnership.with({ classIdOf: (req) => req.body && req.body.classId })

//
// POST /api/excluded-assessments
// Create a new assessment exclusion
//
router.post('/', bodyClass, createExclusion)

//
// DELETE /api/excluded-assessments/:studentId/:classId/:assessmentId
// Remove an assessment exclusion
//
router.delete('/:studentId/:classId/:assessmentId', requireClassOwnership, deleteExclusion)

//
// GET /api/excluded-assessments/class/:classId
// Get all excluded assessments for an entire class (PUT THIS FIRST - more specific)
//
router.get('/class/:classId', requireClassOwnership, getExclusionsByClass)

//
// GET /api/excluded-assessments/:studentId/:classId/:assessmentId/check
// Check if specific assessment is excluded for student in class
//
router.get('/:studentId/:classId/:assessmentId/check', requireClassOwnership, checkExclusion)

//
// GET /api/excluded-assessments/:studentId/:classId
// Get all excluded assessments for a student in a specific class
//
router.get('/:studentId/:classId', requireClassOwnership, getExclusionsByStudentAndClass)

module.exports = router