const express = require("express");
const requireStudent = require("../middleware/requireStudent");
const controller = require("../controllers/studentPortal.controller");

// The student portal. The fence (middleware/studentFence.js) lets a STUDENT
// token reach only this prefix; requireStudent then resolves the caller's
// student row for the request year (req.student) and refuses everyone else.
const router = express.Router();

router.use(requireStudent);

router.get("/me", controller.getMe);

module.exports = router;
