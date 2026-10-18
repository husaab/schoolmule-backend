const express = require("express");
const requireStaff = require("../middleware/requireStaff");
const requireClassOwnership = require("../middleware/requireClassOwnership");
const requireClassroomResource = require("../middleware/requireClassroomResource");
const controller = require("../controllers/classroom.controller");
const classwork = require("../controllers/classwork.controller");
const grading = require("../controllers/grading.controller");
const quiz = require("../controllers/quiz.controller");
const { singleImage } = require("../utils/imageUpload");
const { uploadFiles, uploadFile } = require("../utils/classworkUpload");

const BANNER_MAX_BYTES = 3 * 1024 * 1024;
// Checked after requireClassOwnership: a stranger's upload is never read.
const bannerImage = singleImage({ field: "banner", maxBytes: BANNER_MAX_BYTES });
const QUESTION_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
const questionImage = singleImage({ field: "image", maxBytes: QUESTION_IMAGE_MAX_BYTES });

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
router.param("itemId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Item not found" });
  next();
});
router.param("topicId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Topic not found" });
  next();
});
router.param("attachmentId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Attachment not found" });
  next();
});
router.param("answerId", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ status: "failed", message: "Answer not found" });
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

// Classwork: items, topics, attachments, copy from another class. Routes by
// item/topic/attachment id run requireClassroomResource (same rule as
// requireClassOwnership, on the resource's class). Uploads are read only
// after that check passes, so a stranger's upload is never parsed.
router.get("/classes/:classId/items", requireClassOwnership, classwork.listItems);
router.post("/classes/:classId/items", requireClassOwnership, classwork.createItem);
router.get("/items/:itemId", requireClassroomResource("item"), classwork.getItem);
router.patch("/items/:itemId", requireClassroomResource("item"), classwork.updateItem);
router.delete("/items/:itemId", requireClassroomResource("item"), classwork.deleteItem);

router.get("/classes/:classId/topics", requireClassOwnership, classwork.listTopics);
router.post("/classes/:classId/topics", requireClassOwnership, classwork.createTopic);
router.post("/classes/:classId/topics/reorder", requireClassOwnership, classwork.reorderTopics);
router.patch("/topics/:topicId", requireClassroomResource("topic"), classwork.updateTopic);
router.delete("/topics/:topicId", requireClassroomResource("topic"), classwork.deleteTopic);

router.post("/items/:itemId/attachments", requireClassroomResource("item"), uploadFiles, classwork.uploadAttachments);
router.post("/items/:itemId/links", requireClassroomResource("item"), classwork.addLink);
router.patch("/attachments/:attachmentId", requireClassroomResource("attachment"), classwork.updateAttachment);
router.put("/attachments/:attachmentId/file", requireClassroomResource("attachment"), uploadFile, classwork.replaceAttachmentFile);
router.delete("/attachments/:attachmentId", requireClassroomResource("attachment"), classwork.deleteAttachment);
router.get("/attachments/:attachmentId/url", requireClassroomResource("attachment"), classwork.attachmentUrl);

router.get("/classes/:classId/copy-sources", requireClassOwnership, classwork.copySources);
router.post("/classes/:classId/copy", requireClassOwnership, classwork.copyFromClass);

// Grading turned-in work (spec D3, D17): scores and feedback wait as drafts
// on the submission until Publish (one student, a few, or every graded one);
// Mark missing and Excuse publish at once. The grid overlay is the gradebook
// grid's classwork layer (drafts, work to grade, missing by due date).
router.get("/items/:itemId/submissions", requireClassroomResource("item"), grading.listSubmissions);
router.get("/items/:itemId/submissions/:studentId", requireClassroomResource("item"), grading.getSubmission);
router.patch("/items/:itemId/submissions/:studentId", requireClassroomResource("item"), grading.updateSubmission);
router.post("/items/:itemId/publish", requireClassroomResource("item"), grading.publish);
router.post("/items/:itemId/mark-missing", requireClassroomResource("item"), grading.markMissing);
router.post("/items/:itemId/excuse", requireClassroomResource("item"), grading.excuse);
router.get("/classes/:classId/grid-overlay", requireClassOwnership, grading.getGridOverlay);
// Messages about one student's work on an item (T17): the thread includes
// the student and their guardians; the teacher posts in it through
// /api/messaging/conversations/:id/messages.
router.get("/items/:itemId/students/:studentId/thread", requireClassroomResource("item"), grading.getStudentThread);
router.post("/items/:itemId/students/:studentId/thread", requireClassroomResource("item"), grading.ensureStudentThread);

// Quizzes (T23): the builder's questions (bulk, upsert by id) and their
// images, and the teacher's points on one answer. A quiz's scores follow
// the grading routes above (drafts until Publish). The image is read only
// after the ownership check passes.
router.get("/items/:itemId/questions", requireClassroomResource("item"), quiz.getQuestions);
router.put("/items/:itemId/questions", requireClassroomResource("item"), quiz.putQuestions);
router.post("/items/:itemId/question-images", requireClassroomResource("item"), questionImage, quiz.uploadQuestionImage);
router.patch("/quiz-answers/:answerId", requireClassroomResource("quizAnswer"), quiz.updateQuizAnswer);

module.exports = router;
