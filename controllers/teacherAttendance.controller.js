const db = require("../config/database");
const teacherAttendanceQueries = require("../queries/teacherAttendance.queries");
const logger = require("../logger");
const { createPDFBuffer } = require("../utils/pdfGenerator");
const { getStaffAttendanceHTML } = require("../templates/staffAttendanceTemplate");

/**
 * Staff are assumed present on every open school day from this date onward
 * unless they — or an admin — recorded something else. Floored at the start of
 * the 2026-2027 year so earlier years keep exactly the records they have.
 * Combined with the calendar rule, the first assumed day for a school is its
 * first non-closed weekday: Sept 8, 2026 for Al Haadi (Sept 7 is Labour Day).
 */
const ASSUMED_PRESENT_FROM = "2026-09-01";

/** Normalize a pg DATE (or ISO string) to a YYYY-MM-DD key without shifting timezone. */
const dateKey = (value) => {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).substring(0, 10);
};

const loadOpenSchoolDays = async (month, school) => {
  const { rows } = await db.query(teacherAttendanceQueries.selectOpenSchoolDays, [month, school]);
  return rows.map((r) => ({ day: r.day, isElapsed: r.is_elapsed }));
};

const EVERY_WEEKDAY = [1, 2, 3, 4, 5];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO weekday (Monday = 1 … Sunday = 7) of a YYYY-MM-DD key, in local time. */
const isoWeekday = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 ? 7 : dow;
};

/**
 * Each staff member's work days for a month, keyed by user_id:
 * an admin override wins, then the schedule planner, then every weekday.
 * `source` lets the UI say where the days came from.
 */
const loadWorkDays = async (month, school, userId = null) => {
  const { rows } = await db.query(teacherAttendanceQueries.selectWorkDayInputs, [school, month, userId]);
  const byUser = new Map();
  for (const row of rows) {
    if (row.custom_days?.length) {
      byUser.set(row.user_id, { days: row.custom_days.map(Number), source: "custom" });
    } else if (row.planner_days?.length) {
      byUser.set(row.user_id, { days: row.planner_days.map(Number), source: "planner" });
    } else {
      byUser.set(row.user_id, { days: EVERY_WEEKDAY, source: "default" });
    }
  }
  return byUser;
};

/** Open school days this person actually works — their expected days. */
const expectedDaysFor = (openDays, workDays) =>
  openDays.filter((d) => workDays.days.includes(isoWeekday(d.day)));

/**
 * Fill in the days a teacher never explicitly recorded. Any elapsed expected
 * day (open school day they work) on or after ASSUMED_PRESENT_FROM with no
 * record of its own reads as PRESENT — assumed and confirmed days are
 * deliberately indistinguishable. Days they don't work stay empty, but a real
 * check-in on one (covering a shift) is kept and counts.
 *
 * Nothing is written to the database, so the dashboard check-in prompt is
 * unaffected: it reads teacher_attendance directly and keeps asking until a
 * real row exists.
 */
const withAssumedPresent = (records, expectedDays) => {
  const recorded = new Set(records.map((r) => dateKey(r.attendanceDate)));

  const assumed = expectedDays
    .filter((d) => d.isElapsed && d.day >= ASSUMED_PRESENT_FROM && !recorded.has(d.day))
    .map((d) => ({ attendanceDate: d.day, status: "PRESENT", notes: null }));

  return [...records, ...assumed].sort((a, b) =>
    dateKey(a.attendanceDate).localeCompare(dateKey(b.attendanceDate))
  );
};

/**
 * Shared read path for the admin month view and the PDF: every teacher at the
 * school with their records for the month, assumed-present days included, and
 * their own work days and working-day count.
 */
const buildSchoolMonth = async (month, school) => {
  const [dataResult, openDays, workDaysByUser] = await Promise.all([
    db.query(teacherAttendanceQueries.selectAllForSchoolMonth, [month, school]),
    loadOpenSchoolDays(month, school),
    loadWorkDays(month, school),
  ]);

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
        notes: row.notes ?? null,
      });
    }
  });

  const teachers = Object.values(teacherMap).map((t) => {
    const workDays = workDaysByUser.get(t.teacherId) ?? { days: EVERY_WEEKDAY, source: "default" };
    const expectedDays = expectedDaysFor(openDays, workDays);
    return {
      ...t,
      records: withAssumedPresent(t.records, expectedDays),
      workDays: workDays.days,
      workDaysSource: workDays.source,
      workingDays: expectedDays.length,
    };
  });

  // Top-level workingDays stays the school's open days for older clients.
  return { teachers, workingDays: openDays.length };
};

