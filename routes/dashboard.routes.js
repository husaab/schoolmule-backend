// src/routes/dashboard.router.js

const express = require('express')
const router = express.Router()
const dashboardController = require('../controllers/dashboard.controller')

router.get('/summary', dashboardController.getSummary)

router.get('/attendance/today', dashboardController.getTodaysAttendanceRate)

router.get('/attendance/weekly', dashboardController.getWeeklyAttendanceRate)

router.get('/attendance/monthly', dashboardController.getMonthlyAttendanceRate)

router.get('/attendance/trend', dashboardController.getAttendanceTrend);

router.get('/financial', dashboardController.getFinancialOverview);

router.post('/refresh-grade-cache', dashboardController.refreshGradeCache);

module.exports = router
