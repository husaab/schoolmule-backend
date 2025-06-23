const db = require('../config/database');
const attendanceQueries = require('../queries/attendance.queries');
const logger = require('../logger');

// POST /attendance/general
// POST /attendance/general
// Body: { attendanceDate, entries: [{ studentId, status }], school }
const submitGeneralAttendance = async (req, res) => {
  const { attendanceDate, entries, school } = req.body;
  if (!attendanceDate || !Array.isArray(entries) || !school) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: attendanceDate, entries[], school',
    });
  }

  const studentIds = entries.map(e => e.studentId);
  const statuses   = entries.map(e => e.status);

  try {
    await db.query(attendanceQueries.insertGeneralAttendance, [
      studentIds,
      attendanceDate,
      statuses,
      school
    ]);

    logger.info(`General attendance for ${studentIds.length} students at ${school}`);
    res.json({ status: 'success', message: 'Attendance recorded' });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ status: 'failed', message: 'Database error' });
  }
};

// POST /attendance/class
const submitClassAttendance = async (req, res) => {
  const { classId, attendanceDate, entries } = req.body;

  if (!classId || !attendanceDate || !Array.isArray(entries)) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: classId, attendanceDate, entries[]',
    });
  }

  const studentIds = [];
  const statuses = [];

  for (const entry of entries) {
    if (entry.studentId && entry.status) {
      studentIds.push(entry.studentId);
      statuses.push(entry.status);
    }
  }

  try {
    await db.query(attendanceQueries.insertClassAttendance, [
      classId,
      studentIds,
      attendanceDate,
      statuses,
    ]);

    logger.info(`Class attendance submitted for ${studentIds.length} students in class ${classId}`);
    return res.status(200).json({ status: 'success', message: 'Class attendance recorded' });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Database error' });
  }
};

const getGeneralAttendanceByDate = async (req, res) => {
  const { date, school } = req.query;
  if (!date || !school) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required query params: date, school',
    });
  }

  try {
    const { rows } = await db.query(
      attendanceQueries.selectGeneralAttendanceByDate,
      [date, school]
    );
    res.json({
      status: 'success',
      data: rows.map(r => ({
        studentId: r.student_id,
        status:    r.status,
      }))
    });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ status: 'failed', message: 'Database error' });
  }
};


// GET /attendance/class/:classId?date=YYYY-MM-DD
const getClassAttendanceByDate = async (req, res) => {
  const { classId } = req.params;
  const { date } = req.query;

  if (!classId || !date) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required params: classId and/or date',
    });
  }

  try {
    const { rows } = await db.query(attendanceQueries.selectClassAttendanceByDate, [classId, date]);
    return res.status(200).json({
      status: 'success',
      data: rows.map(row => ({
        studentId: row.student_id,
        status: row.status,
      })),
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Database error' });
  }
};

module.exports = {
  submitGeneralAttendance,
  submitClassAttendance,
  getGeneralAttendanceByDate,
  getClassAttendanceByDate,
};
