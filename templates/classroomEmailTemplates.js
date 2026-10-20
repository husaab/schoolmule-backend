// templates/classroomEmailTemplates.js
//
// The classroom emails (spec §7): new work, due-tomorrow reminders and
// grades to students; the missing-work alert and the weekly (or daily)
// summary to parents. Each returns { subject, html }; every body goes
// through renderEmail() on the school's letterhead. Purely transactional
// notices (CASL): no promotional content. Callers pass plain text (it is
// escaped here) and ready-made labels (dates are Toronto time).

const {
  schoolBrand, escapeHtml, multiline, paragraph, finePrint, button, note, facts, signOff, schoolContact, renderEmail, COLORS, FONT_BODY,
} = require('./emailLayout');
const { summarySubject, missingSubject, possessiveNames } = require('../services/classroom/classroomDigest');

const DISPLAY = "Outfit, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const ROSE = { bg: '#fff1f2', border: '#fecdd3', ink: '#be123c' };
const AMBER = { bg: '#fffbeb', border: '#fde68a', button: '#b45309' };

const KIND_WORDS = {
  assignment: { noun: 'assignment', posted: 'a new assignment' },
  quiz: { noun: 'quiz', posted: 'a new quiz' },
  material: { noun: 'material', posted: 'new material' },
  assessment: { noun: 'assessment', posted: 'a new assessment' },
};
const kindWords = (kind) => KIND_WORDS[kind] || KIND_WORDS.assignment;

const hi = (name) => paragraph(`Hi ${escapeHtml(name || 'there')},`);
const andMore = (first, count) => (count > 1 ? `${first} and ${count - 1} more` : first);

/** A small uppercase section label. */
const sectionLabel = (label, color = '#57534e') =>
  `<div style="margin:0 0 8px;font-family:${FONT_BODY};font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${color};">${escapeHtml(label)}</div>`;

/** "<strong>title</strong> · Subject · rest" (rest is plain text). */
const workLine = (title, subject, rest) =>
  [`<strong style="font-weight:600;color:${COLORS.heading};">${escapeHtml(title)}</strong>`, subject && escapeHtml(subject), rest && escapeHtml(rest)]
    .filter(Boolean).join(' · ');

/** A bordered box; `html` is trusted markup. */
const box = (html, { bg = '#ffffff', border = COLORS.border, margin = '0 0 10px' } = {}) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${margin};">
    <tr><td style="padding:12px 14px;background:${bg};border:1px solid ${border};border-radius:10px;font-family:${FONT_BODY};font-size:15px;line-height:1.5;color:${COLORS.text};">${html}</td></tr>
  </table>`;

/** A row with text on the left and a short value on the right. */
const splitRow = (left, right, { last = false } = {}) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
    <tr>
      <td style="padding:6px 0;${last ? '' : `border-bottom:1px solid ${COLORS.divider};`}font-family:${FONT_BODY};font-size:15px;line-height:1.5;color:${COLORS.text};">${left}</td>
      <td align="right" style="padding:6px 0 6px 12px;${last ? '' : `border-bottom:1px solid ${COLORS.divider};`}white-space:nowrap;font-family:${FONT_BODY};font-size:15px;line-height:1.5;color:#57534e;">${right}</td>
    </tr>
  </table>`;

