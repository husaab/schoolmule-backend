const db = require("../config/database");
const teacherAttendanceQueries = require("../queries/teacher-attendance.queries");
const logger = require("../logger");
const { createPDFBuffer } = require("../utils/pdfGenerator");
const { getStaffAttendanceHTML } = require("../templates/staffAttendanceTemplate");

// GET /today
const getTodayStatus = async (req, res) => {
  try {
    const { userId } = req.user;
    const { rows } = await db.query(teacherAttendanceQueries.selectTodayStatus, [userId]);

    return res.status(200).json({
      status: "success",
      data: {
        checkedIn: rows.length > 0,
        status: rows.length > 0 ? rows[0].status : null,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to get today's status" });
  }
};

// POST /checkin
const checkIn = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { status } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return res.status(400).json({ status: "failed", message: "Status must be PRESENT or ABSENT" });
    }

    const { rows } = await db.query(teacherAttendanceQueries.upsertCheckin, [userId, status, school]);

    return res.status(200).json({
      status: "success",
      data: {
        teacherId: rows[0].teacher_id,
        attendanceDate: rows[0].attendance_date,
        status: rows[0].status,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to check in" });
  }
};

// GET /me?month=YYYY-MM
const getMyMonth = async (req, res) => {
  try {
    const { userId } = req.user;
    const { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ status: "failed", message: "month query param required (YYYY-MM)" });
    }

    const [recordsResult, workingDaysResult] = await Promise.all([
      db.query(teacherAttendanceQueries.selectMyMonth, [userId, month]),
      db.query(teacherAttendanceQueries.selectWorkingDays, [month]),
    ]);

    const records = recordsResult.rows.map((r) => ({
      attendanceDate: r.attendance_date,
      status: r.status,
    }));

    const workingDays = workingDaysResult.rows[0].working_days;
    const presentDays = records.filter((r) => r.status === "PRESENT").length;

    return res.status(200).json({
      status: "success",
      data: { records, workingDays, presentDays, absentDays: records.filter((r) => r.status === "ABSENT").length },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to get monthly records" });
  }
};

// PATCH /me/:date
const updateMyRecord = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { date } = req.params;
    const { status } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return res.status(400).json({ status: "failed", message: "Status must be PRESENT or ABSENT" });
    }

    const { rows } = await db.query(teacherAttendanceQueries.updateMyRecord, [userId, date, status, school]);

    return res.status(200).json({
      status: "success",
      data: {
        teacherId: rows[0].teacher_id,
        attendanceDate: rows[0].attendance_date,
        status: rows[0].status,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to update record" });
  }
};

// GET /?school=X&month=YYYY-MM (admin)
const getAllForSchoolMonth = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }

    const { school, month } = req.query;

    if (!school || !month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ status: "failed", message: "school and month (YYYY-MM) query params required" });
    }

    const [dataResult, workingDaysResult] = await Promise.all([
      db.query(teacherAttendanceQueries.selectAllForSchoolMonth, [month, school]),
      db.query(teacherAttendanceQueries.selectWorkingDays, [month]),
    ]);

    const workingDays = workingDaysResult.rows[0].working_days;

    // Group records by teacher
    const teacherMap = {};
    dataResult.rows.forEach((row) => {
      const tid = row.teacher_id;
      if (!teacherMap[tid]) {
        teacherMap[tid] = {
          teacherId: tid,
          firstName: row.first_name,
          lastName: row.last_name,
          username: row.username,
          records: [],
        };
      }
      if (row.attendance_date) {
        teacherMap[tid].records.push({
          attendanceDate: row.attendance_date,
          status: row.status,
        });
      }
    });

    const teachers = Object.values(teacherMap);

    return res.status(200).json({
      status: "success",
      data: { teachers, workingDays },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to get school attendance" });
  }
};

// PATCH /:teacherId/:date (admin)
const updateAnyRecord = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }

    const { teacherId, date } = req.params;
    const { status } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return res.status(400).json({ status: "failed", message: "Status must be PRESENT or ABSENT" });
    }

    const { rows } = await db.query(teacherAttendanceQueries.updateAnyRecord, [teacherId, date, status, req.user.school]);

    return res.status(200).json({
      status: "success",
      data: {
        teacherId: rows[0].teacher_id,
        attendanceDate: rows[0].attendance_date,
        status: rows[0].status,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to update record" });
  }
};

// GET /pdf?school=X&month=YYYY-MM&teacherId= (admin)
const downloadPDF = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }

    const { school, month, teacherId } = req.query;

    if (!school || !month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ status: "failed", message: "school and month (YYYY-MM) query params required" });
    }

    const [dataResult, workingDaysResult] = await Promise.all([
      db.query(teacherAttendanceQueries.selectAllForSchoolMonth, [month, school]),
      db.query(teacherAttendanceQueries.selectWorkingDays, [month]),
    ]);

    const workingDays = workingDaysResult.rows[0].working_days;

    // Group by teacher
    const teacherMap = {};
    dataResult.rows.forEach((row) => {
      const tid = row.teacher_id;
      if (!teacherMap[tid]) {
        teacherMap[tid] = {
          teacherId: tid,
          firstName: row.first_name,
          lastName: row.last_name,
          username: row.username,
          records: [],
        };
      }
      if (row.attendance_date) {
        teacherMap[tid].records.push({
          attendanceDate: row.attendance_date,
          status: row.status,
        });
      }
    });

    let teachers = Object.values(teacherMap);

    // Filter to single teacher if teacherId provided
    if (teacherId) {
      teachers = teachers.filter((t) => t.teacherId === teacherId);
    }

    const html = getStaffAttendanceHTML({ school, month, teachers, workingDays });
    const pdfBuffer = await createPDFBuffer(html);

    const filename = `Staff_Attendance_${school}_${month}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);

    logger.info(`Staff attendance PDF generated for ${school} ${month}`);
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to generate PDF" });
  }
};

module.exports = {
  getTodayStatus,
  checkIn,
  getMyMonth,
  updateMyRecord,
  getAllForSchoolMonth,
  updateAnyRecord,
  downloadPDF,
};
