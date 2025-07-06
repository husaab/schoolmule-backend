/*
  src/routes/feedback.routes.js
*/

const express = require("express");
const {
  getFeedbackBySender,
  getFeedbackByRecipient,
  getFeedbackByStudentId,
  sendFeedback,
  updateFeedback,
  deleteFeedback
} = require("../controllers/feedback.controller");

const router = express.Router();

router.get("/sent", getFeedbackBySender);
router.get("/inbox", getFeedbackByRecipient);
router.get("/student/:studentId", getFeedbackByStudentId);
router.post("/", sendFeedback);
router.patch("/:feedbackId", updateFeedback);
router.delete("/:feedbackId", deleteFeedback);

module.exports = router;