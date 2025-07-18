/*
  routes/tuitionPlan.routes.js
  Routes for tuition plan management
*/

const express = require('express');
const router = express.Router();
const tuitionPlanController = require('../controllers/tuitionPlan.controller');

// GET /api/tuition-plans?school=<school> - Get all tuition plans for a school
router.get('/', tuitionPlanController.getTuitionPlansBySchool);

// GET /api/tuition-plans/active?school=<school> - Get active tuition plans for a school
router.get('/active', tuitionPlanController.getActiveTuitionPlansBySchool);

// GET /api/tuition-plans/grade/:grade?school=<school> - Get tuition plans by school and grade
router.get('/grade/:grade', tuitionPlanController.getTuitionPlansBySchoolAndGrade);

// GET /api/tuition-plans/:planId - Get specific tuition plan
router.get('/:planId', tuitionPlanController.getTuitionPlanById);

// POST /api/tuition-plans - Create new tuition plan
router.post('/', tuitionPlanController.createTuitionPlan);

// PATCH /api/tuition-plans/:planId - Update tuition plan
router.patch('/:planId', tuitionPlanController.updateTuitionPlan);

// DELETE /api/tuition-plans/:planId - Delete tuition plan
router.delete('/:planId', tuitionPlanController.deleteTuitionPlan);

module.exports = router;