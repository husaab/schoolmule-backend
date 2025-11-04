function getVerificationEmailHTML({ name, url }) {
    return `
      <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto; background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
        <h2 style="color: #00ACC1;">Welcome to School Mule 👋</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>Thanks for signing up. Please confirm your email address to activate your account:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${url}" 
            style="background-color: #00ACC1; color: white; padding: 14px 28px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
            Verify Email
          </a>
        </div>
        <p>If you didn't create this account, you can safely ignore this email.</p>
        <p style="color: #888; font-size: 12px;">— School Mule Team</p>
      </div>
    `;
  }

  function getConfirmedEmailHTML({ name }) {
    return `
      <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto; background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
        <h2 style="color: #00ACC1;">Email Verified ✅</h2>
        <p>Hello <strong>${name}</strong>,</p>
        <p>We're excited to let you know that your email has been successfully verified at <strong>School Mule</strong>!</p>
        <p>You are now awaiting approval from a school admin.</p>
        <p style="color: #888; font-size: 12px;">— School Mule Team</p>
      </div>
    `;
}

const getApprovalEmailHTML = ({ name }) => `
  <div>
    <p>Hi ${name},</p>
    <p>Your account has been approved by the school administrator! You can now access School Mule.</p>
    <p><a href="${process.env.FRONTEND_URL}/login">Login here</a></p>
  </div>
`;

const getAdminNotifyEmailHTML = ({ new_user, school }) => `
  <div>
    <p>Hello ${school} Admins,</p>
    <p>A new user by the name of ${new_user} has verified their email and is requesting access to School Mule for <strong>${school}</strong>.</p>
    <p>Please log in and approve their account if appropriate.</p>
    <p><a href="${process.env.FRONTEND_URL}/admin-panel/approvals">Review pending approvals</a></p>
  </div>
`;

const getDeclineEmailHTML = ({ name, school }) => `
  <div>
    <p>Hi ${name},</p>
    <p>Your registration with <strong>${school}</strong> on School Mule was reviewed and unfortunately declined.</p>
    <p>If you believe this was in error, please contact your school administrator directly.</p>
    <p>— School Mule Team</p>
  </div>
`;

const getResetEmailHTML = ({ name, url }) => `
  <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto; background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
    <h2 style="color: #00ACC1;">Reset Your Password 🔐</h2>
    <p>Hello <strong>${name}</strong>,</p>
    <p>We received a request to reset your password for your School Mule account. If you made this request, click the button below:</p>
    <div style="text-align: center; margin: 30px 0;">
      <a href="${url}" 
        style="background-color: #00ACC1; color: white; padding: 14px 28px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
        Reset Password
      </a>
    </div>
    <p>This link will expire in 15 minutes. If you didn't request a password reset, please ignore this email.</p>
    <p style="color: #888; font-size: 12px;">— School Mule Team</p>
  </div>
`;

// src/controllers/emailTemplates.js
function getContactEmailHTML({ name, email, message }) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Message:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
      <p style="color: #888; font-size: 12px;">— School Mule Team</p>
    </div>
  `;
}

function getTicketEmailHTML({ username, school, issueType, description, contactEmail }) {
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">New Support Ticket</h2>
      <p><strong>Username:</strong> ${username}</p>
      <p><strong>School:</strong> ${school}</p>
      <p><strong>Contact Email:</strong> ${contactEmail}</p>
      <p><strong>Issue Type:</strong> ${issueType}</p>
      <p><strong>Description:</strong></p>
      <p>${description.replace(/\n/g, '<br>')}</p>
      <p style="color: #888; font-size: 12px;">— School Mule Team</p>
    </div>
  `;
}

/**
 * New message notification template
 * @param {string} fromName – sender’s name
 * @param {string} subject – message subject
 * @param {string} link – URL users click to read the full message
 */
