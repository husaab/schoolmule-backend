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
  buttonRow,
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

// To a school's admins when students ask for accounts (at most one an hour).
// No names or addresses: the request was typed by someone not yet trusted,
// and the queue on the Approvals page is the place to read it.
const getStudentRequestNotifyEmailHTML = ({ schoolName, pendingCount }) => {
  const waiting = pendingCount === 1 ? '1 student account request is' : `${pendingCount} student account requests are`;
  return renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: 'Students asked for accounts',
    preheader: `${waiting} waiting at ${schoolName}.`,
    content: [
      paragraph(`Hello ${escapeHtml(schoolName)} admins,`),
      paragraph(`${escapeHtml(waiting)} waiting for you to review. Match each one to the student's record to send their invite, or decline it.`),
      button('Review requests', appUrl('/admin-panel/approvals?role=STUDENT')),
    ].join(''),
  });
};

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

// ─── Student accounts (Admin Panel → Student accounts) ─────────────────────
// Both speak in the school's voice. `invitedBy` / `requestedBy` is the admin
// who clicked the button; the invite copy names the school instead.

/**
 * Sent when an admin invites a student (or a teacher resends it). The link
 * opens /student-invite, where the student continues with Google or (unless
 * the school is Google-only) chooses a password.
 */
const getStudentInviteEmailHTML = ({ firstName, fullName, schoolName, schoolInfo, url, email, expiresOn, googleOnly }) =>
  renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: 'Your SchoolMule student account',
    preheader: `${schoolName} set up a SchoolMule account for you.`,
    content: [
      paragraph(`Hi ${escapeHtml(firstName)},`),
      paragraph(`${escapeHtml(schoolName)} set up a SchoolMule account for you. You'll see your classes, what's due and your grades there.`),
      paragraph(googleOnly
        ? `Sign in with your school Google account, <strong>${escapeHtml(email)}</strong>.`
        : `Use your school Google account, <strong>${escapeHtml(email)}</strong>, or choose a password.`),
      button('Set up my account', url),
      finePrint(`This link works once and expires on ${escapeHtml(expiresOn)}. If it has expired, ask your teacher or the school office for a new one. If you aren't ${escapeHtml(fullName)}, you can ignore this email.`),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });

/**
 * Sent once to a student's guardians when the student first sets up their
 * own sign-in (a password or Google; a card scan at school doesn't count), so
 * a family notices an account they didn't expect.
 */
