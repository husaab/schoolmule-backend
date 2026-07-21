// routes/parentPortal.routes.js

const express = require('express');
const requireParent = require('../middleware/requireParent');
const verifyParentOwnsStudent = require('../middleware/verifyParentOwnsStudent');
const {
  getSummary,
  getStudentGrades,
  getStudentAttendance,
  getStudentFeedback,
  getCalendar,
} = require('../controllers/parentPortal.controller');

const router = express.Router();

router.use(requireParent);

router.get('/summary', getSummary);
router.get('/calendar', getCalendar);

router.get('/students/:studentId/grades', verifyParentOwnsStudent, getStudentGrades);
router.get('/students/:studentId/attendance', verifyParentOwnsStudent, getStudentAttendance);
router.get('/students/:studentId/feedback', verifyParentOwnsStudent, getStudentFeedback);

module.exports = router;
