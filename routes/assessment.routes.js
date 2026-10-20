// File: src/routes/assessment.routes.js

const express = require('express')
const {
  getAssessmentById,
  getAssessmentsByClass,
  createAssessment,
  updateAssessment,
  deleteAssessment,
  batchUpdateAssessments,
} = require('../controllers/assessment.controller')

const { requireStaffAccess } = require('../middleware/access')
const requireClassOwnership = require('../middleware/requireClassOwnership')
const requireGradebookAccess = require('../middleware/requireGradebookAccess')

const router = express.Router()

// RBAC: a class's assessments are its gradebook. Every class the request
// names (by id, or through an assessment) must be one the caller teaches or
// may open through classes.all.
router.use(requireStaffAccess)
const ids = (list, key) => (Array.isArray(list) ? list.map((x) => x && x[key]) : [])
const byAssessment = requireGradebookAccess({ assessmentIds: (req) => [req.params.id] })

router.get('/:id', byAssessment, getAssessmentById)
router.get('/class/:classId', requireClassOwnership, getAssessmentsByClass)
router.post('/', requireGradebookAccess({ classIds: (req) => [req.body && req.body.classId] }), createAssessment)
router.patch('/batch', requireGradebookAccess({
  assessmentIds: (req) => [...ids(req.body && req.body.updates, 'assessmentId'), ...((req.body && req.body.deleteIds) || [])],
  classIds: (req) => ids(req.body && req.body.creates, 'classId'),
}), batchUpdateAssessments)
// A body classId moves the assessment: the target class is checked too.
router.patch('/:id', requireGradebookAccess({
  assessmentIds: (req) => [req.params.id],
  classIds: (req) => [req.body && req.body.classId],
}), updateAssessment)
router.delete('/:id', byAssessment, deleteAssessment)

module.exports = router
