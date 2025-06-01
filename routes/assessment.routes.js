// File: src/routes/assessment.routes.js

const express = require('express')
const {
  getAssessmentById,
  getAssessmentsByClass,
  createAssessment,
  updateAssessment,
  deleteAssessment,
} = require('../controllers/assessment.controller')

const router = express.Router()

router.get('/:id', getAssessmentById)
router.get('/class/:classId', getAssessmentsByClass)
router.post('/', createAssessment)
router.patch('/:id', updateAssessment)
router.delete('/:id', deleteAssessment)

module.exports = router
