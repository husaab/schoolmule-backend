// templates/emailTemplate.js
//
// Every email body SchoolMule sends. Layout, colours and logos live in
// emailLayout.js; this file only decides each email's words and blocks.

const {
  SCHOOLMULE_BRAND,
  schoolBrand,
  schoolDisplayName,
  escapeHtml,
  multiline,
  paragraph,
  finePrint,
  button,
  note,
  facts,
  signOff,
  schoolContact,
  renderEmail,
  COLORS,
  FONT_BODY,
} = require('./emailLayout');

const appUrl = (path) => `${process.env.FRONTEND_URL || ''}${path}`;

// ─── Account & sign-in ─────────────────────────────────────────────────────

function getVerificationEmailHTML({ name, url }) {
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'Confirm your email',
    preheader: 'One step left to activate your SchoolMule account.',
    content: [
      paragraph(`Hi ${escapeHtml(name)},`),
      paragraph('Thanks for signing up for SchoolMule. Confirm your email address so your school admin can approve your account.'),
      button('Verify email', url),
      finePrint("If you didn't create this account, you can ignore this email."),
    ].join(''),
  });
}

function getConfirmedEmailHTML({ name }) {
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'Your email is verified',
    preheader: 'Your school admin will review your account next.',
    content: [
      paragraph(`Hi ${escapeHtml(name)},`),
      paragraph("Thanks for confirming your email address. A school admin will review your account next, and we'll email you as soon as it's approved."),
    ].join(''),
  });
}

const ROLE_WORDS = { TEACHER: 'teacher', PARENT: 'parent', ADMIN: 'admin' };

// `role` and `school` are optional so older callers keep working; when the
// admin fixed the role at approval time, the email is where the person learns it.
const getApprovalEmailHTML = ({ name, role, school, childCount }) => {
  const roleWord = ROLE_WORDS[role];
  const where = school ? ` at <strong>${escapeHtml(schoolDisplayName(school))}</strong>` : '';
  const what = roleWord ? `your <strong>${roleWord}</strong> account` : 'your SchoolMule account';
  const children =
    role === 'PARENT' && Number(childCount) > 0
      ? paragraph(
          childCount === 1
            ? 'Your child is already linked, so their grades and attendance will be waiting when you sign in.'
            : `Your ${childCount} children are already linked, so their grades and attendance will be waiting when you sign in.`,
        )
      : '';
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'Your account is approved',
    preheader: 'You can sign in to SchoolMule now.',
    content: [
      paragraph(`Hi ${escapeHtml(name)},`),
      paragraph(`An administrator${where} approved ${what}. You can sign in now.`),
      children,
      button('Sign in', appUrl('/login')),
    ].join(''),
  });
};

const getAdminNotifyEmailHTML = ({ new_user, school }) =>
  renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'New account to review',
    preheader: `${new_user} is asking to join ${schoolDisplayName(school)}.`,
    content: [
      paragraph(`Hello ${escapeHtml(schoolDisplayName(school))} admins,`),
      paragraph(`<strong>${escapeHtml(new_user)}</strong> verified their email and is asking to join SchoolMule at <strong>${escapeHtml(schoolDisplayName(school))}</strong>. Review the request to approve or decline it.`),
      button('Review pending approvals', appUrl('/admin-panel/approvals')),
    ].join(''),
  });

const getDeclineEmailHTML = ({ name, school }) =>
  renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: "Your registration wasn't approved",
    preheader: `An administrator at ${schoolDisplayName(school)} reviewed your registration.`,
    content: [
      paragraph(`Hi ${escapeHtml(name)},`),
      paragraph(`An administrator at <strong>${escapeHtml(schoolDisplayName(school))}</strong> reviewed your SchoolMule registration and declined it.`),
      paragraph('If you think this is a mistake, contact your school administrator directly.'),
    ].join(''),
  });

const getResetEmailHTML = ({ name, url }) =>
  renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'Reset your password',
    preheader: 'Use this link within 15 minutes to choose a new password.',
    content: [
      paragraph(`Hi ${escapeHtml(name)},`),
      paragraph('We received a request to reset your SchoolMule password. Use the button below to choose a new one.'),
      button('Reset password', url),
      finePrint("This link expires in 15 minutes. If you didn't ask to reset your password, you can ignore this email and your password won't change."),
    ].join(''),
  });

