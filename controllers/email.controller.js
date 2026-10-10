// src/controllers/email.controller.js
const logger = require('../logger');
const { getContactEmailHTML, getTicketEmailHTML } = require('../templates/emailTemplate');
const { getResend, sendOrThrow } = require('../utils/emailUtils');
const { platformSender } = require('../services/email/senderIdentity');

async function sendContactEmail(req, res) {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ success:false, message:'Missing name, email or message' });
  }

  const html = getContactEmailHTML({ name, email, message });

  try {
    // Reply-To is the visitor, so a reply from the support inbox goes straight back to them.
    await sendOrThrow(getResend(), {
      ...platformSender('contact', { replyTo: email }),
      to: process.env.SUPPORT_EMAIL,
      subject: `School Mule Contact Form: ${name}`,
      html
    });
  } catch (error) {
    // A visitor's message is lost if this fails, so make the failure visible.
    logger.error({ err: error, email }, 'Contact form email failed to send');
    return res.status(500).json({ success:false, message:'Your message could not be sent. Please try again in a moment.' });
  }

  return res.status(200).json({ success:true, message:'Contact email sent' });
}

/**
 * POST /api/email/ticket
 * Authenticated users only.
 * Body: { issueType, description }
 */
async function sendTicketEmail(req, res) {
  const { username, school, issueType, description, contactEmail } = req.body;
  if (!username || !school || !issueType || !description || !contactEmail) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }

  const html = getTicketEmailHTML({
    username,
    school,
    issueType,
    description,
    contactEmail
  });

  try {
    await sendOrThrow(getResend(), {
      ...platformSender('support', { replyTo: contactEmail }),
      to: process.env.SUPPORT_EMAIL,
      subject: `Ticket: ${issueType} (from ${username} , school: ${school})`,
      html
    });
  } catch (error) {
    logger.error({ err: error, school, username }, 'Support ticket email failed to send');
    return res.status(500).json({ success:false, message:'Your ticket could not be sent. Please try again in a moment.' });
  }

  return res.status(200).json({ success:true, message:'Support ticket submitted' });
}

module.exports = {
  sendContactEmail,
  sendTicketEmail,
};