/** A grade: title · subject with the score on the right, then quoted feedback and the teacher. */
function gradeBox(g) {
  const score = g.scoreLabel ? `<strong style="font-weight:600;color:${COLORS.heading};">${escapeHtml(g.scoreLabel)}</strong>` : '';
  const head = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="font-family:${FONT_BODY};font-size:15px;line-height:1.5;color:${COLORS.text};">${workLine(g.title, g.subject)}</td>
        <td align="right" style="padding-left:12px;white-space:nowrap;font-family:${FONT_BODY};font-size:15px;">${score}</td>
      </tr>
    </table>`;
  const feedback = g.feedback
    ? `<div style="margin-top:6px;font-size:14px;line-height:1.55;color:#44403c;font-style:italic;">&quot;${multiline(g.feedback)}&quot; ${escapeHtml(g.teacherName || '')}</div>`
    : '';
  return box(`${head}${feedback}`);
}

/**
 * A summary's new grades, one card per subject (in name order): the subject
 * and how many are new on top, then a compact row per grade (title, score,
 * and the teacher's quoted feedback under it).
 */
function gradesBySubject(grades) {
  const bySubject = new Map();
  for (const g of grades) {
    const subject = g.subject || 'Other';
    bySubject.set(subject, [...(bySubject.get(subject) || []), g]);
  }
  const cell = `font-family:${FONT_BODY};font-size:15px;line-height:1.45;`;
  return [...bySubject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subject, list]) => {
      const rows = list.map((g, i) => {
        const rule = i === list.length - 1 ? '' : `border-bottom:1px solid ${COLORS.divider};`;
        const feedback = g.feedback
          ? `<div style="margin-top:3px;font-size:14px;line-height:1.5;color:#44403c;font-style:italic;">&quot;${multiline(g.feedback)}&quot; ${escapeHtml(g.teacherName || '')}</div>`
          : '';
        return `
        <tr>
          <td style="padding:9px 0;${rule}${cell}color:${COLORS.text};vertical-align:top;">${escapeHtml(g.title)}${feedback}</td>
          <td align="right" style="padding:9px 0 9px 12px;${rule}${cell}white-space:nowrap;vertical-align:top;font-weight:600;color:${COLORS.heading};">${escapeHtml(g.scoreLabel || '')}</td>
        </tr>`;
      }).join('');
      const count = `${list.length} new grade${list.length === 1 ? '' : 's'}`;
      return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border:1px solid ${COLORS.border};border-radius:10px;border-collapse:separate;">
    <tr>
      <td style="padding:10px 14px;background:#f8fafc;border-bottom:1px solid ${COLORS.divider};border-radius:10px 10px 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:${FONT_BODY};font-size:15px;font-weight:600;color:${COLORS.heading};">${escapeHtml(subject)}</td>
            <td align="right" style="font-family:${FONT_BODY};font-size:13px;color:${COLORS.muted};white-space:nowrap;">${count}</td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
      </td>
    </tr>
  </table>`;
    })
    .join('');
}

