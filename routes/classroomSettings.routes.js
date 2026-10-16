const express = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const controller = require("../controllers/classroomSettings.controller");

const router = express.Router();

router.use(requireAdmin);

router.get("/", controller.getClassroomSettings);
router.put("/", controller.putClassroomSettings);

module.exports = router;
