// src/routes/dashboard.router.js

const express = require('express')
const router = express.Router()
const dashboardController = require('../controllers/dashboard.controller')
const { requirePermission, requireStaffAccess } = require('../middleware/access')

// Every staff dashboard reads these; the school average inside the summary
// is left out without analytics (controller).
router.use(requireStaffAccess)

router.get('/summary', dashboardController.getSummary)

router.get('/attendance/today', dashboardController.getTodaysAttendanceRate)

router.get('/attendance/weekly', dashboardController.getWeeklyAttendanceRate)

router.get('/attendance/monthly', dashboardController.getMonthlyAttendanceRate)

router.get('/attendance/trend', dashboardController.getAttendanceTrend);

router.post('/refresh-grade-cache', requirePermission('analytics'), dashboardController.refreshGradeCache);

module.exports = router
