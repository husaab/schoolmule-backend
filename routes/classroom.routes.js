const express = require("express");
const requireStaff = require("../middleware/requireStaff");
const requireClassOwnership = require("../middleware/requireClassOwnership");
const controller = require("../controllers/classroom.controller");
const { singleImage } = require("../utils/imageUpload");

const BANNER_MAX_BYTES = 3 * 1024 * 1024;
// Checked after requireClassOwnership: a stranger's upload is never read.
const bannerImage = singleImage({ field: "banner", maxBytes: BANNER_MAX_BYTES });

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

// What staff read: the classes home, the class header, the People roster, the
// class Stream and the school's classroom settings (read-only, for staff UI copy).
router.get("/settings", controller.getClassroomSettings);
router.get("/classes", controller.listClasses);
router.get("/classes/:classId", requireClassOwnership, controller.getClass);
router.get("/classes/:classId/people", requireClassOwnership, controller.getPeople);
router.get("/classes/:classId/stream", requireClassOwnership, controller.getStream);

// A student's login (People tab): a new password link, or the invite again.
router.post("/classes/:classId/students/:studentId/reset-password", requireClassOwnership, controller.resetStudentPassword);
router.post("/classes/:classId/students/:studentId/resend-invite", requireClassOwnership, controller.resendStudentInvite);
// QR sign-in cards for students on the class roster.
router.post("/classes/:classId/qr-cards.pdf", requireClassOwnership, controller.printClassQrCards);


// The class's look: banner, icon and color (NULL = the subject default).
router.patch("/classes/:classId/identity", requireClassOwnership, controller.updateIdentity);
router.post("/classes/:classId/identity/reset", requireClassOwnership, controller.resetIdentity);
router.post("/classes/:classId/banner", requireClassOwnership, bannerImage, controller.uploadBanner);
router.delete("/classes/:classId/banner", requireClassOwnership, controller.deleteBanner);
// Class options and archive.
router.patch("/classes/:classId/options", requireClassOwnership, controller.updateOptions);
router.post("/classes/:classId/archive", requireClassOwnership, controller.archiveClass);
router.post("/classes/:classId/unarchive", requireClassOwnership, controller.unarchiveClass);
// A teacher picks the avatar of a student who has no login to pick with.
router.put("/classes/:classId/students/:studentId/avatar", requireClassOwnership, controller.setStudentAvatar);

module.exports = router;
