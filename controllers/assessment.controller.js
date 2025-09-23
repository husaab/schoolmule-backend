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
        assessmentId:       a.assessment_id,
        classId:            a.class_id,
        name:               a.name,
        weightPercent:      parseFloat(a.weight_percent),
        createdAt:          a.created_at,
        lastModifiedAt:     a.last_modified_at,
        parentAssessmentId: a.parent_assessment_id || null,
        isParent:           a.is_parent === true,
        sortOrder:          a.sort_order,
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
        assessmentId:       a.assessment_id,
        classId:            a.class_id,
        name:               a.name,
        weightPercent:      parseFloat(a.weight_percent),
        createdAt:          a.created_at,
        lastModifiedAt:     a.last_modified_at,
        parentAssessmentId: a.parent_assessment_id || null,
        isParent:           a.is_parent === true,
        sortOrder:          a.sort_order,
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
  const { 
    classId, 
    name, 
    weightPercent, 
    isParent = false, 
    childCount = 0,
    parentAssessmentId = null,
    sortOrder = null 
  } = req.body

  // Basic required‐field check
  if (!classId || !name || weightPercent == null) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: classId, name, weightPercent',
    })
  }

  try {
    // If creating a parent assessment with children
    if (isParent && childCount > 0) {
      return await createParentWithChildren(req, res)
    }

    // Create single assessment (parent or child or standalone)
    const vals = [
      classId,
      name.trim(),
      weightPercent,
      parentAssessmentId,
      isParent,
      sortOrder,
    ]
    const { rows } = await db.query(assessmentQueries.createAssessment, vals)

    const a = rows[0]
    logger.info(`Assessment created with id ${a.assessment_id}`)
    return res.status(201).json({
      status: 'success',
      data: {
        assessmentId:       a.assessment_id,
        classId:            a.class_id,
        name:               a.name,
        weightPercent:      parseFloat(a.weight_percent),
        createdAt:          a.created_at,
        lastModifiedAt:     a.last_modified_at,
        parentAssessmentId: a.parent_assessment_id || null,
        isParent:           a.is_parent === true,
        sortOrder:          a.sort_order,
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
// Helper function to create parent assessment with multiple children
//
const createParentWithChildren = async (req, res) => {
  const { classId, name, weightPercent, childCount, childrenData } = req.body

  if (!childCount || childCount < 1) {
    return res.status(400).json({
      status: 'failed',
      message: 'Child count must be at least 1 for parent assessments',
    })
  }

  // Validate childrenData if provided
  if (childrenData) {
    if (!Array.isArray(childrenData) || childrenData.length !== childCount) {
      return res.status(400).json({
        status: 'failed',
        message: 'Children data array length must match child count',
      })
    }

    // Validate each child's data
    for (const child of childrenData) {
      if (!child.name || !child.name.trim()) {
        return res.status(400).json({
          status: 'failed',
          message: 'All child assessment names are required',
        })
      }
      if (typeof child.weightPercent !== 'number' || child.weightPercent < 0 || child.weightPercent > 100) {
        return res.status(400).json({
          status: 'failed',
          message: 'Child weight percentages must be between 0 and 100',
        })
      }
    }

    // Check total weight doesn't exceed 100%
    const totalChildWeight = childrenData.reduce((sum, child) => sum + child.weightPercent, 0)
    if (totalChildWeight > 100) {
      return res.status(400).json({
        status: 'failed',
        message: `Child weights total ${totalChildWeight}% (must not exceed 100%)`,
      })
    }
  }

  const client = await db.getClient ? await db.getClient() : db
  
  try {
    if (client.query !== db.query) await client.query('BEGIN')

    // Create parent assessment
    const parentVals = [classId, name.trim(), weightPercent, null, true, null]
    const { rows: parentRows } = await client.query(
      assessmentQueries.createAssessment,
      parentVals
    )
    const parent = parentRows[0]

    // Create child assessments
    const children = []

    if (childrenData && childrenData.length > 0) {
      // Use custom children data
      for (let i = 0; i < childrenData.length; i++) {
        const child = childrenData[i]
        const childVals = [
          classId,
          child.name.trim(),
          child.weightPercent,
          parent.assessment_id,
          false,
          child.sortOrder || (i + 1),
        ]
        const { rows: childRows } = await client.query(
          assessmentQueries.createAssessment,
          childVals
        )
        children.push(childRows[0])
      }
    } else {
      // Use default equal weight distribution
      const childWeightPercent = 100 / childCount
      for (let i = 1; i <= childCount; i++) {
        const childName = `${name} ${i}`
        const childVals = [
          classId,
          childName,
          childWeightPercent,
          parent.assessment_id,
          false,
          i,
        ]
        const { rows: childRows } = await client.query(
          assessmentQueries.createAssessment,
          childVals
        )
        children.push(childRows[0])
      }
    }

    if (client.query !== db.query) await client.query('COMMIT')

    logger.info(`Parent assessment created with ${childCount} children`)
    return res.status(201).json({
      status: 'success',
      data: {
        parent: {
          assessmentId:       parent.assessment_id,
          classId:            parent.class_id,
          name:               parent.name,
          weightPercent:      parseFloat(parent.weight_percent),
          createdAt:          parent.created_at,
          lastModifiedAt:     parent.last_modified_at,
          parentAssessmentId: parent.parent_assessment_id || null,
          isParent:           parent.is_parent === true,
          sortOrder:          parent.sort_order,
        },
        children: children.map((c) => ({
          assessmentId:       c.assessment_id,
          classId:            c.class_id,
          name:               c.name,
          weightPercent:      parseFloat(c.weight_percent),
          createdAt:          c.created_at,
          lastModifiedAt:     c.last_modified_at,
          parentAssessmentId: c.parent_assessment_id || null,
          isParent:           c.is_parent === true,
          sortOrder:          c.sort_order,
        })),
      },
    })
  } catch (error) {
    if (client.query !== db.query) await client.query('ROLLBACK')
    logger.error(error)
    return res.status(500).json({
      status: 'failed',
      message: 'Error creating parent assessment with children',
    })
  } finally {
    if (client.release) client.release()
  }
}

//
// 4) (Optional) PATCH /assessments/:id
//    → Update an existing assessment
//
const updateAssessment = async (req, res) => {
  const { id } = req.params
  const { 
    classId, 
    name, 
    weightPercent, 
    parentAssessmentId, 
    isParent, 
    sortOrder 
  } = req.body

  // Note: you can allow partial update by passing null for missing fields
  const vals = [
    classId ?? null,
    name ?? null,
    weightPercent ?? null,
    parentAssessmentId ?? null,
    isParent ?? null,
    sortOrder ?? null,
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
        assessmentId:       a.assessment_id,
        classId:            a.class_id,
        name:               a.name,
        weightPercent:      parseFloat(a.weight_percent),
        createdAt:          a.created_at,
        lastModifiedAt:     a.last_modified_at,
        parentAssessmentId: a.parent_assessment_id || null,
        isParent:           a.is_parent === true,
        sortOrder:          a.sort_order,
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

//
// 6) GET /assessments/:parentId/children
//    → Get all child assessments for a parent
//
const getChildAssessments = async (req, res) => {
  const { parentId } = req.params

  try {
    const { rows } = await db.query(assessmentQueries.selectChildAssessments, [parentId])
    
    return res.status(200).json({
      status: 'success',
      data: rows.map((a) => ({
        assessmentId:       a.assessment_id,
        classId:            a.class_id,
        name:               a.name,
        weightPercent:      parseFloat(a.weight_percent),
        createdAt:          a.created_at,
        lastModifiedAt:     a.last_modified_at,
        parentAssessmentId: a.parent_assessment_id || null,
        isParent:           a.is_parent === true,
        sortOrder:          a.sort_order,
      })),
    })
  } catch (error) {
    logger.error(error)
    return res.status(500).json({
      status: 'failed',
      message: 'Error fetching child assessments',
    })
  }
}

module.exports = {
  getAssessmentById,
  getAssessmentsByClass,
  createAssessment,
  createParentWithChildren,
  updateAssessment,
  deleteAssessment,
  getChildAssessments,
}
