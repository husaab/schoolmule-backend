const db = require("../config/database");
const teacherAttendanceQueries = require("../queries/teacherAttendance.queries");
const logger = require("../logger");
const { createPDFBuffer } = require("../utils/pdfGenerator");
const { getStaffAttendanceHTML } = require("../templates/staffAttendanceTemplate");
const payPeriods = require("../services/payPeriods");

const googleSheetsQueries = require("../queries/googleSheets.queries");
const {
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_PROFILE,
  torontoToday,
  monthRange,
  mapRecord,
  mapSchedule,
  loadOpenSchoolDays,
  loadWorkDays,
  loadPaySchedule,
  expectedDaysFor,
  assemblePerson,
  buildSchoolMonth,
  buildPayPeriod,
} = require("../services/staffAttendance/assembly");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isAdmin = (req) => req.user.role === "ADMIN";
const forbid = (res) => res.status(403).json({ status: "failed", message: "Admin access required" });
const fail = (res, code, message) => res.status(code).json({ status: "failed", message });
const OUTSIDE_YEAR = "That date is outside the school year";

/**
 * Queues a refresh of the school's linked staff-hours Google Sheet. Best
 * effort by design: a sheet that briefly lags is far better than a check-in
 * failing because the outbox is unavailable. A no-op for schools with no
 * linked sheet, and coalesced when a job is already pending.
 */
const queueStaffHoursSync = async (school) => {
  try {
    await db.query(googleSheetsQueries.enqueueStaffHoursJob, [school]);
  } catch (error) {
    logger.warn({ err: error, school }, "Could not queue staff hours sheet sync");
  }
};

// ─── Self-service ─────────────────────────────────────────────────────────

// GET /today?date=YYYY-MM-DD
const getTodayStatus = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { date } = req.query;

    if (!date || !DATE_RE.test(date)) {
      return fail(res, 400, "date query param required (YYYY-MM-DD)");
    }

    const { start, end } = monthRange(date.substring(0, 7));
    const [{ rows }, openDays, profiles] = await Promise.all([
      db.query(teacherAttendanceQueries.selectTodayStatus, [userId, date]),
      loadOpenSchoolDays(start, end, school),
      loadWorkDays(start, end, school, userId),
    ]);
    const profile = profiles.get(userId) ?? DEFAULT_PROFILE;

    return res.status(200).json({
      status: "success",
      data: {
        checkedIn: rows.length > 0,
        status: rows.length > 0 ? rows[0].status : null,
        notes: rows.length > 0 ? rows[0].notes : null,
        // False on school closures and on this person's days off, so the
        // dashboard doesn't ask them to check in.
        expected: expectedDaysFor(openDays, profile).some((d) => d.day === date),
      },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to get today's status");
  }
};

// POST /checkin
const checkIn = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { status, notes, date } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return fail(res, 400, "Status must be PRESENT or ABSENT");
    }
    if (!date || !DATE_RE.test(date)) {
      return fail(res, 400, "date is required (YYYY-MM-DD)");
    }

    const trimmedNotes = notes ? String(notes).trim() || null : null;
    const { rows } = await db.query(teacherAttendanceQueries.upsertCheckin, [userId, date, status, school, trimmedNotes]);
    if (rows.length === 0) return fail(res, 400, OUTSIDE_YEAR);
    await queueStaffHoursSync(req.user.school);

    return res.status(200).json({
      status: "success",
      data: { teacherId: rows[0].teacher_id, ...mapRecord(rows[0]) },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to check in");
  }
};

// GET /me?month=YYYY-MM
const getMyMonth = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { month } = req.query;

    if (!month || !MONTH_RE.test(month)) {
      return fail(res, 400, "month query param required (YYYY-MM)");
    }

    const { start, end } = monthRange(month);
    const [recordsResult, openDays, profiles, schedule] = await Promise.all([
      db.query(teacherAttendanceQueries.selectMyRange, [userId, start, end]),
      loadOpenSchoolDays(start, end, school),
      loadWorkDays(start, end, school, userId),
      loadPaySchedule(school),
    ]);

    const person = assemblePerson(
      recordsResult.rows.map(mapRecord),
      openDays,
      profiles.get(userId) ?? DEFAULT_PROFILE,
      schedule?.defaultHoursPerDay ?? DEFAULT_HOURS_PER_DAY
    );

    return res.status(200).json({ status: "success", data: person });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to get monthly records");
  }
};

