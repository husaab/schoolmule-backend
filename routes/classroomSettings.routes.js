const express = require("express");
const { requirePermission } = require("../middleware/access");
const controller = require("../controllers/classroomSettings.controller");

const router = express.Router();


// Student accounts shows them; changing them is school setup.
router.get("/", requirePermission("users", "school_setup"), controller.getClassroomSettings);
router.put("/", requirePermission("school_setup"), controller.putClassroomSettings);

module.exports = router;