function getNewMessageEmailHTML({ fromName, subject, body, link }) {
  // preserve line breaks by converting \n to <br>
  const formattedBody = body
    .split('\n')
    .map(line => `<p style="margin:0 0 8px;">${line}</p>`)
    .join('');

  return `
    <div style="font-family:Arial,sans-serif;padding:20px;max-width:600px;margin:auto;
                background:#f9f9f9;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
      <h2 style="color:#00ACC1;margin-bottom:16px;">You’ve Got a New Message 📬</h2>
      <p style="margin-bottom:8px;"><strong>From:</strong> ${fromName}</p>
      <p style="margin-bottom:8px;"><strong>Subject:</strong> ${subject || '<em>(No subject)</em>'}</p>
      <div style="margin:16px 0;padding:12px;background:#fff;border-radius:4px;border:1px solid #e0e0e0;">
        <h3 style="margin-top:0;margin-bottom:8px;font-weight:600;">Message:</h3>
        ${formattedBody}
      </div>
      <div style="text-align:center;margin:30px 0;">
        <a href="${link}"
           style="background-color:#00ACC1;color:white;padding:12px 24px;
                  text-decoration:none;border-radius:5px;font-weight:bold;display:inline-block;">
          Read Message in Communication Inbox
        </a>
      </div>
      <p style="color:#888;font-size:12px;margin-top:16px;">— School Mule Team</p>
    </div>
  `;
}

// at the bottom of src/utils/emailTemplate.js
function getFeedbackEmailHTML({ childName, assessmentName, courseName, link }) {
  return `
    <div style="font-family: Arial, sans-serif; padding:20px; max-width:600px; margin:auto;
                background-color:#f9f9f9; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
      <h2 style="color:#00ACC1;">New Feedback for ${childName} 📝</h2>
      <p>Your child, <strong>${childName}</strong>, has received feedback for <strong>${assessmentName}</strong> in ${courseName}.</p>
      <p>Log in to view the full comments and details:</p>
      <div style="text-align:center; margin: 30px 0;">
        <a href="${link}"
           style="background-color:#00ACC1; color:white; padding:12px 24px; text-decoration:none;
                  border-radius:5px; font-weight:bold; display:inline-block;">
          View Feedback
        </a>
      </div>
      <p style="color:#888; font-size:12px;">— School Mule Team</p>
    </div>
  `;
}

function getProgressReportEmailHTML({ studentName, term, customMessage, schoolName, customHeader }) {
  const subject = customHeader || `${studentName} - Progress Report (Term ${term})`;
  
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">${subject} 📊</h2>
      <p>Dear Parent/Guardian,</p>
      <p>Please find attached the progress report for <strong>${studentName}</strong> for <strong>${term}</strong>.</p>
      ${customMessage ? `
        <div style="padding: 15px; background: #fff; border-radius: 5px; margin: 20px 0; border-left: 4px solid #00ACC1;">
          <h3 style="margin-top: 0; color: #333; font-size: 16px;">Teacher's Message:</h3>
          <p style="margin-bottom: 0; line-height: 1.5;">${customMessage.replace(/\n/g, '<br>')}</p>
        </div>
      ` : ''}
      <p>If you have any questions or concerns about your child's progress, please don't hesitate to contact us.</p>
      <p style="margin-top: 30px;">Best regards,<br><strong>${schoolName}</strong></p>
      <p style="color: #888; font-size: 12px; margin-top: 30px;">— School Mule Team</p>
    </div>
  `;
}

function getReportCardEmailHTML({ studentName, term, customMessage, schoolName, customHeader }) {
  const subject = customHeader || `${studentName} - Report Card (Term ${term})`;
  
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">${subject} 🎓</h2>
      <p>Dear Parent/Guardian,</p>
      <p>Please find attached the report card for <strong>${studentName}</strong> for <strong>${term}</strong>.</p>
      ${customMessage ? `
        <div style="padding: 15px; background: #fff; border-radius: 5px; margin: 20px 0; border-left: 4px solid #00ACC1;">
          <h3 style="margin-top: 0; color: #333; font-size: 16px;">Teacher's Message:</h3>
          <p style="margin-bottom: 0; line-height: 1.5;">${customMessage.replace(/\n/g, '<br>')}</p>
        </div>
      ` : ''}
      <p>If you have any questions about your child's academic performance, please feel free to reach out.</p>
      <p style="margin-top: 30px;">Best regards,<br><strong>${schoolName}</strong></p>
      <p style="color: #888; font-size: 12px; margin-top: 30px;">— School Mule Team</p>
    </div>
  `;
}

module.exports = {
  getVerificationEmailHTML,
  getConfirmedEmailHTML,
  getApprovalEmailHTML,
  getAdminNotifyEmailHTML,
  getDeclineEmailHTML,
  getResetEmailHTML,
  getContactEmailHTML,
  getTicketEmailHTML,
  getNewMessageEmailHTML,
  getFeedbackEmailHTML,
  getProgressReportEmailHTML,
  getReportCardEmailHTML
};