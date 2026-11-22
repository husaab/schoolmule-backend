// templates/meetingEmails.js
//
// Parent–teacher meeting emails (services/meetings/emails.js), on the school
// letterhead. Each returns { subject, html }. Callers pass plain text (escaped
// here) and ready-made labels ('4:00 PM', 'Monday, November 30').
//
// An item: { time, title, sub } — "4:00 PM", "Ms. Layla Saleh · Homeroom",
// "Adam · Grade 5 room".

const {
  schoolBrand, escapeHtml, paragraph, finePrint, button, buttonRow, note, facts, signOff, schoolContact, renderEmail,
  COLORS, FONT_BODY,
} = require('./emailLayout');

const hi = (name) => paragraph(`Hi ${escapeHtml(name || 'there')},`);

const letter = ({ schoolName, schoolInfo, heading, preheader, content }) => renderEmail({
  brand: schoolBrand(schoolInfo, schoolName),
  heading,
  preheader,
  content: [...content, signOff(schoolName)].join(''),
  footer: schoolContact(schoolInfo, schoolName),
});

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const dayHeading = (label, first) =>
  `<div style="margin:${first ? 6 : 14}px 0 4px;font-family:${FONT_BODY};font-size:13px;font-weight:700;color:${COLORS.brand};">${escapeHtml(label)}</div>`;

