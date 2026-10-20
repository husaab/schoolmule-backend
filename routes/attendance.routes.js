const express = require('express');
const {
  submitGeneralAttendance,
  submitClassAttendance,
  getGeneralAttendanceByDate,
  getClassAttendanceByDate
} = require('../controllers/attendance.controller');
const { requirePermission } = require('../middleware/access');
const requireClassOwnership = require('../middleware/requireClassOwnership');

const router = express.Router();

// General (daily) attendance is the whole school's: attendance.daily. Class
// attendance is open to whoever teaches the class, holders of
// attendance.classes (every class) and classes.all.
const dailyAttendance = requirePermission('attendance.daily');
const classAttendance = (classIdOf) =>
  requireClassOwnership.with({ keys: ['attendance.classes'], classIdOf });

router.post('/general', dailyAttendance, submitGeneralAttendance);
router.post('/class', classAttendance((req) => req.body && req.body.classId), submitClassAttendance);

router.get('/general', dailyAttendance, getGeneralAttendanceByDate);
router.get('/class/:classId', classAttendance((req) => req.params.classId), getClassAttendanceByDate);

module.exports = router;