// PATCH /me/:date
const updateMyRecord = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { date } = req.params;
    const { status, notes } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return fail(res, 400, "Status must be PRESENT or ABSENT");
    }

    const trimmedNotes = notes ? String(notes).trim() || null : null;
    const { rows } = await db.query(teacherAttendanceQueries.updateMyRecord, [userId, date, status, school, trimmedNotes]);
    if (rows.length === 0) return fail(res, 400, OUTSIDE_YEAR);
    await queueStaffHoursSync(req.user.school);

    return res.status(200).json({
      status: "success",
      data: { teacherId: rows[0].teacher_id, ...mapRecord(rows[0]) },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to update record");
  }
};

// DELETE /me/:date — remove what I recorded for a day
const deleteMyRecord = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { date } = req.params;
    if (!DATE_RE.test(date)) return fail(res, 400, "date must be YYYY-MM-DD");

    const { rowCount } = await db.query(teacherAttendanceQueries.deleteRecord, [userId, date, school]);
    if (rowCount > 0) await queueStaffHoursSync(school);
    return res.status(200).json({ status: "success", data: { teacherId: userId, attendanceDate: date, deleted: rowCount > 0 } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to delete record");
  }
};

// GET /me/pay-period — my hours so far in the period paid on the next pay day
// GET /me/pay-period?date=YYYY-MM-DD — the period containing that date (for history)
const getMyPayPeriod = async (req, res) => {
  try {
    const { userId, school } = req.user;
    const { date } = req.query;
    if (date && !DATE_RE.test(date)) return fail(res, 400, "date must be YYYY-MM-DD");

    const schedule = await loadPaySchedule(school);
    if (!schedule) {
      return res.status(200).json({ status: "success", data: { schedule: null, period: null } });
    }

    const period = payPeriods.periodContaining(schedule, date || torontoToday());
    const built = await buildPayPeriod(period, school, userId);
    const { teachers, ...meta } = built;
    const me = teachers.find((t) => t.teacherId === userId) ?? null;

    return res.status(200).json({ status: "success", data: { schedule, period: { ...meta, ...(me ?? {}) } } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to get pay period");
  }
};

// ─── Admin: month view + records ──────────────────────────────────────────

// GET /?school=X&month=YYYY-MM (admin)
const getAllForSchoolMonth = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { school, month } = req.query;
    if (!school || !month || !MONTH_RE.test(month)) {
      return fail(res, 400, "school and month (YYYY-MM) query params required");
    }

    const { teachers, workingDays, schedule, schoolHoursPerDay } = await buildSchoolMonth(month, school);

    return res.status(200).json({
      status: "success",
      data: { teachers, workingDays, paySchedule: schedule, schoolHoursPerDay },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to get school attendance");
  }
};

/** null/undefined → null (usual day); otherwise a number of hours 0–24, or NaN when invalid. */
const parseHoursOverride = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? Math.round(n * 100) / 100 : NaN;
};

// PATCH /:teacherId/:date (admin) — body { status, notes?, hours? }
const updateAnyRecord = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { teacherId, date } = req.params;
    const { status, notes, hours } = req.body;

    if (!status || !["PRESENT", "ABSENT"].includes(status)) {
      return fail(res, 400, "Status must be PRESENT or ABSENT");
    }
    const hoursOverride = parseHoursOverride(hours);
    if (Number.isNaN(hoursOverride)) {
      return fail(res, 400, "hours must be between 0 and 24");
    }

    const trimmedNotes = notes ? String(notes).trim() || null : null;
    const { rows } = await db.query(teacherAttendanceQueries.updateAnyRecord, [
      teacherId,
      date,
      status,
      req.user.school,
      trimmedNotes,
      hoursOverride,
    ]);
    if (rows.length === 0) return fail(res, 400, OUTSIDE_YEAR);
    await queueStaffHoursSync(req.user.school);

    return res.status(200).json({
      status: "success",
      data: { teacherId: rows[0].teacher_id, ...mapRecord(rows[0]) },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to update record");
  }
};

// ─── Admin: per-staff work profile ────────────────────────────────────────

// DELETE /:teacherId/:date (admin) — remove a day's record for anyone
const deleteAnyRecord = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { teacherId, date } = req.params;
    if (!UUID_RE.test(teacherId)) return fail(res, 404, "Staff member not found");
    if (!DATE_RE.test(date)) return fail(res, 400, "date must be YYYY-MM-DD");

    const { rowCount } = await db.query(teacherAttendanceQueries.deleteRecord, [teacherId, date, req.user.school]);
    if (rowCount > 0) await queueStaffHoursSync(req.user.school);
    return res.status(200).json({ status: "success", data: { teacherId, attendanceDate: date, deleted: rowCount > 0 } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to delete record");
  }
};

const requireStaffMember = async (req, res) => {
  const { teacherId } = req.params;
  if (!UUID_RE.test(teacherId)) {
    fail(res, 404, "Staff member not found");
    return false;
  }
  const staff = await db.query(teacherAttendanceQueries.selectStaffMember, [teacherId, req.user.school]);
  if (staff.rows.length === 0) {
    fail(res, 404, "Staff member not found");
    return false;
  }
  return true;
};

// PUT /work-days/:teacherId (admin) — body { workDays: [1..7] }
const setWorkDays = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { teacherId } = req.params;
    const { workDays } = req.body;
    if (!UUID_RE.test(teacherId)) return fail(res, 404, "Staff member not found");
    const valid =
      Array.isArray(workDays) &&
      workDays.length > 0 &&
      workDays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (!valid) {
      return fail(res, 400, "workDays must be a non-empty list of weekdays (1-7)");
    }

    if (!(await requireStaffMember(req, res))) return;

    const days = [...new Set(workDays)].sort((a, b) => a - b);
    await db.query(teacherAttendanceQueries.upsertWorkSchedule, [teacherId, req.user.school, days, req.user.userId]);
    await queueStaffHoursSync(req.user.school);

    return res.status(200).json({
      status: "success",
      data: { teacherId, workDays: days, workDaysSource: "custom" },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to save work days");
  }
};

// DELETE /work-days/:teacherId (admin) — back to the schedule planner / every weekday
const resetWorkDays = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { teacherId } = req.params;
    if (!UUID_RE.test(teacherId)) return fail(res, 404, "Staff member not found");
    await db.query(teacherAttendanceQueries.deleteWorkScheduleIfOnlyDays, [teacherId, req.user.school]);
    await db.query(teacherAttendanceQueries.clearWorkDays, [teacherId, req.user.school, req.user.userId]);
    await queueStaffHoursSync(req.user.school);
    return res.status(200).json({ status: "success", data: { teacherId } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to reset work days");
  }
};

// PUT /hours-per-day/:teacherId (admin) — body { hoursPerDay }
const setHoursPerDay = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { teacherId } = req.params;
    const hours = Number(req.body?.hoursPerDay);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      return fail(res, 400, "hoursPerDay must be between 0 and 24");
    }
    if (!(await requireStaffMember(req, res))) return;

    const rounded = Math.round(hours * 100) / 100;
    await db.query(teacherAttendanceQueries.upsertHoursPerDay, [teacherId, req.user.school, rounded, req.user.userId]);
    await queueStaffHoursSync(req.user.school);

    return res.status(200).json({
      status: "success",
      data: { teacherId, hoursPerDay: rounded, hoursPerDaySource: "custom" },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to save hours per day");
  }
};

