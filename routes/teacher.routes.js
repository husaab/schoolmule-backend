// routes/teacher.router.js

const express = require("express");
const { getTeachersBySchool, getTeacherById } = require("../controllers/teacher.controller");
const router = express.Router();

// GET /teachers?school={school}
router.get("/", getTeachersBySchool);
router.get("/:id", getTeacherById);

module.exports = router;
