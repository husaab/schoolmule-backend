const express = require('express');
const {
  submitGeneralAttendance,
  submitClassAttendance,
  getGeneralAttendanceByDate,
  getClassAttendanceByDate
} = require('../controllers/attendance.controller');

const router = express.Router();

router.post('/general', submitGeneralAttendance);
router.post('/class', submitClassAttendance);

router.get('/general', getGeneralAttendanceByDate);
router.get('/class/:classId', getClassAttendanceByDate);

module.exports = router;
