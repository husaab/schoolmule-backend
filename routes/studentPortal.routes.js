const express = require("express");
const requireStudent = require("../middleware/requireStudent");
const controller = require("../controllers/studentPortal.controller");

// The student portal. The fence (middleware/studentFence.js) lets a STUDENT
// token reach only this prefix; requireStudent then resolves the caller's
// student row for the request year (req.student) and refuses everyone else.
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireStudent);

// A malformed id is "not found", never a 500.
router.param("id", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Announcement not found" });
  next();
});
router.param("attachmentId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Attachment not found" });
  next();
});

router.get("/me", controller.getMe);

// The class Stream: announcements whose audience includes this student.
router.get("/announcements", controller.listAnnouncements);
router.post("/announcements/:id/read", controller.requireStudentAnnouncement, controller.markAnnouncementRead);
router.get("/announcements/:id/attachments/:attachmentId/url", controller.requireStudentAnnouncement, controller.announcementAttachmentUrl);

module.exports = router;
