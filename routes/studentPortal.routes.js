const express = require("express");
const requireStudent = require("../middleware/requireStudent");
const controller = require("../controllers/studentPortal.controller");
const { uploadSubmissionFiles } = require("../utils/classworkUpload");

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
router.param("classId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", code: "NOT_ENROLLED", message: "You aren't in this class" });
  next();
});
router.param("itemId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Item not found" });
  next();
});
router.param("fileId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "File not found" });
  next();
});

router.get("/me", controller.getMe);

// Home, class cards, a class (header, Stream, People) and published grades.
// Every /classes/:classId route first checks the student is on that roster.
router.get("/home", controller.getHome);
router.get("/classes", controller.listClasses);
router.get("/classes/:classId", controller.requireEnrolledClass, controller.getClass);
router.get("/classes/:classId/stream", controller.requireEnrolledClass, controller.getClassStream);
router.get("/classes/:classId/people", controller.requireEnrolledClass, controller.getClassPeople);
router.get("/classes/:classId/classwork", controller.requireEnrolledClass, controller.getClasswork);
router.get("/grades", controller.getGrades);

// Classwork: the To-do, an item, and the student's own work on it. Every
// item and file is looked up through the student's own row (404 otherwise);
// an upload is read only after the item check passes.
router.get("/todo", controller.getTodo);
router.get("/items/:itemId", controller.getItem);
router.put("/items/:itemId/text", controller.saveText);
router.post("/items/:itemId/files", controller.requireUploadableItem, uploadSubmissionFiles, controller.uploadFiles);
router.post("/items/:itemId/turn-in", controller.turnIn);
router.post("/items/:itemId/unsubmit", controller.unsubmit);
router.delete("/files/:fileId", controller.deleteFile);
router.get("/files/:fileId/url", controller.fileUrl);

// The class Stream: announcements whose audience includes this student.
router.get("/announcements", controller.listAnnouncements);
router.post("/announcements/:id/read", controller.requireStudentAnnouncement, controller.markAnnouncementRead);
router.get("/announcements/:id/attachments/:attachmentId/url", controller.requireStudentAnnouncement, controller.announcementAttachmentUrl);

module.exports = router;