/** A list of meetings, one row each, ruled. */
function itemList(items) {
  const rows = items.map((it) => `
    <tr>
      <td style="padding:9px 16px 9px 0;width:72px;vertical-align:top;border-top:1px solid ${COLORS.divider};font-family:${FONT_BODY};font-size:14px;line-height:1.45;font-weight:700;color:${it.muted ? COLORS.muted : COLORS.heading};white-space:nowrap;">${escapeHtml(it.time)}</td>
      <td style="padding:9px 0;vertical-align:top;border-top:1px solid ${COLORS.divider};font-family:${FONT_BODY};font-size:14px;line-height:1.45;color:${it.muted ? COLORS.muted : COLORS.heading};">
        ${escapeHtml(it.title)}${it.sub ? `<div style="font-size:13px;color:${COLORS.muted};">${escapeHtml(it.sub)}</div>` : ''}
      </td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;border-bottom:1px solid ${COLORS.divider};">${rows}</table>`;
}

const daysBlock = (days) => days.map((d, i) => `${dayHeading(d.label, i === 0)}${itemList(d.items)}`).join('')
  + '<div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>';

const linesHtml = (lines) => lines.map(escapeHtml).join('<br>');

// ── Invitation ─────────────────────────────────────────────

/**
 * @param {object} p
 * @param {string} p.firstName
 * @param {Array<{ name, detail }>} p.children   "Adam", "Grade 5 room · 6 teachers"
 * @param {string[]} p.dayLines                    "Monday, Nov 30, 3:30–7:30 PM"
 * @param {string} p.datesShort                   "Mon Nov 30 & Tue Dec 1"
 * @param {number} p.slotMinutes
 * @param {string} p.changesLabel                 "Until 8 PM the evening before"
 * @param {boolean} p.createAccount               no account yet: create one first
 */
function inviteEmail({ firstName, children, dayLines, datesShort, slotMinutes, changesLabel, link, planLink, createAccount, schoolName, schoolInfo }) {
  const subject = `Book your parent–teacher meetings · ${datesShort}`;
  const whose = children.length === 1 ? `${children[0].name}'s teachers` : "your children's teachers";
  const intro = paragraph(`Booking is now open for meetings with ${escapeHtml(whose)}. Each meeting is ${slotMinutes} minutes, in person. Times are first come, first served.`);
  const rows = facts([
    ...children.map((c) => [c.name, escapeHtml(c.detail)]),
    ['Days', linesHtml(dayLines)],
    ['Changes', escapeHtml(changesLabel)],
  ]);
  const content = createAccount
    ? [
      hi(firstName), intro, rows,
      note('First, create your account', "Booking is in the Parent Portal. Your name and email are already filled in, so you only choose a password. Then you go straight to the meeting times."),
      button('Create your account to book', link),
      finePrint('This link works for 7 days. If it runs out, the next email from the school about these meetings has a fresh one.'),
      finePrint("With your account you'll also see grades, attendance and messages from teachers, on the web or in the SchoolMule app."),
    ]
    : [
      hi(firstName), intro, rows,
      buttonRow([{ label: 'Book my meetings', url: link }, { label: 'Plan my visit for me', url: planLink }]),
      finePrint('"Plan my visit" books your meetings back to back around the time you arrive. These buttons sign you in to the Parent Portal, so please don\'t forward this email.'),
    ];
  return { subject, html: letter({ schoolName, schoolInfo, heading: 'Book your parent–teacher meetings', preheader: subject, content }) };
}

// ── Booked, changed, cancelled ─────────────────────────────

/**
 * @param {object} p
 * @param {'booked'|'office'|'cancelled'} p.mode
 * @param {string[]} p.changeLines     office changes: "Mr. Farouk's meeting moved to 4:30 PM"
 * @param {Array<{ label, items }>} p.days   the family's meetings now
 * @param {string[]} p.toBook          "Ms. Qureshi (Sara). All her times are taken right now."
 * @param {boolean} p.hasIcs
 */
function familyUpdateEmail({ firstName, mode, count, changeLines, days, toBook, slotMinutes, link, cutoffLabel, hasIcs, createAccount, schoolName, schoolInfo }) {
  let subject;
  let heading;
  const content = [];
  if (mode === 'cancelled') {
    subject = 'Your parent–teacher meetings were cancelled';
    heading = 'Your meetings were cancelled';
    content.push(hi(firstName), paragraph(changeLines.length === 1 ? 'This meeting was cancelled:' : 'These meetings were cancelled:'),
      paragraph(linesHtml(changeLines)));
    if (!count) content.push(paragraph('You have no parent–teacher meetings booked now.'));
  } else if (mode === 'office') {
    subject = 'The school changed your parent–teacher meetings';
    heading = 'Your meetings changed';
    content.push(hi(firstName), note('What changed', linesHtml(changeLines)));
    if (count) content.push(paragraph('Here is your full list now.'));
  } else {
    subject = `Booked: ${plural(count, 'parent–teacher meeting')}`;
    heading = 'Your meetings are booked';
    content.push(hi(firstName), paragraph(`Here is your full list. Each meeting is ${slotMinutes} minutes.`));
    if (changeLines.length) content.push(note('Cancelled', linesHtml(changeLines)));
  }
  if (count) content.push(daysBlock(days));
  if (createAccount) {
    content.push(button('Create your account to see them', link));
  } else {
    content.push(button(count ? 'Change or cancel' : 'Book again', link));
  }
  if (count && hasIcs) content.push(finePrint('meetings.ics is attached: open it to add these meetings to your calendar.'));
  if (count) content.push(note("Can't make it?", `Please cancel ${escapeHtml(cutoffLabel)}, so another family can have the time.`));
  if (toBook.length) content.push(finePrint(`Still to book: ${linesHtml(toBook)}`));
  return { subject, html: letter({ schoolName, schoolInfo, heading, preheader: subject, content }) };
}

// ── The evening before ─────────────────────────────────────

function reminderEmail({ firstName, dayLabel, firstTime, items, where, laterLines, link, cutoffLabel, schoolName, schoolInfo }) {
  const subject = `Tomorrow: your meetings start at ${firstTime}`;
  const content = [
    hi(firstName),
    paragraph(`Here ${items.length === 1 ? 'is your meeting' : 'are your meetings'} for ${escapeHtml(dayLabel)}.`),
    itemList(items),
    '<div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>',
    facts([['Where', where ? escapeHtml(where) : null], ['Later', laterLines.length ? linesHtml(laterLines) : null]]),
    button('See my visit', link),
    cutoffLabel ? finePrint(`Can't make it? Cancel ${escapeHtml(cutoffLabel)} so another family can have the time.`) : '',
  ];
  return { subject, html: letter({ schoolName, schoolInfo, heading: 'See you tomorrow', preheader: subject, content }) };
}

// ── Not booked yet ─────────────────────────────────────────

/** rows: [{ teacher, open }] — open is "Mon 2 · Tue 9" or null (full). */
function lastCallEmail({ firstName, whose, rows, link, planLink, closingLine, fullTeachers, createAccount, schoolName, schoolInfo }) {
  const subject = 'Times are still open for parent–teacher meetings';
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-bottom:1px solid ${COLORS.divider};">${rows.map((r) => `
    <tr>
      <td style="padding:7px 16px 7px 0;border-top:1px solid ${COLORS.divider};font-family:${FONT_BODY};font-size:14px;line-height:1.5;color:${COLORS.heading};">${escapeHtml(r.teacher)}</td>
      <td style="padding:7px 0;border-top:1px solid ${COLORS.divider};font-family:${FONT_BODY};font-size:14px;line-height:1.5;text-align:right;white-space:nowrap;color:${r.open ? COLORS.muted : '#be123c'};">${escapeHtml(r.open || 'Full')}</td>
    </tr>`).join('')}</table>`;
  const content = [
    hi(firstName),
    paragraph(`You haven't booked a meeting yet. These are the times still open with ${escapeHtml(whose)}:`),
    table,
    createAccount
      ? button('Create your account to book', link)
      : buttonRow([{ label: 'Book my meetings', url: link }, { label: 'Plan my visit for me', url: planLink }]),
    closingLine ? finePrint(escapeHtml(closingLine)) : '',
    fullTeachers.length
      ? finePrint(`${escapeHtml(fullTeachers.join(', '))} ${fullTeachers.length === 1 ? 'has' : 'have'} no times left. To talk another time, send a message from the Parent Portal.`)
      : '',
  ];
  return { subject, html: letter({ schoolName, schoolInfo, heading: "There's still time to book", preheader: subject, content }) };
}

// ── A teacher's list for the next day ──────────────────────

function teacherListEmail({ firstName, dayName, count, rangeText, items, openLine, printLink, pageLink, schoolName, schoolInfo }) {
  const subject = `Your ${plural(count, 'parent–teacher meeting')} tomorrow`;
  const content = [
    hi(firstName),
    paragraph(`Booking for ${escapeHtml(dayName)} is closed. You have ${plural(count, 'family', 'families')}${rangeText ? ` from ${escapeHtml(rangeText)}` : ''}.`),
    itemList(items),
    '<div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>',
    buttonRow([{ label: 'Print my day', url: printLink }, { label: 'Open My Meetings', url: pageLink }]),
    finePrint("Print my day is one PDF: this schedule, then each family's Student summary in meeting order."),
    openLine ? finePrint(escapeHtml(openLine)) : '',
  ];
  return { subject, html: letter({ schoolName, schoolInfo, heading: 'Your meetings tomorrow', preheader: subject, content }) };
}

module.exports = { inviteEmail, familyUpdateEmail, reminderEmail, lastCallEmail, teacherListEmail };
