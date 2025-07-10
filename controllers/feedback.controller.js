/*
  src/controllers/feedback.controller.js
*/

const db = require("../config/database");
const feedbackQueries = require("../queries/feedback.queries");
const logger = require("../logger");

const { Resend } = require('resend');
const { getFeedbackEmailHTML } = require('../utils/emailTemplate');
const resend = new Resend(process.env.RESEND_API_KEY);

const toCamel = row => ({
  feedbackId:           row.feedback_id,
  studentId:            row.student_id,
  studentName:          row.student_name,
  senderId:             row.sender_id,
  senderName:           row.sender_name,
  recipientId:          row.recipient_id,
  recipientName:        row.recipient_name,
  school:               row.school,
  subject:              row.subject,
  body:                 row.body,
  assessmentName:       row.assessment_name,
  score:                row.score,
  weightPercentage:     row.weight_percentage,
  courseName:           row.course_name,
  createdAt:            row.created_at,
  lastModifiedAt:       row.last_modified_at,
});

// GET /api/feedback/sent?senderId=<uuid>
const getFeedbackBySender = async (req, res) => {
  const senderId = req.query.senderId;
  if (!senderId) {
    return res.status(400).json({ status: "failed", message: "Missing query parameter: senderId" });
  }
  try {
    const { rows } = await db.query(feedbackQueries.selectFeedbackBySender, [senderId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data: data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching sent feedback" });
  }
};

// GET /api/feedback/inbox?recipientId=<uuid>
const getFeedbackByRecipient = async (req, res) => {
  const recipientId = req.query.recipientId;
  if (!recipientId) {
    return res.status(400).json({ status: "failed", message: "Missing query parameter: recipientId" });
  }
  try {
    const { rows } = await db.query(feedbackQueries.selectFeedbackByRecipient, [recipientId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching inbox feedback" });
  }
};

// GET /api/feedback/student/:studentId
const getFeedbackByStudentId = async (req, res) => {
  const { studentId } = req.params;
  if (!studentId) {
    return res.status(400).json({ status: "failed", message: "Missing parameter: studentId" });
  }
  try {
    const { rows } = await db.query(feedbackQueries.selectFeedbackByStudentId, [studentId]);
    const data = rows.map(toCamel);
    return res.status(200).json({ status: "success", data });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching student feedback" });
  }
};

// POST /api/feedback
const sendFeedback = async (req, res) => {
  const {
    senderId, senderName,
    recipientId, recipientName,
    school, subject, body,
    assessmentName, score, weightPercentage, childName, courseName, studentId, studentName
  } = req.body;

  if (!senderId || !recipientId || !body || !school || !assessmentName || score == null || weightPercentage == null) {
    return res.status(400).json({ status: "failed", message: "Missing required fields for feedback" });
  }

  try {
    const { rows } = await db.query(
      feedbackQueries.insertFeedback,
      [senderId, senderName, recipientId, recipientName,
       school, subject || null, body,
       assessmentName, score, weightPercentage, courseName, studentId, studentName || null]
    );

    const userRes = await db.query(
      'SELECT email FROM users WHERE user_id = $1',
      [recipientId]
    );
    if (userRes.rows.length) {
      const parentEmail = userRes.rows[0].email;
      const link = `${process.env.FRONTEND_URL}/parent/feedback`;  // or a deep link to that feedback
      const html = getFeedbackEmailHTML({ childName, assessmentName, courseName, link });

      // 3) Send the email
      await resend.emails.send({
        from: 'notifications@schoolmule.ca',
        to: parentEmail,
        subject: `Feedback for ${childName} on ${assessmentName} for ${courseName}`,
        html,
      });
      logger.info(`Feedback email sent to ${recipientId}`);
    }

    logger.info(`Feedback sent from ${senderId} to ${recipientId}`);
    return res.status(201).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error sending feedback" });
  }
};

// PATCH /api/feedback/:feedbackId
const updateFeedback = async (req, res) => {
  const { feedbackId } = req.params;
  const {
    subject, body,
    assessmentName, score, weightPercentage,
    senderId
  } = req.body;

  if (!feedbackId || !senderId) {
    return res.status(400).json({ status: "failed", message: "Missing feedbackId or senderId" });
  }

  try {
    const { rows } = await db.query(
      feedbackQueries.updateFeedbackById,
      [feedbackId, subject || null, body || null,
       assessmentName || null, score || null, weightPercentage || null, senderId]
    );
    if (!rows.length) {
      return res.status(404).json({ status: "failed", message: "Feedback not found or unauthorized" });
    }
    logger.info(`Feedback ${feedbackId} updated by ${senderId}`);
    return res.status(200).json({ status: "success", data: toCamel(rows[0]) });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error updating feedback" });
  }
};

// DELETE /api/feedback/:feedbackId
const deleteFeedback = async (req, res) => {
  const { feedbackId } = req.params;
  const { senderId } = req.body;

  if (!feedbackId || !senderId) {
    return res.status(400).json({ status: "failed", message: "Missing feedbackId or senderId" });
  }

  try {
    const result = await db.query(
      feedbackQueries.deleteFeedbackById,
      [feedbackId, senderId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ status: "failed", message: "Feedback not found or unauthorized to delete" });
    }
    logger.info(`Feedback ${feedbackId} deleted by ${senderId}`);
    return res.status(200).json({ status: "success", message: "Feedback deleted" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting feedback" });
  }
};

module.exports = {
  getFeedbackBySender,
  getFeedbackByRecipient,
  getFeedbackByStudentId,
  sendFeedback,
  updateFeedback,
  deleteFeedback
};

