/*
  controllers/tuitionPlan.controller.js
  Controller for tuition plan management operations
*/

const db = require("../config/database");
const tuitionPlanQueries = require("../queries/tuitionPlan.queries");
const logger = require("../logger");

// Convert database row to camelCase
const toCamel = row => ({
  planId: row.plan_id,
  school: row.school,
  grade: row.grade,
  amount: row.amount,
  frequency: row.frequency,
  effectiveFrom: row.effective_from,
  effectiveTo: row.effective_to,
  createdAt: row.created_at,
  lastModifiedAt: row.last_modified_at
});

// GET /api/tuition-plans?school=<school>
const getTuitionPlansBySchool = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionPlanQueries.selectTuitionPlansBySchool, [school]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching tuition plans" 
    });
  }
};

// GET /api/tuition-plans/active?school=<school>
const getActiveTuitionPlansBySchool = async (req, res) => {
  const { school } = req.query;
  if (!school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing query parameter: school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionPlanQueries.selectActiveTuitionPlansBySchool, [school]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching active tuition plans" 
    });
  }
};

// GET /api/tuition-plans/:planId
const getTuitionPlanById = async (req, res) => {
  const { planId } = req.params;
  if (!planId) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameter: planId" 
    });
  }

  try {
    const { rows } = await db.query(tuitionPlanQueries.selectTuitionPlanById, [planId]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition plan not found" 
      });
    }
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching tuition plan" 
    });
  }
};

// GET /api/tuition-plans/grade/:grade?school=<school>
const getTuitionPlansBySchoolAndGrade = async (req, res) => {
  const { grade } = req.params;
  const { school } = req.query;
  
  if (!grade || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing parameters: grade and school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionPlanQueries.selectTuitionPlansBySchoolAndGrade, [school, grade]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error fetching tuition plans by grade" 
    });
  }
};

// POST /api/tuition-plans
const createTuitionPlan = async (req, res) => {
  const {
    school, grade, amount, frequency, effectiveFrom, effectiveTo
  } = req.body;

  if (!school || !grade || amount === undefined || !frequency || !effectiveFrom) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing required fields: school, grade, amount, frequency, effectiveFrom" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionPlanQueries.insertTuitionPlan,
      [
        school, grade, amount, frequency, effectiveFrom, effectiveTo || null
      ]
    );

    logger.info(`Tuition plan created for ${school} grade ${grade}: $${amount}`);
    return res.status(201).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error creating tuition plan" 
    });
  }
};

// PATCH /api/tuition-plans/:planId
const updateTuitionPlan = async (req, res) => {
  const { planId } = req.params;
  const {
    school, grade, amount, frequency, effectiveFrom, effectiveTo
  } = req.body;

  if (!planId || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing planId or school" 
    });
  }

  try {
    const { rows } = await db.query(
      tuitionPlanQueries.updateTuitionPlanById,
      [
        planId, grade, amount, frequency, effectiveFrom, effectiveTo, school
      ]
    );

    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition plan not found or unauthorized" 
      });
    }

    logger.info(`Tuition plan updated: ${planId}`);
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error updating tuition plan" 
    });
  }
};

// DELETE /api/tuition-plans/:planId
const deleteTuitionPlan = async (req, res) => {
  const { planId } = req.params;
  const { school } = req.body;

  if (!planId || !school) {
    return res.status(400).json({ 
      status: "failed", 
      message: "Missing planId or school" 
    });
  }

  try {
    const { rows } = await db.query(tuitionPlanQueries.deleteTuitionPlanById, [planId, school]);
    if (rows.length === 0) {
      return res.status(404).json({ 
        status: "failed", 
        message: "Tuition plan not found or unauthorized" 
      });
    }

    logger.info(`Tuition plan deleted: ${planId}`);
    return res.status(200).json({ 
      status: "success", 
      message: "Tuition plan deleted" 
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ 
      status: "failed", 
      message: "Error deleting tuition plan" 
    });
  }
};

module.exports = {
  getTuitionPlansBySchool,
  getActiveTuitionPlansBySchool,
  getTuitionPlanById,
  getTuitionPlansBySchoolAndGrade,
  createTuitionPlan,
  updateTuitionPlan,
  deleteTuitionPlan
};