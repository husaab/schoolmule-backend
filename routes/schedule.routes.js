const express = require("express");
const {
  getAllSchedules,
  getSchedulesByGrade,
  createSchedule,
  updateSchedule,
  deleteSchedule,
} = require("../controllers/schedule.controller");

const router = express.Router();

// GET /schedules?school=...&week=...
router.get("/", getAllSchedules);

// GET /schedules/grade/:grade?school=...&week=...
router.get("/grade/:grade", getSchedulesByGrade);

router.post("/", createSchedule);
router.patch("/:id", updateSchedule);
router.delete("/:id", deleteSchedule);

module.exports = router;