// DELETE /hours-per-day/:teacherId (admin) — back to the school default
const resetHoursPerDay = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { teacherId } = req.params;
    if (!UUID_RE.test(teacherId)) return fail(res, 404, "Staff member not found");
    await db.query(teacherAttendanceQueries.deleteWorkScheduleIfOnlyHours, [teacherId, req.user.school]);
    await db.query(teacherAttendanceQueries.clearHoursPerDay, [teacherId, req.user.school, req.user.userId]);
    await queueStaffHoursSync(req.user.school);
    return res.status(200).json({ status: "success", data: { teacherId } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to reset hours per day");
  }
};

// ─── Pay schedule (per school) ────────────────────────────────────────────

// GET /pay-schedule — any staff member; teachers see their own pay day
const getPaySchedule = async (req, res) => {
  try {
    const schedule = await loadPaySchedule(req.user.school);
    const today = torontoToday();
    return res.status(200).json({
      status: "success",
      data: {
        schedule,
        currentPeriod: schedule ? payPeriods.periodContaining(schedule, today) : null,
        today,
      },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to get pay schedule");
  }
};

// PUT /pay-schedule (admin) — body { frequency, payDayOfMonth?, secondPayDayOfMonth?, anchorPayDate?, defaultHoursPerDay?, workDayStart? }
const savePaySchedule = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { error, value } = payPeriods.normalizeSchedule(req.body);
    if (error) return fail(res, 400, error);

    const { rows } = await db.query(teacherAttendanceQueries.upsertPaySchedule, [
      req.user.school,
      value.frequency,
      value.payDayOfMonth,
      value.secondPayDayOfMonth,
      value.anchorPayDate,
      value.defaultHoursPerDay,
      value.workDayStart,
      req.user.userId,
    ]);
    const schedule = mapSchedule(rows[0]);
    await queueStaffHoursSync(req.user.school);

    return res.status(200).json({
      status: "success",
      data: { schedule, currentPeriod: payPeriods.periodContaining(schedule, torontoToday()) },
    });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to save pay schedule");
  }
};

