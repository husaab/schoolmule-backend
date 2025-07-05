// controllers/message.controller.js
const db = require("../config/database");
const messageQueries = require("../queries/message.queries");
const logger = require("../logger");
const { Resend } = require("resend")
const { getNewMessageEmailHTML } = require("../utils/emailTemplate")
const { selectParentsBySchool } = require('../queries/user.queries');

const resend = new Resend(process.env.RESEND_API_KEY)

// GET /api/messages/sent?senderId=<uuid>
const getMessagesBySender = async (req, res) => {
  const senderId = req.query.senderId;
  if (!senderId) {
    return res.status(400).json({ status: "failed", message: "Missing query parameter: senderId" });
  }
  try {
    const { rows } = await db.query(messageQueries.selectMessagesBySender, [senderId]);
    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching sent messages" });
  }
};

// GET /api/messages/inbox?recipientId=<uuid>
const getMessagesByRecipient = async (req, res) => {
  const recipientId = req.query.recipientId;
  if (!recipientId) {
    return res.status(400).json({ status: "failed", message: "Missing query parameter: recipientId" });
  }
  try {
    const { rows } = await db.query(messageQueries.selectMessagesByRecipient, [recipientId]);
    return res.status(200).json({ status: "success", data: rows });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error fetching inbox messages" });
  }
};

// POST /api/messages
const sendMessage = async (req, res) => {
  const { senderId, recipientId, subject, body, school, senderName, recipientName } = req.body;
  if (!senderId || !recipientId || !body || !school || !senderName || !recipientName) {
    return res.status(400).json({
      status: "failed",
      message: "Missing required fields: senderId, recipientId, school, senderName, recipientName, and body",
    });
  }
  try {
    const { rows } = await db.query(
      messageQueries.insertMessage,
      [senderId, recipientId, school, subject || null, body, senderName, recipientName]
    );

    const userRes = await db.query(
      "SELECT email FROM users WHERE user_id = $1",
      [recipientId]
    );
    if (userRes.rows.length === 0) {
      throw new Error("Recipient not found");
    }
    const recipientEmail = userRes.rows[0].email;

    // 3) build front-end link
    const link = process.env.FRONTEND_URL;

    // 4) render HTML, send via Resend
    const html = getNewMessageEmailHTML({
      fromName: senderName,
      subject: subject || "",
      link
    });

    await resend.emails.send({
      from: "notifications@schoolmule.ca",
      to: recipientEmail,
      subject: `New message from ${senderName} on School Mule`,
      html,
    })

    logger.info(`Message sent from ${senderId} to ${recipientId}`);

    return res.status(201).json({ status: "success", data: rows[0] });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error sending message" });
  }
};

// PATCH /api/messages/:messageId
const updateMessage = async (req, res) => {
  const { messageId } = req.params;
  const { senderId, subject, body } = req.body;
  if (!messageId || !senderId) {
    return res.status(400).json({ status: "failed", message: "Missing messageId or senderId" });
  }
  try {
    const { rows } = await db.query(
      messageQueries.updateMessageById,
      [messageId, subject || null, body || null, senderId]
    );
    if (!rows.length) {
      return res.status(404).json({ status: "failed", message: "Message not found or unauthorized" });
    }
    logger.info(`Message ${messageId} updated by ${senderId}`);
    return res.status(200).json({ status: "success", data: rows[0] });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error updating message" });
  }
};

// DELETE /api/messages/:messageId
const deleteMessage = async (req, res) => {
  const { messageId } = req.params;
  const { senderId } = req.body;
  if (!messageId || !senderId) {
    return res.status(400).json({ status: "failed", message: "Missing messageId or senderId" });
  }
  try {
    const result = await db.query(
      messageQueries.deleteMessageById,
      [messageId, senderId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ status: "failed", message: "Message not found or unauthorized to delete" });
    }
    logger.info(`Message ${messageId} deleted by ${senderId}`);
    return res.status(200).json({ status: "success", message: "Message deleted" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: "failed", message: "Error deleting message" });
  }
};

/**
 * POST /api/messages/mass/parents
 *  Body: { senderId, school, subject, body, senderName }
 */
const sendToAllParents = async (req, res) => {
  const { senderId, school, subject, body, senderName } = req.body;
  if (!senderId || !school || !body || !senderName) {
    return res.status(400).json({ status:'failed', message:'Missing fields for mass send.' });
  }

  try {
    // 1) insert a “system” record? (optional) or skip DB insert and just email
    // 2) fetch parents
    const parents = (await db.query(selectParentsBySchool, [school])).rows;
    if (!parents.length) {
      return res.status(404).json({ status:'failed', message:'No parents found.' });
    }

    // 3) for each parent: insert into messages & send email
    for (let p of parents) {
      await db.query(
        messageQueries.insertMessage,
        [senderId, p.user_id, school, subject || null, body, senderName, `${p.first_name} ${p.last_name}`]
      );

      const link = process.env.FRONTEND_URL;

      const html = getNewMessageEmailHTML({
        fromName: senderName,
        subject,
        link
      });

      await resend.emails.send({
        from: "notifications@schoolmule.ca",
        to: p.email,
        subject: `New message from ${senderName}`,
        html,
      });
    }

    logger.info(`Mass message from ${senderId} to all parents of ${school}`);
    return res.status(200).json({ status:'success', message:'Sent to all parents' });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status:'failed', message:'Error in mass send' });
  }
};

/**
 * POST /api/messages/mass/parents/grade
 * Body: { senderId, school, grade, subject, body, senderName }
 */
const sendToParentsByGrade = async (req, res) => {
  const { senderId, school, grade, subject, body, senderName } = req.body;
  if (!senderId || !school || grade == null || !body || !senderName) {
    return res.status(400).json({ status: 'failed', message: 'Missing fields for grade-send.' });
  }

  try {
    // fetch parents of students in that grade & school
    const parents = (await db.query(
      messageQueries.selectParentsByGrade,
      [grade, school]
    )).rows;

    if (!parents.length) {
      return res.status(404).json({ status: 'failed', message: 'No parents found for that grade.' });
    }

    const link = process.env.FRONTEND_URL;

    for (let p of parents) {
      // record in DB
      await db.query(
        messageQueries.insertMessage,
        [senderId, p.user_id, school, subject || null, body, senderName, p.name]
      );
      // send the email
      const html = getNewMessageEmailHTML({
        fromName: senderName,
        subject,
        link
      });
      await resend.emails.send({
        from: "notifications@schoolmule.ca",
        to: p.email,
        subject: `New message from ${senderName}`,
        html,
      });
    }

    logger.info(`Mass message from ${senderId} to all parents of grade ${grade} in ${school}`);
    return res.status(200).json({ status:'success', message:'Sent to parents by grade' });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status:'failed', message:'Error in grade-mass send' });
  }
};

module.exports = {
  getMessagesBySender,
  getMessagesByRecipient,
  sendMessage,
  updateMessage,
  deleteMessage,
  sendToAllParents,
  sendToParentsByGrade
};