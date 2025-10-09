const express = require("express");
const { generateStudentSummaryReport } = require("../controllers/reports.controller");

const router = express.Router();

// POST /api/reports/student-summary/:studentId/:classId
router.post("/student-summary/:studentId/:classId", generateStudentSummaryReport);

module.exports = router;