/** A child's heading: avatar, then "Yusuf · Grade 5". */
function childHeading(child) {
  const avatar = child.avatarUrl
    ? `<td style="padding:0 10px 0 0;vertical-align:middle;"><img src="${escapeHtml(child.avatarUrl)}" width="32" height="32" alt="" style="display:block;border:0;border-radius:16px;"></td>`
    : '';
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;">
    <tr>
      ${avatar}
      <td style="vertical-align:middle;font-family:${DISPLAY};font-size:19px;font-weight:600;line-height:1.3;color:${COLORS.heading};">${escapeHtml(child.name)} · ${escapeHtml(child.gradeLabel)}</td>
    </tr>
  </table>`;
}

const link = (label, url) => `<a href="${escapeHtml(url)}" target="_blank" style="color:${COLORS.button};text-decoration:underline;">${escapeHtml(label)}</a>`;

const footerWith = (lines, schoolInfo, schoolName) =>
  [...lines, schoolContact(schoolInfo, schoolName)].filter(Boolean).join('<br><br>');

// ── Students ───────────────────────────────────────────────────────────────

/** "New assignment in Science: Plant cell diagram". */
function newWorkEmail({
  recipientFirstName, kind, title, subject, teacherName, teacherAvatarUrl = null, dueLabel = null, dateLabel = null,
  points = null, instructions = null, link: url, schoolName, schoolInfo,
}) {
  const words = kindWords(kind);
  const who = `<strong>${escapeHtml(teacherName)}</strong> posted ${words.posted} in <strong>${escapeHtml(subject)}</strong>.`;
  const intro = teacherAvatarUrl
    ? `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
    <tr>
      <td style="padding:0 12px 0 0;vertical-align:middle;"><img src="${escapeHtml(teacherAvatarUrl)}" width="40" height="40" alt="" style="display:block;border:0;outline:none;border-radius:20px;"></td>
      <td style="vertical-align:middle;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:${COLORS.text};">${who}</td>
    </tr>
  </table>`
    : paragraph(who);
  return {
    subject: `New ${words.noun} in ${subject}: ${title}`,
    html: renderEmail({
      brand: schoolBrand(schoolInfo, schoolName),
      heading: title,
      preheader: `${subject} · ${teacherName}`,
      content: [
        hi(recipientFirstName),
        intro,
        facts([
          ['Class', escapeHtml(subject)],
          ['Due', dueLabel ? escapeHtml(dueLabel) : null],
          ['Date', dateLabel ? escapeHtml(dateLabel) : null],
          ['Points', points !== null && points !== undefined ? escapeHtml(String(points)) : null],
        ]),
        instructions ? note('Instructions', multiline(instructions)) : '',
        button('Open in SchoolMule', url),
        finePrint('Questions? Ask your teacher in SchoolMule.'),
        signOff(schoolName),
      ].join(''),
      footer: schoolContact(schoolInfo, schoolName),
    }),
  };
}

/** "Due tomorrow: Plant cell diagram" (and "and 1 more"). */
function dueReminderEmail({ recipientFirstName, items, link: url, schoolName, schoolInfo }) {
  const lines = items.map((i) => box(workLine(i.title, i.subject, i.dueLabel ? `due ${i.dueLabel}` : null))).join('');
  return {
    subject: `Due tomorrow: ${andMore(items[0].title, items.length)}`,
    html: renderEmail({
      brand: schoolBrand(schoolInfo, schoolName),
      heading: 'Due tomorrow',
      preheader: andMore(items[0].title, items.length),
      content: [
        hi(recipientFirstName),
        paragraph(items.length === 1 ? "This is due tomorrow and isn't turned in yet:" : "These are due tomorrow and aren't turned in yet:"),
        lines,
        button('Open in SchoolMule', url),
        finePrint('Already finished? Turn it in on SchoolMule so your teacher can see it.'),
        signOff(schoolName),
      ].join(''),
      footer: schoolContact(schoolInfo, schoolName),
    }),
  };
}

/** "Graded: Plant cell diagram" (and "and 1 more"). */
function gradedEmail({ recipientFirstName, grades, link: url, schoolName, schoolInfo }) {
  return {
    subject: `Graded: ${andMore(grades[0].title, grades.length)}`,
    html: renderEmail({
      brand: schoolBrand(schoolInfo, schoolName),
      heading: grades.length === 1 ? grades[0].title : 'New grades',
      preheader: andMore(grades[0].title, grades.length),
      content: [
        hi(recipientFirstName),
        paragraph(grades.length === 1 ? 'Your teacher graded your work.' : 'Your teachers graded your work.'),
        grades.map(gradeBox).join(''),
        button('Open in SchoolMule', url),
        finePrint('Questions about a grade? Ask your teacher in SchoolMule.'),
        signOff(schoolName),
      ].join(''),
      footer: schoolContact(schoolInfo, schoolName),
    }),
  };
}

// ── Parents ────────────────────────────────────────────────────────────────

/** One email per family: "Missing work: Yusuf (1), Maryam (2)". */
function missingAlertEmail({ recipientFirstName, children, link: url, prefsLink = null, schoolName, schoolInfo }) {
  const blocks = children.filter((c) => c.items.length).map((c) => [
    childHeading(c),
    box([
      sectionLabel('Missing', ROSE.ink),
      ...c.items.map((i) => `<div style="margin:0 0 4px;">${workLine(i.title, i.subject, i.whenLabel)}</div>`),
    ].join(''), { bg: ROSE.bg, border: ROSE.border, margin: '0 0 18px' }),
  ].join('')).join('');
  return {
    subject: missingSubject(children.map((c) => ({ name: c.name, count: c.items.length }))),
    html: renderEmail({
      brand: schoolBrand(schoolInfo, schoolName),
      heading: 'Missing work',
      preheader: missingSubject(children.map((c) => ({ name: c.name, count: c.items.length }))),
      content: [
        hi(recipientFirstName),
        paragraph('This work became missing in the last day. Open SchoolMule to see the details or to message the teacher.'),
        blocks,
        button('Open SchoolMule', url),
        signOff(schoolName),
      ].join(''),
      footer: footerWith([
        prefsLink ? `You get an email when work goes missing. ${link('Change this in Email preferences', prefsLink)}.` : null,
      ], schoolInfo, schoolName),
    }),
  };
}

/** One child's part of the summary; empty sections are left out. */
function childSummary(child, { dueHeading }) {
  const parts = [childHeading(child)];
  if (child.missing.length) {
    parts.push(box([
      sectionLabel('Missing', ROSE.ink),
      ...child.missing.map((i) => `<div style="margin:0 0 4px;">${workLine(i.title, i.subject, i.whenLabel)}</div>`),
    ].join(''), { bg: ROSE.bg, border: ROSE.border, margin: '0 0 14px' }));
  }
  if (child.grades.length) {
    parts.push(sectionLabel('New grades & feedback'), gradesBySubject(child.grades), '<div style="height:4px;"></div>');
  }
  if (child.due.length) {
    parts.push(
      sectionLabel(dueHeading),
      child.due.map((i, n) => splitRow(workLine(i.title, i.subject), escapeHtml(i.dayLabel), { last: n === child.due.length - 1 })).join(''),
      '<div style="height:14px;"></div>',
    );
  }
  if (child.posts.length) {
    parts.push(sectionLabel('From the teachers'), child.posts.map((p) => {
      const ack = p.ackLink
        ? `<td align="right" style="padding-left:12px;vertical-align:middle;"><a href="${escapeHtml(p.ackLink)}" target="_blank" style="display:inline-block;padding:9px 13px;border-radius:8px;background:${AMBER.button};color:#ffffff;font-family:${FONT_BODY};font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap;">Got it ✓</a></td>`
        : '';
      const line = [p.authorName, p.note].filter(Boolean).map(escapeHtml).join(' · ');
      return box(`
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle;font-family:${FONT_BODY};">
              <div style="font-size:15px;font-weight:600;color:${COLORS.heading};">${escapeHtml(p.title)}</div>
              ${line ? `<div style="font-size:13px;color:${COLORS.muted};">${line}</div>` : ''}
            </td>
            ${ack}
          </tr>
        </table>`, p.ackLink ? { bg: AMBER.bg, border: AMBER.border } : {});
    }).join(''));
  }
  return parts.join('');
}

/**
 * The weekly (or daily) summary, one email for all of a parent's children
 * (the P3 board). `children` are the ones with something to show.
 */
function weeklySummaryEmail({
  recipientFirstName, frequency = 'weekly', dayName, rangeLabel, children, link: url,
  dailyLink = null, offLink = null, prefsLink = null, setupLink = null, schoolName, schoolInfo,
}) {
  const daily = frequency === 'daily';
  const period = daily ? 'day' : 'week';
  const counts = children.map((c) => ({ name: c.name, missing: c.missing.length, newGrades: c.grades.length, posts: c.posts.length }));
  const subject = summarySubject(counts, { period, label: rangeLabel });
  const heading = `${daily ? 'Daily Summary' : 'Weekly Summary'}: ${rangeLabel}`;
  const intro = `Here's what happened in ${possessiveNames(children.map((c) => c.name))} classes ${daily ? 'today' : 'this week'}.`;
  const sections = children
    .map((c) => childSummary(c, { dueHeading: daily ? 'Due soon' : 'Due next week' }))
    .join(`<div style="height:1px;background:${COLORS.divider};margin:10px 0 6px;"></div>`);

  const when = daily ? 'You get this summary every day.' : `You get this summary on ${dayName}.`;
  const links = offLink
    ? [daily ? (prefsLink ? link('Get it weekly', prefsLink) : null) : (dailyLink ? link('Get it daily', dailyLink) : null), link('Turn it off', offLink)]
      .filter(Boolean).join(' · ')
    : '';
  // A parent with no account (setupLink) gets it at the address on file: no
  // settings to change, and announcements may not reach that address.
  const prefsLine = setupLink
    ? escapeHtml(when)
    : `${escapeHtml(when)}${links ? ` ${links}.` : ''} Announcements always arrive right away.`;

  return {
    subject,
    html: renderEmail({
      brand: schoolBrand(schoolInfo, schoolName),
      heading,
      preheader: subject,
      content: [
        hi(recipientFirstName),
        paragraph(escapeHtml(intro)),
        sections,
        '<div style="height:12px;"></div>',
        setupLink
          ? paragraph('Set up your free parent account to see grades, work and messages any time.') + button('Set up your parent account', setupLink)
          : button('Open SchoolMule', url),
      ].join(''),
      footer: footerWith([prefsLine], schoolInfo, schoolName),
    }),
  };
}

module.exports = { newWorkEmail, dueReminderEmail, gradedEmail, missingAlertEmail, weeklySummaryEmail };
