// File: src/controllers/excludedAssessment.controller.js

const db = require('../config/database')
const excludedAssessmentQueries = require('../queries/excludedAssessment.queries')
const logger = require('../logger')

//
// 1) POST /excluded-assessments
// Create a new exclusion record
//
const createExclusion = async (req, res) => {
  const { studentId, classId, assessmentId } = req.body

  // Basic required field check
  if (!studentId || !classId || !assessmentId) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: studentId, classId, assessmentId',
    })
  }

  try {
    const { rows } = await db.query(excludedAssessmentQueries.createExclusion, [
      studentId,
      classId,
      assessmentId,
    ])

    if (rows.length === 0) {
      // Record already exists (ON CONFLICT DO NOTHING)
      return res.status(200).json({
        status: 'success',
        message: 'Exclusion already exists',
      })
    }

    const exclusion = rows[0]
    logger.info(`Assessment exclusion created for student ${studentId} in class ${classId}, assessment ${assessmentId}`)
    
    return res.status(201).json({
      status: 'success',
      data: {
        studentId: exclusion.student_id,
        classId: exclusion.class_id,
        assessmentId: exclusion.assessment_id,
        createdAt: exclusion.created_at,
      },
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error creating assessment exclusion' })
  }
}

//
// 2) DELETE /excluded-assessments/:studentId/:classId/:assessmentId
// Remove an exclusion record
//
const deleteExclusion = async (req, res) => {
  const { studentId, classId, assessmentId } = req.params

  try {
    const result = await db.query(excludedAssessmentQueries.deleteExclusion, [
      studentId,
      classId,
      assessmentId,
    ])

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'failed',
        message: 'Exclusion not found',
      })
    }

    logger.info(`Assessment exclusion deleted for student ${studentId} in class ${classId}, assessment ${assessmentId}`)
    
    return res.status(200).json({
      status: 'success',
      message: 'Assessment exclusion deleted successfully',
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error deleting assessment exclusion' })
  }
}

//
// 3) GET /excluded-assessments/:studentId/:classId
//   Get all excluded assessments for a student in a specific class
//
const getExclusionsByStudentAndClass = async (req, res) => {
  const { studentId, classId } = req.params

  try {
    const { rows } = await db.query(excludedAssessmentQueries.selectExclusionsByStudentAndClass, [
      studentId,
      classId,
    ])

    logger.info(`Fetched ${rows.length} exclusions for student ${studentId} in class ${classId}`)

    return res.status(200).json({
      status: 'success',
      data: rows.map((exclusion) => ({
        studentId: exclusion.student_id,
        classId: exclusion.class_id,
        assessmentId: exclusion.assessment_id,
        createdAt: exclusion.created_at,
      })),
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error fetching assessment exclusions' })
  }
}

//
// 4) GET /excluded-assessments/:studentId/:classId/:assessmentId/check
//   Check if specific assessment is excluded for student in class
//
const checkExclusion = async (req, res) => {
  const { studentId, classId, assessmentId } = req.params

  try {
    const { rows } = await db.query(excludedAssessmentQueries.checkExclusion, [
      studentId,
      classId,
      assessmentId,
    ])

    const isExcluded = rows.length > 0

    return res.status(200).json({
      status: 'success',
      data: {
        isExcluded,
      },
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error checking assessment exclusion' })
  }
}

module.exports = {
  createExclusion,
  deleteExclusion,
  getExclusionsByStudentAndClass,
  checkExclusion,
}