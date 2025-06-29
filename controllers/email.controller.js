// src/controllers/email.controller.js
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const { getContactEmailHTML, getTicketEmailHTML } = require('../utils/emailTemplate');

async function sendContactEmail(req, res) {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ success:false, message:'Missing name, email or message' });
  }

  const html = getContactEmailHTML({ name, email, message });

  await resend.emails.send({
    from: 'contact@schoolmule.ca',
    to: process.env.SUPPORT_EMAIL,
    subject: `School Mule Contact Form: ${name}`,
    html
  });

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

  await resend.emails.send({
    from: `support@${process.env.MAIL_DOMAIN}`,
    to: process.env.SUPPORT_EMAIL,
    subject: `Ticket: ${issueType} (from ${username} , school: ${school})`,
    html
  });

  return res.status(200).json({ success:true, message:'Support ticket submitted' });
}

module.exports = {
  sendContactEmail,
  sendTicketEmail,
};