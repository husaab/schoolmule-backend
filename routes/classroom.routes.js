const express = require("express");
const requireStaff = require("../middleware/requireStaff");
const requireClassOwnership = require("../middleware/requireClassOwnership");
const controller = require("../controllers/classroom.controller");

// The teacher's classroom. Staff only; every :classId route also passes
// requireClassOwnership (the caller teaches the class, or is an admin).
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireStaff);

router.param("classId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Class not found" });
  next();
});
router.param("studentId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Student not found" });
  next();
});

// A student's login (People tab): a new password link, or the invite again.
router.post("/classes/:classId/students/:studentId/reset-password", requireClassOwnership, controller.resetStudentPassword);
router.post("/classes/:classId/students/:studentId/resend-invite", requireClassOwnership, controller.resendStudentInvite);
// QR sign-in cards for students on the class roster.
router.post("/classes/:classId/qr-cards.pdf", requireClassOwnership, controller.printClassQrCards);

module.exports = router;