const getStudentAccountReadyEmailHTML = ({ firstName, schoolName, schoolInfo, activatedOn, via }) => {
  const how = via === 'google' ? 'signed in with Google' : 'set a password';
  const name = escapeHtml(firstName);
  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: `${firstName}'s SchoolMule account is ready`,
    preheader: `${firstName} set up a SchoolMule student account.`,
    content: [
      paragraph('Hi there,'),
      paragraph(`${name} set up a SchoolMule student account on ${escapeHtml(activatedOn)} (${how}). ${name} can now see classes, work and grades there.`),
      finePrint(`If you don't think ${name} did this, contact the school office.`),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
};

/** Sent when an admin (or, later, a teacher) asks for a new password link for a student. */
const getStudentPasswordResetEmailHTML = ({ firstName, schoolName, schoolInfo, requestedBy, url }) =>
  renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: 'Reset your SchoolMule password',
    preheader: 'Choose a new password for your SchoolMule account.',
    content: [
      paragraph(`Hi ${escapeHtml(firstName)},`),
      paragraph(`${escapeHtml(requestedBy)} asked for a new password link for your account.`),
      button('Choose a new password', url),
      finePrint("This link expires in 7 days. If you didn't expect this, tell your teacher."),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
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
/**
 * Attachment line under a message or announcement body. With a `files` list
 * (from emailAttachments) it names what is attached and what was too large;
 * with only a count (previews, older callers) it says how many there are.
 */
function attachmentLine(files, count, fallback) {
  if (Array.isArray(files) && files.length) {
    const attached = files.filter((f) => f.attached).map((f) => escapeHtml(f.fileName));
    const skipped = files.filter((f) => !f.attached).map((f) => escapeHtml(f.fileName));
    const parts = [];
    if (attached.length) parts.push(`📎 Attached: ${attached.join(', ')}`);
    if (skipped.length) parts.push(`${skipped.join(', ')} — too large to attach; open in SchoolMule to download`);
    return `<div style="margin-top:8px;font-size:13px;color:${COLORS.muted};">${parts.join('<br>')}</div>`;
  }
  if (count > 0) {
    return `<div style="margin-top:8px;font-size:13px;color:${COLORS.muted};">${count} attachment${count === 1 ? '' : 's'} — ${fallback}</div>`;
  }
  return '';
}
const anyAttached = (lists) => lists.some((files) => Array.isArray(files) && files.some((f) => f.attached));

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
  forStudent = false,
  parentsIncluded = true,
}) {
  if (forStudent) {
    return studentConversationDigest({ recipientFirstName, className, title, contextLine, messages, link, schoolName, schoolInfo, parentsIncluded });
  }
  const first = messages[0];
  const heading =
    messages.length === 1
      ? `New message from ${first.senderName}`
      : `${messages.length} new messages about ${studentName}`;

  const blocks = messages
    .map((m) => {
      const meta = `${m.senderName} · ${m.sentAtLabel}`;
      const attach = attachmentLine(m.attachments, m.attachmentCount, 'open in SchoolMule to view');
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
      anyAttached(messages.map((m) => m.attachments))
        ? finePrint("The attached files are also kept in SchoolMule, where only the student's guardians and teachers can open them.")
        : '',
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

/**
 * The same digest addressed to the student in their own thread (T17): the
 * conversation and class (a score only once published), and the reminder
 * that their parents are in the conversation too (unless the school keeps
 * this item thread from parents).
 */
function studentConversationDigest({ recipientFirstName, className, title, contextLine, messages, link, schoolName, schoolInfo, parentsIncluded }) {
  const first = messages[0];
  const heading = messages.length === 1 ? `New message from ${first.senderName}` : `${messages.length} new messages`;
  const blocks = messages
    .map((m) => {
      const meta = `${m.senderName} · ${m.sentAtLabel}`;
      const attach = attachmentLine(m.attachments, m.attachmentCount, 'open in SchoolMule to view');
      return note(meta, `${multiline(m.body)}${attach}`);
    })
    .join('');
  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading,
    preheader: `${title} · ${className}`,
    content: [
      paragraph(`Hi ${escapeHtml(recipientFirstName || 'there')},`),
      paragraph(
        `${messages.length === 1 ? 'There is a new message' : 'There are new messages'} in your conversation <strong>${escapeHtml(title)}</strong> in ${escapeHtml(className)}.`,
      ),
      facts([
        ['Conversation', escapeHtml(title) + (contextLine ? ` · ${escapeHtml(contextLine)}` : '')],
        ['Class', escapeHtml(className)],
      ]),
      blocks,
      button('Reply in SchoolMule', link),
      parentsIncluded ? finePrint('Your parents are in every conversation with your teachers. They can read and reply.') : '',
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

/**
 * Guardian invite — a teacher wrote to a guardian who has no account yet.
 * The link is the admin-invite "set your password" flow with `next` pointing
 * at the thread, so they land in the conversation. `reminder` swaps the
 * heading for the one follow-up sent three days later.
 */
function getGuardianInviteEmailHTML({
  recipientFirstName, teacherName, studentFirstName, title, preview, url, schoolName, schoolInfo, reminder = false,
}) {
  const heading = reminder
    ? `Still waiting for you: a message about ${studentFirstName}`
    : `${teacherName} sent you a message about ${studentFirstName}`;
  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading,
    preheader: `${title} · ${schoolName}`,
    content: [
      paragraph(`Hi ${escapeHtml(recipientFirstName || 'there')},`),
      paragraph(
        `${escapeHtml(studentFirstName)}'s teacher <strong>${escapeHtml(teacherName)}</strong> wrote to you on SchoolMule, ${escapeHtml(schoolName)}'s parent portal. You don't have an account yet, so the message is waiting for you.`,
      ),
      preview ? note(`${teacherName} · ${title}`, multiline(preview)) : facts([['Subject', escapeHtml(title)]]),
      button('Create your account and read the message', url),
      finePrint('Sign up with this email address and your child will already be linked to you. This link expires in 7 days; if it has expired, ask the school to resend it.'),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

/**
 * Announcement — one post to every guardian in a class, grade, school or a
 * hand-picked set of families. `kind` picks the call to action: 'account' →
 * read in the portal, 'invite' → finish the pending account (fresh invite
 * link), 'signup' → create an account on the school's parent sign-up page.
 * childNames: the recipient's children in the audience (empty for school-wide).
 * ackRequested + ackLink: the author asked for a "Got it"; the button opens the
 * portal with &ack=1 so the acknowledgement is recorded once signed in.
 */
// The author's avatar (a hosted 96px PNG shown at 40px) beside a line of trusted markup.
function avatarLine(avatarUrl, html) {
  if (!avatarUrl) return paragraph(html);
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
    <tr>
      <td style="padding:0 12px 0 0;vertical-align:middle;"><img src="${escapeHtml(avatarUrl)}" width="40" height="40" alt="" style="display:block;border:0;outline:none;border-radius:20px;"></td>
      <td style="vertical-align:middle;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${COLORS.text};">${html}</td>
    </tr>
  </table>`;
}

// A student's copy of a Stream post: their own words, no "Got it" (guardians
// acknowledge) and no reply-by-email (students ask in SchoolMule, D14).
function studentAnnouncementEmailHTML({
  recipientFirstName, authorName, authorAvatarUrl, scopeLabel, title, body, attachmentCount, attachments, link, schoolName, schoolInfo,
}) {
  const author = escapeHtml(authorName);
  const where = scopeLabel === 'Selected families' ? 'a selected group of students' : escapeHtml(scopeLabel);
  const attach = attachmentLine(attachments, attachmentCount, 'open SchoolMule to download');
  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: title,
    preheader: `${scopeLabel} · ${schoolName}`,
    content: [
      paragraph(`Hi ${escapeHtml(recipientFirstName || 'there')},`),
      avatarLine(authorAvatarUrl, `<strong>${author}</strong> posted in <strong>${where}</strong>.`),
      facts([
        ['For', escapeHtml(scopeLabel)],
        ['Posted by', author],
      ]),
      note(authorName, `${multiline(body)}${attach}`),
      button('Open in SchoolMule', link),
      finePrint('Questions? Ask your teacher in SchoolMule. Your parents get this announcement too.'),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

function getAnnouncementEmailHTML({
  recipientFirstName, authorName, authorAvatarUrl = null, scopeLabel, childNames = [], title, body, attachmentCount = 0, attachments = [], link,
  kind = 'account', ackRequested = false, ackLink = null, schoolName, schoolInfo,
}) {
  if (kind === 'student') {
    return studentAnnouncementEmailHTML({
      recipientFirstName, authorName, authorAvatarUrl, scopeLabel, title, body, attachmentCount, attachments, link, schoolName, schoolInfo,
    });
  }
  const children = childNames.filter(Boolean).map(escapeHtml);
  const custom = scopeLabel === 'Selected families';
  const whose = children.length === 0 ? '' : custom
    ? (children.length === 1 ? `, ${children[0]}'s` : `, ${children.join(' and ')}'s`)
    : (children.length === 1 ? `, ${children[0]}'s class` : `, ${children.join(' and ')}'s classes`);
  const audience = custom ? 'a selected group of families' : escapeHtml(scopeLabel);
  const attach = attachmentLine(attachments, attachmentCount, 'attached to the email parents receive');
  const replyHint = `Have a question? Reply to this email or open SchoolMule and choose “Reply privately” to write to ${escapeHtml(authorName)}.`;
  const cta = kind === 'account'
    ? [
        ackRequested && ackLink
          ? buttonRow([{ label: 'Got it ✓', url: ackLink }, { label: 'Read in SchoolMule', url: link }])
          : button('Read in SchoolMule', link),
        finePrint(`${ackRequested ? '“Got it” opens SchoolMule and records that you have read this. ' : ''}${replyHint}`),
      ]
    : kind === 'invite'
      ? [
          paragraph('Your SchoolMule account is waiting to be set up. Choose a password and this announcement will be the first thing you see.'),
          button('Set up your account', link),
          finePrint('This link expires in 7 days; if it has expired, ask the school to resend it.'),
        ]
      : [
          paragraph("You don't have a SchoolMule account yet. Create one with this email address and your child will already be linked to you, so attachments, grades and messages are all in one place."),
          button('Create your account', link),
          finePrint('Sign up with the email address this message was sent to. The school office approves new parent accounts.'),
        ];

  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: title,
    preheader: `${scopeLabel} · ${schoolName}`,
    content: [
      paragraph(`Hi ${escapeHtml(recipientFirstName || 'there')},`),
      paragraph(`<strong>${escapeHtml(authorName)}</strong> posted an announcement to <strong>${audience}</strong>${whose}.`),
      facts([
        ['For', escapeHtml(scopeLabel) + (children.length ? ` · ${children.join(', ')}` : '')],
        ['Posted by', escapeHtml(authorName)],
      ]),
      note(authorName, `${multiline(body)}${attach}`),
      ...cta,
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
    heading: customHeader || `${studentName} — ${label} (${term})`,
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

// The graded assessments table: category, name and the teacher's note on the
// left; score and percentage on the right (rose when missing).
function gradeRowsTable(assessments) {
  const cell = `font-family:${FONT_BODY};padding:12px 0;border-top:1px solid ${COLORS.divider};vertical-align:top;`;
  const rows = assessments
    .map((a, i) => {
      const last = i === assessments.length - 1 ? `border-bottom:1px solid ${COLORS.divider};` : '';
      const ink = a.isMissing ? COLORS.missing : COLORS.heading;
      return `
    <tr>
      <td style="${cell}${last}">
        ${a.group ? `<div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;line-height:1.4;color:${COLORS.muted};margin:0 0 2px;">${escapeHtml(a.group)}</div>` : ''}
        <div style="font-size:15px;font-weight:500;line-height:1.4;color:${COLORS.heading};">${escapeHtml(a.name)}</div>
        ${a.comment ? `<div style="font-size:13px;line-height:1.5;color:${COLORS.muted};margin-top:2px;">${multiline(a.comment)}</div>` : ''}
      </td>
      <td align="right" style="${cell}${last}padding-left:16px;text-align:right;white-space:nowrap;">
        ${a.scoreLabel ? `<div style="font-size:15px;font-weight:600;color:${ink};">${escapeHtml(a.scoreLabel)}</div>` : ''}
        <div style="font-size:13px;font-weight:700;color:${a.isMissing ? COLORS.missing : COLORS.button};">${escapeHtml(a.pctLabel)}</div>
      </td>
    </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${rows}</table>`;
}

const currentGrade = (className, runningGradeLabel) =>
  runningGradeLabel
    ? paragraph(`Current grade in ${escapeHtml(className)}: <strong>${escapeHtml(runningGradeLabel)}</strong>. Work that has not been graded yet is not included.`)
    : '';

/**
 * "New grades posted" digest — one per guardian per child per publish batch.
 *
 * assessments: [{ name, group?, scoreLabel, pctLabel, isMissing?, comment? }],
 * one row per released item, already formatted by the caller, which owns the
 * grade math. `group` is the category the item sits in. `speak` ({ label, url })
 * adds "Speak to <teacher> about this" beside View in Parent Portal. `setupUrl`
 * is for an address with no account: "Create your account" takes the portal
 * button's place, with "Speak to …" (to the same signup) beside it.
 */
function getAssessmentPublishedEmailHTML({
  studentName,
  className,
  assessments,
  batchComment,
  runningGradeLabel,
  schoolName,
  schoolInfo,
  portalUrl,
  speak = null,
  setupUrl = null,
}) {
  const count = assessments.length === 1 ? 'One assessment' : `${assessments.length} assessments`;

  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: `New grades for ${studentName}`,
    preheader: `${count} in ${className} graded and shared with you.`,
    content: [
      paragraph('Dear Parent/Guardian,'),
      paragraph(`${count} in <strong>${escapeHtml(className)}</strong> ${assessments.length === 1 ? 'was' : 'were'} graded and shared with you.`),
      gradeRowsTable(assessments),
      currentGrade(className, runningGradeLabel),
      batchComment ? note('Message from the teacher', multiline(batchComment)) : '',
      ...(setupUrl
        ? [
          speak ? buttonRow([{ label: 'Create your account', url: setupUrl }, speak]) : button('Create your account', setupUrl),
          finePrint(`You don't have a SchoolMule account yet. Create one with this email address to see all of ${escapeHtml(studentName)}'s grades and message the teachers.`),
        ]
        : [speak ? buttonRow([{ label: 'View in Parent Portal', url: portalUrl }, speak]) : button('View in Parent Portal', portalUrl)]),
      signOff(schoolName),
    ].join(''),
    footer: schoolContact(schoolInfo, schoolName),
  });
}

/**
 * The publish email for several classes at once (one per student): a section
 * per class with its graded lines and current grade. Used by
 * scripts/backfillPublishDigests.js. classes: [{ className, assessments, runningGradeLabel }]
 */
function getGradesDigestEmailHTML({ studentName, classes, schoolName, schoolInfo, portalUrl }) {
  const total = classes.reduce((n, c) => n + c.assessments.length, 0);
  const count = total === 1 ? 'One assessment' : `${total} assessments`;
  const where = classes.length === 1 ? `<strong>${escapeHtml(classes[0].className)}</strong>` : `${classes.length} classes`;
  const sections = classes
    .map((c) => [
      `<p style="margin:24px 0 4px;font-family:${FONT_BODY};font-size:17px;font-weight:600;line-height:1.3;color:${COLORS.heading};">${escapeHtml(c.className)}</p>`,
      gradeRowsTable(c.assessments),
      currentGrade(c.className, c.runningGradeLabel),
    ].join(''))
    .join('');

  return renderEmail({
    brand: schoolBrand(schoolInfo, schoolName),
    heading: `New grades for ${studentName}`,
    preheader: `${count} in ${classes.length === 1 ? classes[0].className : `${classes.length} classes`} graded and shared with you.`,
    content: [
      paragraph('Dear Parent/Guardian,'),
      paragraph(`${count} in ${where} ${total === 1 ? 'was' : 'were'} graded and shared with you.`),
      sections,
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
  getStudentRequestNotifyEmailHTML,
  getDeclineEmailHTML,
  getResetEmailHTML,
  getInviteEmailHTML,
  getStudentInviteEmailHTML,
  getStudentAccountReadyEmailHTML,
  getStudentPasswordResetEmailHTML,
  getContactEmailHTML,
  getTicketEmailHTML,
  getConversationDigestEmailHTML,
  getGuardianInviteEmailHTML,
  getAnnouncementEmailHTML,
  getFeedbackEmailHTML,
  getProgressReportEmailHTML,
  getReportCardEmailHTML,
  getCertificateEmailHTML,
  getAssessmentPublishedEmailHTML,
  getGradesDigestEmailHTML,
  getDefaultEmailBody,
  resolveEmailBody
};
