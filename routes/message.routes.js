// routes/message.routes.js
const express = require("express");
const {
  getMessagesBySender,
  getMessagesByRecipient,
  sendMessage,
  updateMessage,
  deleteMessage, sendToAllParents, sendToParentsByGrade
} = require("../controllers/message.controller");

const router = express.Router();

router.get("/sent", getMessagesBySender);
router.get("/inbox", getMessagesByRecipient);
router.post("/", sendMessage);
router.patch("/:messageId", updateMessage);
router.delete("/:messageId", deleteMessage);
router.post('/mass/parents', sendToAllParents);
router.post('/mass/parents/grade', sendToParentsByGrade);

module.exports = router;