const express = require("express");
const {
  getTodayStatus,
  checkIn,
  getMyMonth,
  updateMyRecord,
  getAllForSchoolMonth,
  updateAnyRecord,
  downloadPDF,
} = require("../controllers/teacher-attendance.controller");

const router = express.Router();

// Specific routes MUST come before parameterized routes
router.get("/today", getTodayStatus);
router.post("/checkin", checkIn);
router.get("/me", getMyMonth);
router.patch("/me/:date", updateMyRecord);
router.get("/pdf", downloadPDF);

// Base route & parameterized admin routes
router.get("/", getAllForSchoolMonth);
router.patch("/:teacherId/:date", updateAnyRecord);

module.exports = router;
