const express = require("express");
const { getTourProgress, postTourEvent } = require("../controllers/tour.controller");

// Guided tours. Mounted behind the global verifyUser; open to every signed-in
// role, students included (see middleware/studentFence.js): each query is
// keyed on the caller's own user id.
const router = express.Router();

router.get("/progress", getTourProgress);
router.post("/:tourId/event", postTourEvent);

module.exports = router;
