// File: src/controllers/excludedAssessment.controller.js
//
// Legacy exclusion API kept for older clients. "Excluded" now means the
// cell status 'excused' on student_assessments (see services/gradeEngine.js);
// writes go through applyCellStatus so a category id excuses every child.

const db = require('../config/database')
const excludedAssessmentQueries = require('../queries/excludedAssessment.queries')
const { applyCellStatus } = require('./studentAssessment.controller')
const logger = require('../logger')

const mapRow = (r) => ({
  studentId: r.student_id,
  classId: r.class_id,
  assessmentId: r.assessment_id,
  assessmentName: r.assessment_name,
  createdAt: r.created_at || null,
})

// POST /excluded-assessments  { studentId, classId, assessmentId }
const createExclusion = async (req, res) => {
  const { studentId, classId, assessmentId } = req.body

  if (!studentId || !classId || !assessmentId) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: studentId, classId, assessmentId',
    })
  }

  try {
    const rows = await applyCellStatus({ classId, studentId, assessmentId, status: 'excused' })
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Assessment not found in this class' })
    }
    logger.info(`Assessment excused for student ${studentId} in class ${classId}, assessment ${assessmentId}`)
    return res.status(201).json({
      status: 'success',
      data: { studentId, classId, assessmentId, cells: rows },
    })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ status: 'failed', message: 'Error creating assessment exclusion' })
  }
}

// DELETE /excluded-assessments/:studentId/:classId/:assessmentId
const deleteExclusion = async (req, res) => {
  const { studentId, classId, assessmentId } = req.params

  try {
    const { rows: existing } = await db.query(excludedAssessmentQueries.checkExclusion, [
      studentId,
      classId,
      assessmentId,
    ])
    const rows = await applyCellStatus({ classId, studentId, assessmentId, status: 'graded' })
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Exclusion not found' })
    }
    if (existing.length === 0 && rows.every((r) => r.status === 'graded')) {
      // Category id or already-clear cell: still a successful no-op for callers.
    }
    logger.info(`Assessment excuse cleared for student ${studentId} in class ${classId}, assessment ${assessmentId}`)
    return res.status(200).json({ status: 'success', message: 'Assessment exclusion deleted successfully' })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ status: 'failed', message: 'Error deleting assessment exclusion' })
  }
}

// GET /excluded-assessments/:studentId/:classId
const getExclusionsByStudentAndClass = async (req, res) => {
  const { studentId, classId } = req.params
  try {
    const { rows } = await db.query(excludedAssessmentQueries.selectExclusionsByStudentAndClass, [studentId, classId])
    return res.status(200).json({ status: 'success', data: rows.map(mapRow) })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ status: 'failed', message: 'Error fetching assessment exclusions' })
  }
}

// GET /excluded-assessments/:studentId/:classId/:assessmentId/check
const checkExclusion = async (req, res) => {
  const { studentId, classId, assessmentId } = req.params
  try {
    const { rows } = await db.query(excludedAssessmentQueries.checkExclusion, [studentId, classId, assessmentId])
    return res.status(200).json({ status: 'success', data: { isExcluded: rows.length > 0 } })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ status: 'failed', message: 'Error checking assessment exclusion' })
  }
}

// GET /excluded-assessments/class/:classId
const getExclusionsByClass = async (req, res) => {
  const { classId } = req.params
  try {
    const { rows } = await db.query(excludedAssessmentQueries.selectExclusionsByClass, [classId])
    return res.status(200).json({ status: 'success', data: rows.map(mapRow) })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({ status: 'failed', message: 'Error fetching class assessment exclusions' })
  }
}

module.exports = {
  createExclusion,
  deleteExclusion,
  getExclusionsByStudentAndClass,
  checkExclusion,
  getExclusionsByClass,
}