// DELETE /pay-schedule (admin)
const deletePaySchedule = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);
    await db.query(teacherAttendanceQueries.deletePaySchedule, [req.user.school]);
    await queueStaffHoursSync(req.user.school);
    return res.status(200).json({ status: "success", data: { schedule: null } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to delete pay schedule");
  }
};

// GET /pay-periods?month=YYYY-MM (admin) — every period paid in that month, with hours
// GET /pay-periods?date=YYYY-MM-DD (admin) — the single period containing that date
const getPayPeriods = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { month, date, teacherId } = req.query;
    if (month && !MONTH_RE.test(month)) return fail(res, 400, "month must be YYYY-MM");
    if (date && !DATE_RE.test(date)) return fail(res, 400, "date must be YYYY-MM-DD");
    if (teacherId && !UUID_RE.test(teacherId)) return fail(res, 404, "Staff member not found");

    const schedule = await loadPaySchedule(req.user.school);
    if (!schedule) {
      return res.status(200).json({ status: "success", data: { schedule: null, periods: [] } });
    }

    const ranges = month
      ? payPeriods.periodsPaidInMonth(schedule, month)
      : [payPeriods.periodContaining(schedule, date || torontoToday())];

    const periods = [];
    for (const range of ranges) {
      periods.push(await buildPayPeriod(range, req.user.school, teacherId || null));
    }

    return res.status(200).json({ status: "success", data: { schedule, periods } });
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to get pay periods");
  }
};

// ─── PDF ──────────────────────────────────────────────────────────────────

// GET /pdf?school=X&month=YYYY-MM&teacherId= (admin)
const downloadPDF = async (req, res) => {
  try {
    if (!isAdmin(req)) return forbid(res);

    const { school, month, teacherId } = req.query;
    if (!school || !month || !MONTH_RE.test(month)) {
      return fail(res, 400, "school and month (YYYY-MM) query params required");
    }

    const built = await buildSchoolMonth(month, school);
    const { workingDays, schedule } = built;
    let teachers = built.teachers;

    // Filter to single teacher if teacherId provided
    if (teacherId) {
      teachers = teachers.filter((t) => t.teacherId === teacherId);
    }

    // Hours worked up to each pay day that lands in this month.
    const payPeriodReports = [];
    if (schedule) {
      for (const range of payPeriods.periodsPaidInMonth(schedule, month)) {
        payPeriodReports.push(await buildPayPeriod(range, school, teacherId || null));
      }
    }

    const html = getStaffAttendanceHTML({
      school,
      month,
      teachers,
      workingDays,
      schedule,
      payPeriods: payPeriodReports,
    });
    const pdfBuffer = await createPDFBuffer(html, { landscape: true, margin: { top: "24px", bottom: "24px", left: "24px", right: "24px" } });

    const filename = `Staff_Attendance_${school}_${month}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);

    logger.info(`Staff attendance PDF generated for ${school} ${month}`);
  } catch (error) {
    logger.error(error);
    return fail(res, 500, "Failed to generate PDF");
  }
};

module.exports = {
  getTodayStatus,
  checkIn,
  getMyMonth,
  updateMyRecord,
  deleteMyRecord,
  getMyPayPeriod,
  getAllForSchoolMonth,
  updateAnyRecord,
  deleteAnyRecord,
  setWorkDays,
  resetWorkDays,
  setHoursPerDay,
  resetHoursPerDay,
  getPaySchedule,
  savePaySchedule,
  deletePaySchedule,
  getPayPeriods,
  downloadPDF,
};
