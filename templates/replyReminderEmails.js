// templates/replyReminderEmails.js
//
// The reply-reminder emails (services/replyReminders.js): the teacher's two
// reminders, the office's "no reply" email, and the parent's one nudge. Each
// carries the conversation's messages in full, so it can be read without
// signing in. Several conversations for one person on one day go in one
// email. Each returns { subject, html }. Callers pass plain text (escaped
// here) and ready-made Toronto date labels.
//
// A thread: { kind, title, studentName, studentGrade, classSubject, fromLabel,
//   wroteLabel, step, teacherNames, teacherCount, reminders, remindedLabel,
//   unreachable, messages: [{ senderLabel, sentAtLabel, body, fileNames }], link }

const {
  schoolBrand, escapeHtml, multiline, paragraph, finePrint, button, note, facts, signOff, schoolContact, renderEmail,
  COLORS, FONT_BODY,
} = require('./emailLayout');

const hi = (name) => paragraph(`Hi ${escapeHtml(name || 'there')},`);

/** "Amina's <strong>Handwriting 2</strong> (Arabic)" or, for a General thread, "Amina: <strong>Field trip</strong> (Homeroom)". */
const topicHtml = (t) => {
  const title = `<strong style="color:${COLORS.heading};">${escapeHtml(t.title)}</strong>`;
  const subject = t.classSubject ? ` (${escapeHtml(t.classSubject)})` : '';
  return t.kind === 'assessment'
    ? `${escapeHtml(t.studentName)}'s ${title}${subject}`
    : `${escapeHtml(t.studentName)}: ${title}${subject}`;
};

const filesLine = (names) => (names && names.length
  ? `<div style="margin-top:8px;font-size:13px;color:${COLORS.muted};">Attachment${names.length === 1 ? '' : 's'}: ${names.map(escapeHtml).join(', ')} (open in SchoolMule to view)</div>`
  : '');

/** The conversation, message by message. */
const messageBlocks = (messages) => messages
  .map((m) => note(`${m.senderLabel} · ${m.sentAtLabel}`, `${multiline(m.body)}${filesLine(m.fileNames)}`))
  .join('');

const smallLink = (label, url) =>
  `<div style="margin:-8px 0 24px;"><a href="${escapeHtml(url)}" target="_blank" style="font-family:${FONT_BODY};font-size:14px;font-weight:600;color:${COLORS.button};text-decoration:none;">${escapeHtml(label)} &rarr;</a></div>`;

const sectionHeading = (html) =>
  `<div style="margin:8px 0 6px;font-family:${FONT_BODY};font-size:16px;line-height:1.4;color:${COLORS.heading};">${html}</div>`;

const LAST_REMINDER = "This is the last reminder. If there's still no reply by the next school day, the school office will be told so someone can follow up with the family.";
const STOP_NOTE = "A short reply stops these reminders, even just to say you've seen it. If it was handled another way, mark the conversation resolved.";

const letter = ({ schoolName, schoolInfo, heading, preheader, content }) => renderEmail({
  brand: schoolBrand(schoolInfo, schoolName),
  heading,
  preheader,
  content: [...content, signOff(schoolName)].join(''),
  footer: schoolContact(schoolInfo, schoolName),
});

/** To a teacher: reminder 1 or 2 (step) for each conversation waiting on them. */
function teacherReminderEmail({ firstName, threads, link, schoolName, schoolInfo }) {
  const last = threads.some((t) => t.step >= 2);
  if (threads.length === 1) {
    const [t] = threads;
    const subject = last
      ? `Last reminder: a parent is waiting for your reply (${t.studentName})`
      : `A parent is waiting to hear from you: ${t.studentName} (${t.classSubject})`;
    return {
      subject,
      html: letter({
        schoolName, schoolInfo, preheader: subject,
        heading: last ? 'Last reminder: a parent is still waiting' : 'A parent is waiting for your reply',
        content: [
          hi(firstName),
          paragraph(`${escapeHtml(t.fromLabel)} wrote to you about ${topicHtml(t)} on ${escapeHtml(t.wroteLabel)}. ${last ? 'There is still no reply.' : "There's no reply yet."} Here is the message:`),
          messageBlocks(t.messages),
          last ? paragraph(LAST_REMINDER) : '',
          button('Reply in SchoolMule', t.link),
          finePrint(STOP_NOTE),
        ],
      }),
    };
  }
  const subject = `${threads.length} parent messages are waiting for your reply`;
  return {
    subject,
    html: letter({
      schoolName, schoolInfo, preheader: subject, heading: subject,
      content: [
        hi(firstName),
        paragraph("These parents wrote to you and haven't had a reply yet."),
        ...threads.map((t) => [
          sectionHeading(`${topicHtml(t)}${t.step >= 2 ? ` · <span style="color:${COLORS.muted};">last reminder</span>` : ''}`),
          paragraph(`${escapeHtml(t.fromLabel)} wrote on ${escapeHtml(t.wroteLabel)}:`, { muted: true, size: 14 }),
          messageBlocks(t.messages),
          smallLink('Reply', t.link),
        ].join('')),
        last ? paragraph(LAST_REMINDER) : '',
        button('Open messages', link),
        finePrint(STOP_NOTE),
      ],
    }),
  };
}

