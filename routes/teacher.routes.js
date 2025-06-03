// routes/teacher.router.js

const express = require("express");
const { getTeachersBySchool } = require("../controllers/teacher.controller");
const router = express.Router();

// GET /teachers?school={school}
router.get("/", getTeachersBySchool);

module.exports = router;
