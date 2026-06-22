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

// Escape user-authored text before it is interpolated into report-email HTML.
// Kept local to this template module (same shape as certificateTemplate.js).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Canonical default body for each report type. Used when the teacher leaves the
// message empty, so an empty message reproduces the previous email wording.
// Uses [Student Name] / [Term] merge tags resolved per recipient.
function getDefaultEmailBody(reportType) {
  if (reportType === 'progress_report') {
    return "Dear Parent/Guardian,\n\nPlease find attached the progress report for [Student Name] for [Term]. If you have any questions or concerns about your child's progress, please don't hesitate to contact us.";
  }
  return "Dear Parent/Guardian,\n\nPlease find attached the report card for [Student Name] for [Term]. If you have any questions about your child's academic performance, please feel free to reach out.";
}

// Resolve the teacher-editable email body into safe HTML.
// Order matters: escape the raw text first (neutralizing any HTML the teacher
// typed), THEN substitute the known merge tags with escaped values — the tag
// brackets survive escaping, and unknown tags pass through untouched. Finally
// convert newlines to <br>.
function resolveEmailBody({ customMessage, reportType, studentName, term }) {
  const raw = (customMessage && customMessage.trim())
    ? customMessage
    : getDefaultEmailBody(reportType);

  return escapeHtml(raw)
    .split('[Student Name]').join(escapeHtml(studentName))
    .split('[Term]').join(escapeHtml(term))
    .replace(/\n/g, '<br>');
}

function getProgressReportEmailHTML({ studentName, term, customMessage, schoolName, customHeader, schoolInfo }) {
  const subject = customHeader || `${studentName} - Progress Report (Term ${term})`;
  
  // Create dynamic footer based on available school information
  const createSchoolFooter = (school) => {
    if (!school) {
      return `
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0 20px 0;">
        <p style="font-style: italic; color: #999; font-size: 11px; text-align: center; margin: 0;">
          Powered by School Mule
        </p>
      `;
    }

    let footer = `<hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0 20px 0;">`;
    footer += `<div style="font-style: italic; color: #666; font-size: 12px; line-height: 1.4;">`;
    footer += `<p style="margin: 0 0 4px 0;"><strong>${school.name || schoolName}</strong></p>`;
    
    // Address on its own line if available
    if (school.address) {
      footer += `<p style="margin: 0 0 2px 0;">${school.address}</p>`;
    }
    
    // Phone and email on same line if both available
    if (school.phone && school.email) {
      footer += `<p style="margin: 0 0 2px 0;">📞 ${school.phone}  |  📧 ${school.email}</p>`;
    } else if (school.phone) {
      footer += `<p style="margin: 0 0 2px 0;">📞 ${school.phone}</p>`;
    } else if (school.email) {
      footer += `<p style="margin: 0 0 2px 0;">📧 ${school.email}</p>`;
    }
    
    footer += `</div>`;
    
    return footer;
  };
  
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">${subject}</h2>
      <div style="line-height: 1.5;">${resolveEmailBody({ customMessage, reportType: 'progress_report', studentName, term })}</div>
      <p style="margin-top: 20px;">Best regards,<br><strong>${schoolName}</strong></p>
      ${createSchoolFooter(schoolInfo)}
    </div>
  `;
}

function getReportCardEmailHTML({ studentName, term, customMessage, schoolName, customHeader }) {
  const subject = customHeader || `${studentName} - Report Card (Term ${term})`;
  
  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">${subject} 🎓</h2>
      <div style="line-height: 1.5;">${resolveEmailBody({ customMessage, reportType: 'report_card', studentName, term })}</div>
      <p style="margin-top: 20px;">Best regards,<br><strong>${schoolName}</strong></p>
    </div>
  `;
}

// Certificate award email — sent from a Student View with the child's
// certificate PDF attached. Mirrors the report-card/progress-report
// templates: customHeader is the whole subject, customMessage is an
// optional shared "Message" block. No per-student merge tags.
function getCertificateEmailHTML({ studentName, viewName, customMessage, schoolName, customHeader, schoolInfo }) {
  const subject = customHeader || `${studentName} — ${viewName}`;

  // Same dynamic footer the progress-report template uses.
  const createSchoolFooter = (school) => {
    if (!school) {
      return `
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0 20px 0;">
        <p style="font-style: italic; color: #999; font-size: 11px; text-align: center; margin: 0;">
          Powered by School Mule
        </p>
      `;
    }

    let footer = `<hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0 20px 0;">`;
    footer += `<div style="font-style: italic; color: #666; font-size: 12px; line-height: 1.4;">`;
    footer += `<p style="margin: 0 0 4px 0;"><strong>${school.name || schoolName}</strong></p>`;

    if (school.address) {
      footer += `<p style="margin: 0 0 2px 0;">${school.address}</p>`;
    }

    if (school.phone && school.email) {
      footer += `<p style="margin: 0 0 2px 0;">📞 ${school.phone}  |  📧 ${school.email}</p>`;
    } else if (school.phone) {
      footer += `<p style="margin: 0 0 2px 0;">📞 ${school.phone}</p>`;
    } else if (school.email) {
      footer += `<p style="margin: 0 0 2px 0;">📧 ${school.email}</p>`;
    }

    footer += `</div>`;

    return footer;
  };

  return `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto;
                background-color: #f9f9f9; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color: #00ACC1;">${subject} 🏆</h2>
      <p>Dear Parent/Guardian,</p>
      <p>Congratulations! <strong>${studentName}</strong> has been recognized for
         <strong>${viewName}</strong>. Please find the attached certificate celebrating this achievement.</p>
      ${customMessage ? `
        <div style="padding: 15px; background: #fff; border-radius: 5px; margin: 20px 0; border-left: 4px solid #00ACC1;">
          <h3 style="margin-top: 0; color: #333; font-size: 16px;">Message:</h3>
          <p style="margin-bottom: 0; line-height: 1.5;">${customMessage.replace(/\n/g, '<br>')}</p>
        </div>
      ` : ''}
      <p>We're proud of your child's hard work and accomplishment.</p>
      <p style="margin-top: 20px;">Best regards,<br><strong>${schoolName}</strong></p>
      ${createSchoolFooter(schoolInfo)}
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
  getReportCardEmailHTML,
  getCertificateEmailHTML,
  getDefaultEmailBody,
  resolveEmailBody
};