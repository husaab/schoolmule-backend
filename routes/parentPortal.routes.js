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
  getRecentPublications,
  markPublicationsSeen,
  getWeeklySummary,
} = require('../controllers/parentPortal.controller');

const router = express.Router();

router.use(requireParent);

router.get('/summary', getSummary);
router.get('/calendar', getCalendar);
router.get('/recent-publications', getRecentPublications);
router.post('/recent-publications/seen', markPublicationsSeen);

router.get('/students/:studentId/grades', verifyParentOwnsStudent, getStudentGrades);
router.get('/students/:studentId/attendance', verifyParentOwnsStudent, getStudentAttendance);
router.get('/students/:studentId/feedback', verifyParentOwnsStudent, getStudentFeedback);
router.get('/students/:studentId/weekly-summary', verifyParentOwnsStudent, getWeeklySummary);

module.exports = router;
