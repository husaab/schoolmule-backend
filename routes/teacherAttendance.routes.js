const express = require("express");
const {
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
} = require("../controllers/teacherAttendance.controller");
const sheet = require("../controllers/staffHoursSheet.controller");
const { requireStaffAccess } = require("../middleware/access");

const router = express.Router();

// Staff only. Your own check-in and history are everyone's; everyone else's
// (and the pay schedule, sheet and PDF) is staff_attendance, checked in the
// controllers.
router.use(requireStaffAccess);

// Specific routes MUST come before parameterized routes
router.get("/today", getTodayStatus);
router.post("/checkin", checkIn);
router.get("/me", getMyMonth);
router.get("/me/pay-period", getMyPayPeriod);
router.patch("/me/:date", updateMyRecord);
router.delete("/me/:date", deleteMyRecord);
router.get("/pdf", downloadPDF);

// Pay schedule (per school) and pay periods (hours worked up to each pay day)
router.get("/pay-schedule", getPaySchedule);
router.put("/pay-schedule", savePaySchedule);
router.delete("/pay-schedule", deletePaySchedule);
router.get("/pay-periods", getPayPeriods);

// Staff hours → Google Sheet (admin). Connecting Google itself is shared with
// the forms integration: /api/registration/google/*.
router.get("/sheet", sheet.getSheetLink);
router.put("/sheet", sheet.linkSheet);
router.delete("/sheet", sheet.unlinkSheet);
router.post("/sheet/sync", sheet.syncNow);
router.get("/sheet/shares", sheet.listShares);
router.post("/sheet/shares", sheet.addShare);
router.delete("/sheet/shares/:permissionId", sheet.removeShare);

// Per-staff work profile (admin)
router.put("/work-days/:teacherId", setWorkDays);
router.delete("/work-days/:teacherId", resetWorkDays);
router.put("/hours-per-day/:teacherId", setHoursPerDay);
router.delete("/hours-per-day/:teacherId", resetHoursPerDay);

// Base route & parameterized admin routes
router.get("/", getAllForSchoolMonth);
router.patch("/:teacherId/:date", updateAnyRecord);
router.delete("/:teacherId/:date", deleteAnyRecord);

module.exports = router;
