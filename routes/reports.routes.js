const express = require("express");
const { generateStudentSummaryReport, generateStudentTermSummaryReport } = require("../controllers/reports.controller");
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

// POST /api/reports/student-summary/:studentId?termId=&orientation=
// Every class the student is in that term, in one PDF. The controller keeps
// only the classes the caller may see (taught by them, classes.all, or
// report_cards), so there are no class ids to check here.
router.post("/student-summary/:studentId", generateStudentTermSummaryReport);

module.exports = router;