/** "Mr. Omar Haddad was reminded twice and hasn't replied." */
function remindedSentence(t) {
  if (t.unreachable) return "There's no teacher with an email address to remind about this message, so it comes straight to you.";
  const many = t.teacherCount > 1;
  if (!t.reminders) return `${escapeHtml(t.teacherNames)} ${many ? "haven't" : "hasn't"} replied.`;
  const times = t.reminders === 1 ? 'once' : t.reminders === 2 ? 'twice' : `${t.reminders} times`;
  return many
    ? `${escapeHtml(t.teacherNames)} were reminded ${times} and haven't replied.`
    : `${escapeHtml(t.teacherNames)} was reminded ${times} and hasn't replied.`;
}

const officeFacts = (t) => facts([
  ['Student', escapeHtml([t.studentName, t.studentGrade].filter(Boolean).join(', '))],
  ['About', escapeHtml([t.title, t.classSubject].filter(Boolean).join(' · '))],
  ['Parent', escapeHtml(t.fromLabel)],
  ['Wrote', escapeHtml(t.wroteLabel)],
  ['Teacher', t.teacherNames ? escapeHtml(t.teacherNames) : null],
  ['Reminded', t.remindedLabel ? escapeHtml(t.remindedLabel) : null],
]);

/** To everyone with All messages access: parent messages nobody answered. */
function officeEmail({ threads, link, schoolName, schoolInfo }) {
  const why = finePrint(`You're getting this because you can see all messages at ${escapeHtml(schoolName)}. You can reply yourself or follow up with the teacher.`);
  if (threads.length === 1) {
    const [t] = threads;
    const subject = `No reply yet: ${t.parentName || 'A parent'}'s message about ${t.studentName}`;
    return {
      subject,
      html: letter({
        schoolName, schoolInfo, preheader: subject, heading: 'A parent message has had no reply',
        content: [paragraph(remindedSentence(t)), officeFacts(t), messageBlocks(t.messages), button('Open the conversation', t.link), why],
      }),
    };
  }
  const subject = `${threads.length} parent messages have had no reply`;
  return {
    subject,
    html: letter({
      schoolName, schoolInfo, preheader: subject, heading: subject,
      content: [
        paragraph('These parent messages have had no reply from anyone at school.'),
        ...threads.map((t) => [
          sectionHeading(topicHtml(t)),
          paragraph(remindedSentence(t), { muted: true, size: 14 }),
          officeFacts(t),
          messageBlocks(t.messages),
          smallLink('Open the conversation', t.link),
        ].join('')),
        button('Open All Messages', link),
        why,
      ],
    }),
  };
}

const NUDGE_NOTE = "The button signs you in. This is a one-time reminder; you won't get another about this message.";

/** To a parent, once: a teacher's message nobody in the family has answered. */
function parentNudgeEmail({ firstName, threads, link, schoolName, schoolInfo }) {
  if (threads.length === 1) {
    const [t] = threads;
    const subject = `${t.fromLabel} sent you a message about ${t.studentName}`;
    return {
      subject,
      html: letter({
        schoolName, schoolInfo, preheader: subject, heading: `You have a message from ${t.fromLabel}`,
        content: [
          hi(firstName),
          paragraph(`${escapeHtml(t.fromLabel)} wrote to you about ${topicHtml(t)} on ${escapeHtml(t.wroteLabel)} and hasn't heard back yet. Here is the message:`),
          messageBlocks(t.messages),
          button('Reply in SchoolMule', link),
          finePrint(NUDGE_NOTE),
        ],
      }),
    };
  }
  const subject = `${threads.length} messages from school are waiting for your reply`;
  return {
    subject,
    html: letter({
      schoolName, schoolInfo, preheader: subject, heading: subject,
      content: [
        hi(firstName),
        paragraph("These messages from school haven't had a reply yet."),
        ...threads.map((t) => [
          sectionHeading(topicHtml(t)),
          paragraph(`${escapeHtml(t.fromLabel)} wrote on ${escapeHtml(t.wroteLabel)}:`, { muted: true, size: 14 }),
          messageBlocks(t.messages),
        ].join('')),
        button('Reply in SchoolMule', link),
        finePrint(NUDGE_NOTE),
      ],
    }),
  };
}

module.exports = { teacherReminderEmail, officeEmail, parentNudgeEmail };
