const express = require("express");
const {
  getTodayStatus,
  checkIn,
  getMyMonth,
  updateMyRecord,
  getAllForSchoolMonth,
  updateAnyRecord,
  setWorkDays,
  resetWorkDays,
  downloadPDF,
} = require("../controllers/teacherAttendance.controller");

const router = express.Router();

// Specific routes MUST come before parameterized routes
router.get("/today", getTodayStatus);
router.post("/checkin", checkIn);
router.get("/me", getMyMonth);
router.patch("/me/:date", updateMyRecord);
router.get("/pdf", downloadPDF);
router.put("/work-days/:teacherId", setWorkDays);
router.delete("/work-days/:teacherId", resetWorkDays);

// Base route & parameterized admin routes
router.get("/", getAllForSchoolMonth);
router.patch("/:teacherId/:date", updateAnyRecord);

module.exports = router;
