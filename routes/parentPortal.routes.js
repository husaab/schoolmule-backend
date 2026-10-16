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
const classroom = require('../controllers/parentClassroom.controller');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireParent);

// A malformed class id is "not in this class", never a 500.
router.param('classId', (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(404).json({ status: 'failed', code: 'NOT_ENROLLED', message: "This student isn't in this class" });
  }
  next();
});

router.get('/summary', getSummary);
router.get('/calendar', getCalendar);
router.get('/recent-publications', getRecentPublications);
router.post('/recent-publications/seen', markPublicationsSeen);

router.get('/students/:studentId/grades', verifyParentOwnsStudent, getStudentGrades);
router.get('/students/:studentId/attendance', verifyParentOwnsStudent, getStudentAttendance);
router.get('/students/:studentId/feedback', verifyParentOwnsStudent, getStudentFeedback);
router.get('/students/:studentId/weekly-summary', verifyParentOwnsStudent, getWeeklySummary);

// Classes: "Needs you" + a card per child, and the read-only lens into one
// child's classes (the student portal's read model, with the parent reading).
const lensChild = [verifyParentOwnsStudent, classroom.requireLensChild];
router.get('/classroom/summary', classroom.getClassroomSummary);
router.get('/students/:studentId/classroom/classes', ...lensChild, classroom.listLensClasses);
router.get('/students/:studentId/classroom/classes/:classId', ...lensChild, classroom.requireLensClass, classroom.getLensClass);
router.get('/students/:studentId/classroom/classes/:classId/stream', ...lensChild, classroom.requireLensClass, classroom.getLensStream);
router.get('/students/:studentId/classroom/grades', ...lensChild, classroom.getLensGrades);

module.exports = router;
