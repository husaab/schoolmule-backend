const express = require("express");
const { generateStudentSummaryReport } = require("../controllers/reports.controller");
const { requireStaffAccess } = require("../middleware/access");
const requireGradebookAccess = require("../middleware/requireGradebookAccess");

const router = express.Router();

// RBAC: a student's summary in one class: that class's teachers, or
// report_cards (school-wide reports). The controller checks enrollment.
router.use(requireStaffAccess);

// POST /api/reports/student-summary/:studentId/:classId
router.post(
  "/student-summary/:studentId/:classId",
  requireGradebookAccess({ keys: ["report_cards"], classIds: (req) => [req.params.classId] }),
  generateStudentSummaryReport,
);

module.exports = router;
