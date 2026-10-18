const express = require("express");
const requireStudent = require("../middleware/requireStudent");
const controller = require("../controllers/studentPortal.controller");
const messaging = require("../controllers/studentMessaging.controller");
const quiz = require("../controllers/quiz.controller");
const requireStudentConversationAccess = require("../middleware/requireStudentConversationAccess");
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
router.param("conversationId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Conversation not found" });
  next();
});
router.param("messageId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Message not found" });
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

// A quiz (T23): one attempt, started once, answers autosaved, then a
// confirmed submit. Keyed on the caller's own row; no answer key is sent
// until the student's grade is visible.
router.get("/items/:itemId/quiz", quiz.getStudentQuiz);
router.post("/items/:itemId/quiz/start", quiz.startStudentQuiz);
router.put("/items/:itemId/quiz-answers", quiz.saveStudentAnswers);
router.post("/items/:itemId/quiz-submit", quiz.submitStudentQuiz);

// The class Stream: announcements whose audience includes this student.
router.get("/announcements", controller.listAnnouncements);
router.post("/announcements/:id/read", controller.requireStudentAnnouncement, controller.markAnnouncementRead);
router.get("/announcements/:id/attachments/:attachmentId/url", controller.requireStudentAnnouncement, controller.announcementAttachmentUrl);

// Messages: the student and their teachers, with the student's parents always
// in the thread (T17). Fixed paths come before :conversationId; every thread
// route runs requireStudentConversationAccess (the thread includes this
// student). Messages about one piece of work live under its item.
router.get("/conversations", messaging.listConversations);
router.get("/conversations/unread-count", messaging.getUnreadCount);
router.get("/conversations/targets", messaging.getTargets);
router.post("/conversations", messaging.createConversation);
router.get("/conversations/:conversationId", requireStudentConversationAccess, messaging.getConversation);
router.post("/conversations/:conversationId/messages", requireStudentConversationAccess, messaging.uploadFiles, messaging.postMessage);
router.patch("/conversations/:conversationId/messages/:messageId", requireStudentConversationAccess, messaging.editMessage);
router.delete("/conversations/:conversationId/messages/:messageId", requireStudentConversationAccess, messaging.deleteMessage);
router.post("/conversations/:conversationId/read", requireStudentConversationAccess, messaging.markRead);
router.get("/conversations/:conversationId/attachments/:attachmentId/url", requireStudentConversationAccess, messaging.getAttachmentUrl);
router.get("/items/:itemId/thread", messaging.getItemThread);
router.post("/items/:itemId/thread/messages", messaging.postItemThreadMessage);

module.exports = router;
