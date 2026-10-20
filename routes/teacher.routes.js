// routes/teacher.router.js

const express = require("express");
const { getTeachersBySchool, getTeacherById } = require("../controllers/teacher.controller");
const { requireStaffAccess } = require("../middleware/access");
const router = express.Router();

// Staff pickers; the school is the caller's (the controller pins it).
router.use(requireStaffAccess);

// GET /teachers?school={school}
router.get("/", getTeachersBySchool);
router.get("/:id", getTeacherById);

module.exports = router;
