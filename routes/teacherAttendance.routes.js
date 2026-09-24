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

const router = express.Router();

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
