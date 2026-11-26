const db = require('../config/database');
const attendanceQueries = require('../queries/attendance.queries');
const logger = require('../logger');

// Splits a save into the marks to record and the students whose mark was
// cleared. A student with a mark in `entries` is never also removed.
const splitSave = (entries, cleared) => {
  const studentIds = [];
  const statuses = [];
  for (const entry of entries) {
    if (entry && entry.studentId && entry.status) {
      studentIds.push(entry.studentId);
      statuses.push(entry.status);
    }
  }
  const marked = new Set(studentIds);
  const clearedIds = Array.isArray(cleared)
    ? [...new Set(cleared.filter((id) => typeof id === 'string' && id && !marked.has(id)))]
    : [];
  return { studentIds, statuses, clearedIds };
};

// POST /attendance/general
// Body: { attendanceDate, entries: [{ studentId, status }], cleared?: [studentId] }.
// `cleared` lists students whose mark for the day is removed. The school is
// always the caller's (a `school` in the body is ignored).
const submitGeneralAttendance = async (req, res) => {
  const { attendanceDate, entries, cleared } = req.body;
  const { school } = req.user;
  if (!attendanceDate || !Array.isArray(entries)) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: attendanceDate, entries[]',
    });
  }

  const { studentIds, statuses, clearedIds } = splitSave(entries, cleared);

  try {
    await db.query(attendanceQueries.saveGeneralAttendance, [
      studentIds,
      attendanceDate,
      statuses,
      school,
      clearedIds,
    ]);

    logger.info(`General attendance for ${studentIds.length} students at ${school} (${clearedIds.length} cleared)`);
    res.json({ status: 'success', message: 'Attendance recorded' });
  } catch (error) {
    logger.error(error);
    res.status(500).json({ status: 'failed', message: 'Database error' });
  }
};

// POST /attendance/class
// Body: { classId, attendanceDate, entries: [{ studentId, status }], cleared?: [studentId] }.
const submitClassAttendance = async (req, res) => {
  const { classId, attendanceDate, entries, cleared } = req.body;

  if (!classId || !attendanceDate || !Array.isArray(entries)) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required fields: classId, attendanceDate, entries[]',
    });
  }

  const { studentIds, statuses, clearedIds } = splitSave(entries, cleared);

  try {
    await db.query(attendanceQueries.saveClassAttendance, [
      classId,
      studentIds,
      attendanceDate,
      statuses,
      clearedIds,
    ]);

    logger.info(`Class attendance submitted for ${studentIds.length} students in class ${classId} (${clearedIds.length} cleared)`);
    return res.status(200).json({ status: 'success', message: 'Class attendance recorded' });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Database error' });
  }
};

// GET /attendance/general?date=  (school from the token; ?school= is ignored)
const getGeneralAttendanceByDate = async (req, res) => {
  const { date } = req.query;
  const { school } = req.user;
  if (!date) {
    return res.status(400).json({
      status: 'failed',
      message: 'Missing required query param: date',
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