// Sent when an admin creates an account from the Users page.
const getInviteEmailHTML = ({ name, schoolName, invitedBy, role, url }) =>
  renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: "You're invited to SchoolMule",
    preheader: `${invitedBy} created an account for you at ${schoolName}.`,
    content: [
      paragraph(`Hi ${escapeHtml(name)},`),
      paragraph(`${escapeHtml(invitedBy)} created a <strong>${escapeHtml(String(role ?? '').toLowerCase())}</strong> account for you at <strong>${escapeHtml(schoolName)}</strong>. Set a password to get started.`),
      button('Set your password', url),
      finePrint('This link expires in 7 days. If it has expired, ask your school administrator to resend the invite, or use "Forgot password" on the sign-in page.'),
    ].join(''),
  });

// ─── To the SchoolMule team ────────────────────────────────────────────────

function getContactEmailHTML({ name, email, message }) {
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'New contact form message',
    preheader: `From ${name} (${email})`,
    content: [
      facts([
        ['Name', escapeHtml(name)],
        ['Email', escapeHtml(email)],
      ]),
      note('Message', multiline(message)),
    ].join(''),
  });
}

function getTicketEmailHTML({ username, school, issueType, description, contactEmail }) {
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'New support ticket',
    preheader: `${issueType} from ${username} (${school})`,
    content: [
      facts([
        ['From', escapeHtml(username)],
        ['School', escapeHtml(school)],
        ['Contact email', escapeHtml(contactEmail)],
        ['Issue type', escapeHtml(issueType)],
      ]),
      note('Description', multiline(description)),
    ].join(''),
  });
}

// ─── Messages & feedback ───────────────────────────────────────────────────

/**
 * Messaging digest — every unread message in one thread for one recipient.
 * Sent by services/messageNotifier.js once a thread has been quiet for the
 * coalescing window, so a burst of replies arrives as one email.
 *
 * messages: [{ senderName, body, sentAtLabel, attachmentCount }]
 * contextLine: e.g. "14/20 (70%)" — null when the score must not be shown.
 */
function getConversationDigestEmailHTML({
  recipientFirstName,
  studentName,
  className,
  title,
  contextLine,
  messages,
  link,
  schoolName,
  schoolInfo,
}) {
  const first = messages[0];
  const heading =
    messages.length === 1
      ? `New message from ${first.senderName}`
      : `${messages.length} new messages about ${studentName}`;

  const blocks = messages
    .map((m) => {
      const meta = `${m.senderName} · ${m.sentAtLabel}`;
      const attach =
        m.attachmentCount > 0
          ? `<div style="margin-top:8px;font-size:13px;color:${COLORS.muted};">${m.attachmentCount} attachment${m.attachmentCount === 1 ? '' : 's'} — open in SchoolMule to view</div>`
          : '';
      return note(meta, `${multiline(m.body)}${attach}`);
    })
    .join('');

  const assessmentFact = escapeHtml(title) + (contextLine ? ` · ${escapeHtml(contextLine)}` : '');

  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading,
    preheader: `${title} · ${className}`,
    content: [
      paragraph(`Hi ${escapeHtml(recipientFirstName || 'there')},`),
      paragraph(
        `${messages.length === 1 ? 'There is a new message' : 'There are new messages'} in the conversation about <strong>${escapeHtml(studentName)}</strong>'s <strong>${escapeHtml(title)}</strong> in ${escapeHtml(className)}.`,
      ),
      facts([
        ['Student', escapeHtml(studentName)],
        ['Assessment', assessmentFact],
        ['Class', escapeHtml(className)],
      ]),
      blocks,
      button('Reply in SchoolMule', link),
      finePrint("Attachments stay inside SchoolMule so only the student's guardians and teachers can open them."),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

function getFeedbackEmailHTML({ childName, assessmentName, courseName, link }) {
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: `New feedback for ${childName}`,
    preheader: `${assessmentName} in ${courseName}`,
    content: [
      paragraph(`<strong>${escapeHtml(childName)}</strong> received feedback on <strong>${escapeHtml(assessmentName)}</strong> in ${escapeHtml(courseName)}. Sign in to read the full comments.`),
      button('View feedback', link),
    ].join(''),
  });
}

// ─── Report cards, progress reports, certificates ──────────────────────────

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