// GET /today?date=YYYY-MM-DD
const getTodayStatus = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { date } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "failed", message: "date query param required (YYYY-MM-DD)" });
    }

    const month = date.substring(0, 7);
    const [{ rows }, openDays, workDaysByUser] = await Promise.all([
      db.query(teacherAttendanceQueries.selectTodayStatus, [userId, date]),
      loadOpenSchoolDays(month, school),
      loadWorkDays(month, school, userId),
    ]);
    const workDays = workDaysByUser.get(userId) ?? { days: EVERY_WEEKDAY, source: "default" };

    return res.status(200).json({
      status: "success",
      data: {
        checkedIn: rows.length > 0,
        status: rows.length > 0 ? rows[0].status : null,
        notes: rows.length > 0 ? rows[0].notes : null,
        // False on school closures and on this person's days off, so the
        // dashboard doesn't ask them to check in.
        expected: expectedDaysFor(openDays, workDays).some((d) => d.day === date),
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
    const { status, notes, date } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return res.status(400).json({ status: "failed", message: "Status must be PRESENT or ABSENT" });
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ status: "failed", message: "date is required (YYYY-MM-DD)" });
    }

    const trimmedNotes = notes ? String(notes).trim() || null : null;
    const { rows } = await db.query(teacherAttendanceQueries.upsertCheckin, [userId, date, status, school, trimmedNotes]);

    return res.status(200).json({
      status: "success",
      data: {
        teacherId: rows[0].teacher_id,
        attendanceDate: rows[0].attendance_date,
        status: rows[0].status,
        notes: rows[0].notes,
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
    const { userId, school } = req.user;
    const { month } = req.query;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ status: "failed", message: "month query param required (YYYY-MM)" });
    }

    const [recordsResult, openDays, workDaysByUser] = await Promise.all([
      db.query(teacherAttendanceQueries.selectMyMonth, [userId, month]),
      loadOpenSchoolDays(month, school),
      loadWorkDays(month, school, userId),
    ]);
    const workDays = workDaysByUser.get(userId) ?? { days: EVERY_WEEKDAY, source: "default" };
    const expectedDays = expectedDaysFor(openDays, workDays);

    const records = withAssumedPresent(
      recordsResult.rows.map((r) => ({
        attendanceDate: r.attendance_date,
        status: r.status,
        notes: r.notes ?? null,
      })),
      expectedDays
    );

    return res.status(200).json({
      status: "success",
      data: {
        records,
        workDays: workDays.days,
        workDaysSource: workDays.source,
        workingDays: expectedDays.length,
        presentDays: records.filter((r) => r.status === "PRESENT").length,
        absentDays: records.filter((r) => r.status === "ABSENT").length,
      },
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
    const { status, notes } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return res.status(400).json({ status: "failed", message: "Status must be PRESENT or ABSENT" });
    }

    const trimmedNotes = notes ? String(notes).trim() || null : null;
    const { rows } = await db.query(teacherAttendanceQueries.updateMyRecord, [userId, date, status, school, trimmedNotes]);

    return res.status(200).json({
      status: "success",
      data: {
        teacherId: rows[0].teacher_id,
        attendanceDate: rows[0].attendance_date,
        status: rows[0].status,
        notes: rows[0].notes,
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

    const { teachers, workingDays } = await buildSchoolMonth(month, school);

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
    const { status, notes } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return res.status(400).json({ status: "failed", message: "Status must be PRESENT or ABSENT" });
    }

    const trimmedNotes = notes ? String(notes).trim() || null : null;
    const { rows } = await db.query(teacherAttendanceQueries.updateAnyRecord, [teacherId, date, status, req.user.school, trimmedNotes]);

    return res.status(200).json({
      status: "success",
      data: {
        teacherId: rows[0].teacher_id,
        attendanceDate: rows[0].attendance_date,
        status: rows[0].status,
        notes: rows[0].notes,
      },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to update record" });
  }
};

// PUT /work-days/:teacherId (admin) — body { workDays: [1..7] }
const setWorkDays = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }

    const { teacherId } = req.params;
    const { workDays } = req.body;
    if (!UUID_RE.test(teacherId)) {
      return res.status(404).json({ status: "failed", message: "Staff member not found" });
    }
    const valid =
      Array.isArray(workDays) &&
      workDays.length > 0 &&
      workDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (!valid) {
      return res.status(400).json({ status: "failed", message: "workDays must be a non-empty list of weekdays (1-7)" });
    }

    const staff = await db.query(teacherAttendanceQueries.selectStaffMember, [teacherId, req.user.school]);
    if (staff.rows.length === 0) {
      return res.status(404).json({ status: "failed", message: "Staff member not found" });
    }

    const days = [...new Set(workDays)].sort((a, b) => a - b);
    await db.query(teacherAttendanceQueries.upsertWorkSchedule, [teacherId, req.user.school, days, req.user.userId]);

    return res.status(200).json({
      status: "success",
      data: { teacherId, workDays: days, workDaysSource: "custom" },
    });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to save work days" });
  }
};

// DELETE /work-days/:teacherId (admin) — back to the schedule planner / every weekday
const resetWorkDays = async (req, res) => {
  try {
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ status: "failed", message: "Admin access required" });
    }

    if (!UUID_RE.test(req.params.teacherId)) {
      return res.status(404).json({ status: "failed", message: "Staff member not found" });
    }
    await db.query(teacherAttendanceQueries.deleteWorkSchedule, [req.params.teacherId, req.user.school]);
    return res.status(200).json({ status: "success", data: { teacherId: req.params.teacherId } });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Failed to reset work days" });
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

    const built = await buildSchoolMonth(month, school);
    const { workingDays } = built;
    let teachers = built.teachers;

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
  setWorkDays,
  resetWorkDays,
  downloadPDF,
};
