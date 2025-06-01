// File: src/controllers/assessment.controller.js

const db = require('../config/database')
const assessmentQueries = require('../queries/assessment.queries')
const logger = require('../logger')

//
// 1) GET /assessments/:id
//    → Fetch a single assessment by ID
//
const getAssessmentById = async (req, res) => {
  const { id } = req.params

  try {
    const { rows } = await db.query(assessmentQueries.selectAssessmentById, [id])
    if (rows.length === 0) {
      return res.status(404).json({
        status: 'failed',
        message: `Assessment with id ${id} not found`,
      })
    }

    const a = rows[0]
    return res.status(200).json({
      status: 'success',
      data: {
        assessmentId:   a.assessment_id,
        classId:        a.class_id,
        name:           a.name,
        weightPercent:  parseFloat(a.weight_percent),
        createdAt:      a.created_at,
        lastModifiedAt: a.last_modified_at,
      },
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error fetching assessment' })
  }
}

//
// 2) GET /assessments/class/:classId
//    → List all assessments for a given class
//
const getAssessmentsByClass = async (req, res) => {
  const { classId } = req.params

  try {
    const { rows } = await db.query(
      assessmentQueries.selectAssessmentsByClass,
      [classId]
    )
    logger.info(`Fetched ${rows.length} assessments for class ${classId}`)

    return res.status(200).json({
      status: 'success',
      data: rows.map((a) => ({
        assessmentId:   a.assessment_id,
        classId:        a.class_id,
        name:           a.name,
        weightPercent:  parseFloat(a.weight_percent),
        createdAt:      a.created_at,
        lastModifiedAt: a.last_modified_at,
      })),
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error fetching assessments for class' })
  }
}

//
// 3) POST /assessments
//    → Create a new assessment
//
const createAssessment = async (req, res) => {
  const { classId, name, weightPercent } = req.body

  // Basic required‐field check
  if (!classId || !name || weightPercent == null) {
    return res.status(400).json({
      status: 'failed',
      message:
        'Missing required fields: classId, name, weightPercent',
    })
  }

  try {
    const vals = [
      classId,
      name.trim(),
      weightPercent,
    ]
    const { rows } = await db.query(
      assessmentQueries.createAssessment,
      vals
    )

    const a = rows[0]
    logger.info(`Assessment created with id ${a.assessment_id}`)
    return res.status(201).json({
      status: 'success',
      data: {
        assessmentId:   a.assessment_id,
        classId:        a.class_id,
        name:           a.name,
        weightPercent:  parseFloat(a.weight_percent),
        createdAt:      a.created_at,
        lastModifiedAt: a.last_modified_at,
      },
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error creating assessment' })
  }
}

//
// 4) (Optional) PATCH /assessments/:id
//    → Update an existing assessment
//
const updateAssessment = async (req, res) => {
  const { id } = req.params
  const { classId, name, weightPercent } = req.body

  // Note: you can allow partial update by passing null for missing fields
  const vals = [
    classId ?? null,
    name ?? null,
    weightPercent ?? null,
    id,
  ]

  try {
    const { rows, rowCount } = await db.query(
      assessmentQueries.updateAssessmentById,
      vals
    )

    if (rowCount === 0) {
      return res.status(404).json({
        status: 'failed',
        message: `Assessment with id ${id} not found`,
      })
    }

    const a = rows[0]
    logger.info(`Assessment ${id} updated`)
    return res.status(200).json({
      status: 'success',
      data: {
        assessmentId:   a.assessment_id,
        classId:        a.class_id,
        name:           a.name,
        weightPercent:  parseFloat(a.weight_percent),
        createdAt:      a.created_at,
        lastModifiedAt: a.last_modified_at,
      },
    })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error updating assessment' })
  }
}

//
// 5) (Optional) DELETE /assessments/:id
//    → Delete an assessment
//
const deleteAssessment = async (req, res) => {
  const { id } = req.params

  try {
    const result = await db.query(
      assessmentQueries.deleteAssessmentById,
      [id]
    )
    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'failed',
        message: `Assessment with id ${id} not found`,
      })
    }

    logger.info(`Assessment ${id} deleted`)
    return res
      .status(200)
      .json({ status: 'success', message: 'Assessment deleted successfully' })
  } catch (error) {
    logger.error(error)
    return res
      .status(500)
      .json({ status: 'failed', message: 'Error deleting assessment' })
  }
}

module.exports = {
  getAssessmentById,
  getAssessmentsByClass,
  createAssessment,
  updateAssessment,
  deleteAssessment,
}