function reportEmailHTML({ reportType, label, studentName, term, customMessage, schoolName, customHeader, schoolInfo }) {
  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: customHeader || `${studentName} - ${label} (${term})`,
    preheader: `${label} for ${studentName} is attached.`,
    content: [
      facts([
        ['Student', `<strong>${escapeHtml(studentName)}</strong>`],
        ['Term', escapeHtml(term)],
      ]),
      paragraph(resolveEmailBody({ customMessage, reportType, studentName, term })),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

function getProgressReportEmailHTML(data) {
  return reportEmailHTML({ ...data, reportType: 'progress_report', label: 'Progress Report' });
}

function getReportCardEmailHTML(data) {
  return reportEmailHTML({ ...data, reportType: 'report_card', label: 'Report Card' });
}

// Certificate award email — sent from a Student View with the child's
// certificate PDF attached. customHeader is the whole subject, customMessage
// is an optional shared "Message" block. No per-student merge tags.
function getCertificateEmailHTML({ studentName, viewName, customMessage, schoolName, customHeader, schoolInfo }) {
  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: customHeader || `${studentName} — ${viewName}`,
    preheader: `${studentName} has been recognized for ${viewName}.`,
    content: [
      paragraph('Dear Parent/Guardian,'),
      paragraph(`Congratulations! <strong>${escapeHtml(studentName)}</strong> has been recognized for <strong>${escapeHtml(viewName)}</strong>. Their certificate is attached.`),
      customMessage ? note('Message', multiline(customMessage)) : '',
      paragraph("We're proud of your child's hard work and accomplishment."),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

/**
 * "New grades posted" digest — one per guardian per child per publish batch.
 *
 * assessments: [{ name, scoreLabel, pctLabel, comment }] — already formatted
 * by the caller, which owns the grade math (a category has no raw score, only
 * a rollup percentage, so scoreLabel may be empty).
 */
function getAssessmentPublishedEmailHTML({
  studentName,
  className,
  assessments,
  batchComment,
  schoolName,
  schoolInfo,
  portalUrl,
}) {
  const cell = `font-family:${FONT_BODY};padding:12px 0;border-top:1px solid ${COLORS.divider};vertical-align:top;`;
  const rows = assessments
    .map(
      (a, i) => `
    <tr>
      <td style="${cell}${i === assessments.length - 1 ? `border-bottom:1px solid ${COLORS.divider};` : ''}">
        <div style="font-size:15px;font-weight:500;line-height:1.4;color:${COLORS.heading};">${escapeHtml(a.name)}</div>
        ${a.comment ? `<div style="font-size:13px;line-height:1.5;color:${COLORS.muted};margin-top:2px;">${multiline(a.comment)}</div>` : ''}
      </td>
      <td align="right" style="${cell}${i === assessments.length - 1 ? `border-bottom:1px solid ${COLORS.divider};` : ''}padding-left:16px;text-align:right;white-space:nowrap;">
        ${a.scoreLabel ? `<div style="font-size:15px;font-weight:500;color:${COLORS.heading};">${escapeHtml(a.scoreLabel)}</div>` : ''}
        <div style="font-size:13px;font-weight:700;color:${COLORS.button};">${escapeHtml(a.pctLabel)}</div>
      </td>
    </tr>`,
    )
    .join('');

  const count = assessments.length === 1 ? 'One assessment' : `${assessments.length} assessments`;

  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: `New grades for ${studentName}`,
    preheader: `${count} in ${className} graded and shared with you.`,
    content: [
      paragraph('Dear Parent/Guardian,'),
      paragraph(`${count} in <strong>${escapeHtml(className)}</strong> ${assessments.length === 1 ? 'was' : 'were'} graded and shared with you.`),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${rows}</table>`,
      batchComment ? note('Message from the teacher', multiline(batchComment)) : '',
      button('View in Parent Portal', portalUrl),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

module.exports = {
  getVerificationEmailHTML,
  getConfirmedEmailHTML,
  getApprovalEmailHTML,
  getAdminNotifyEmailHTML,
  getDeclineEmailHTML,
  getResetEmailHTML,
  getInviteEmailHTML,
  getContactEmailHTML,
  getTicketEmailHTML,
  getConversationDigestEmailHTML,
  getFeedbackEmailHTML,
  getProgressReportEmailHTML,
  getReportCardEmailHTML,
  getCertificateEmailHTML,
  getAssessmentPublishedEmailHTML,
  getDefaultEmailBody,
  resolveEmailBody
};
