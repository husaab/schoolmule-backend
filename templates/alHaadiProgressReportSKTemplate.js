/**
 * Al Haadi Academy — Senior Kindergarten Progress Report.
 *
 * A copy of the school's own Excel template ("Ahmed-SK - Progress Report -
 * 2025 - 2026.pdf"): Letter, Mulish, solid black grid lines.
 *   Page 1   logo + "Progress Report: <year>", date box, student grid with
 *            the rotated EVALUATION KEY, then LEARNING SKILLS.
 *   Pages 2+ a running header (student name, report date).
 *   Last     "Subjects | Strengths/Next Steps for Improvement" comment table
 *            with the signature row.
 *   Every page: the school's address footer and "Page X of Y".
 *
 * Every LEARNING SKILLS row lives in ONE table with fixed columns, so the
 * rating column lines up from the first section to the last. Subjects named
 * "Group - Part" (e.g. "Literacy - Reading") print under one grey GROUP bar
 * with a blue PART bar each; "Arabic and Quran" and "French" print side by
 * side, as on paper.
 */

const { mulishFontFaces, escapeHtml, formatLongDate, schoolYearWording, contactLine } = require('./printKit');

/**
 * The "Strengths/Next Steps for Improvement" rows, as on the paper template.
 * Stored in sk_progress_report_comments with `key` as section_type. Keep in
 * step with the web/app copy (src/lib/skProgressComments.ts).
 */
const SK_PROGRESS_COMMENT_ROWS = [
  { key: 'language_arts', label: 'Language Arts', caption: 'Reading, Writing, Oral communication, Media Literacy' },
  { key: 'mathematics', label: 'Mathematics' },
  { key: 'science', label: 'Science' },
  { key: 'social_studies', label: 'Social Studies' },
  { key: 'quran', label: 'Quran' },
  { key: 'arabic', label: 'Arabic' },
  { key: 'islamic_studies', label: 'Islamic Studies' },
  { key: 'creativity', label: 'Creativity' },
  { key: 'french', label: 'French' },
];

const EVALUATION_KEY = [
  ['E', 'Excellent'],
  ['G', 'Good'],
  ['S', 'Satisfactory'],
  ['NI', 'Needs Improvement'],
  ['NA', 'Not Applicable'],
];

// Printed next to each other, in this order, when both exist side by side in
// the subject list.
const SIDE_BY_SIDE = ['arabic and quran', 'french'];

const BLUE = '#9bc2e6';
const LIGHT_BLUE = '#bdd7ee';
const GREY = '#d0cece';
const FOOTER_BLUE = '#4472c4';

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * The LEARNING SKILLS sections in print order:
 *   { kind: 'single', group?: string, title?: string, sub?: string, subject }
 *   { kind: 'pair', left: subject, right: subject }
 * `group` is set on the first subject of a "Group - Part" run (the grey bar),
 * `sub` on every subject of the run (the blue bar), `title` otherwise.
 */
function layoutSubjects(subjects) {
  const sections = [];
  let lastGroup = null;
  for (let i = 0; i < subjects.length; i++) {
    const subject = subjects[i];
    const next = subjects[i + 1];
    if (next && norm(subject.name) === SIDE_BY_SIDE[0] && norm(next.name) === SIDE_BY_SIDE[1]) {
      sections.push({ kind: 'pair', left: subject, right: next });
      lastGroup = null;
      i++;
      continue;
    }
    const m = /^(.+?)\s+-\s+(.+)$/.exec(subject.name || '');
    if (m) {
      const group = m[1].trim();
      sections.push({ kind: 'single', group: norm(group) === lastGroup ? null : group, sub: m[2].trim(), subject });
      lastGroup = norm(group);
    } else {
      sections.push({ kind: 'single', title: subject.name, subject });
      lastGroup = null;
    }
  }
  return sections;
}

function ratingFor(ratingMap, standard) {
  return escapeHtml(ratingMap[standard.standardId] || '');
}

function sectionHtml(section, ratingMap, isFirst) {
  const banner = isFirst ? `<tr class="skills-banner"><td colspan="4">LEARNING SKILLS</td></tr>` : '';

  if (section.kind === 'pair') {
    const { left, right } = section;
    const rows = Math.max(left.standards.length, right.standards.length);
    let body = '';
    for (let r = 0; r < rows; r++) {
      const a = left.standards[r];
      const b = right.standards[r];
      body += `<tr class="item">
        <td class="text">${a ? escapeHtml(a.name) : ''}</td><td class="rating narrow">${a ? ratingFor(ratingMap, a) : ''}</td>
        <td class="text">${b ? escapeHtml(b.name) : ''}</td><td class="rating">${b ? ratingFor(ratingMap, b) : ''}</td>
      </tr>`;
    }
    return `<tbody class="section pair">${banner}
      <tr class="section-title pair-title"><td colspan="2">${escapeHtml(left.name)}</td><td colspan="2">${escapeHtml(right.name)}</td></tr>
      ${body}
    </tbody>`;
  }

  const { subject } = section;
  const heading =
    (section.group ? `<tr class="section-title"><td colspan="4">${escapeHtml(section.group)}</td></tr>` : '') +
    (section.sub ? `<tr class="sub-title"><td colspan="4">${escapeHtml(section.sub)}</td></tr>` : '') +
    (section.title ? `<tr class="section-title"><td colspan="4">${escapeHtml(section.title)}</td></tr>` : '');
  const rows = subject.standards
    .map(
      (standard) => `<tr class="item">
        <td class="text" colspan="3">${escapeHtml(standard.name)}</td>
        <td class="rating">${ratingFor(ratingMap, standard)}</td>
      </tr>`
    )
    .join('');
  return `<tbody class="section">${banner}${heading}${rows}</tbody>`;
}

function commentRowsHtml(comments) {
  return SK_PROGRESS_COMMENT_ROWS.map(
    (row) => `<tr>
      <td class="subject">${escapeHtml(row.label)}${row.caption ? `<div class="caption">${escapeHtml(row.caption)}</div>` : ''}</td>
      <td class="comment" colspan="3">${escapeHtml((comments[row.key] || '').trim())}</td>
    </tr>`
  ).join('');
}

function footerTemplate(schoolInfo, yearShort) {
  return `<style>${mulishFontFaces([400, 700])}</style>
  <div style="width: 100%; box-sizing: border-box; padding: 21pt 34pt 0; display: flex; justify-content: space-between; align-items: flex-end; font-family: 'Mulish', sans-serif; -webkit-print-color-adjust: exact;">
    <div style="font-size: 6pt; line-height: 1.55; color: ${FOOTER_BLUE};">
      <div style="font-weight: 700;">${escapeHtml(schoolInfo.name || '')}</div>
      <div>${contactLine(schoolInfo, 'text-decoration: underline;')}</div>
      ${yearShort ? `<div>&copy; ${escapeHtml(yearShort)}, All Rights Reserved</div>` : ''}
    </div>
    <div style="font-size: 10pt; font-weight: 700; color: #000;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
  </div>`;
}

function runningHeaderTemplate(studentName, dateLabel) {
  return `<style>${mulishFontFaces([700])}</style>
  <div style="width: 100%; box-sizing: border-box; padding: 9pt 34pt 0; display: flex; justify-content: space-between; font-family: 'Mulish', sans-serif; font-size: 9.5pt; font-weight: 700; color: #000;">
    <span>${escapeHtml(studentName)}</span><span>${escapeHtml(dateLabel)}</span>
  </div>`;
}

/**
 * @param {object} data
 * @param {object} data.schoolInfo        { name, address, phone, email }
 * @param {string|null} data.logoDataUri  the school logo, inlined
 * @param {string|null} data.principalSignatureDataUri  inlined too
 * @param {object} data.student           { name, oen, teacherName, daysAbsent }
 * @param {Array}  data.subjects          [{ subjectId, name, standards: [{ standardId, name }] }]
 * @param {object} data.ratingMap         standardId → rating
 * @param {object} data.comments          SK_PROGRESS_COMMENT_ROWS key → comment
 * @param {string} data.reportDate        YYYY-MM-DD
 * @param {string|null} data.schoolYearLabel  e.g. "2025-2026"
 * @returns {{ html: string, pdfOptions: object }}
 */
function renderAlHaadiProgressReportSK(data) {
  const { schoolInfo, logoDataUri, principalSignatureDataUri, student, subjects, ratingMap = {}, comments = {}, reportDate, schoolYearLabel } = data;
  const dateLabel = formatLongDate(reportDate);
  const year = schoolYearWording(schoolYearLabel);

  const keyRows = EVALUATION_KEY.map(
    ([code, label], i) => `<tr class="key">
      ${i === 0 ? `<td class="key-title" rowspan="${EVALUATION_KEY.length}"><div>EVALUATION KEY</div></td>` : ''}
      <td class="key-code">${code}</td><td class="key-label" colspan="3">${label}</td>
    </tr>`
  ).join('');

  const sections = layoutSubjects(subjects).map((s, i) => sectionHtml(s, ratingMap, i === 0)).join('');

  const principalSignature = principalSignatureDataUri ? `<img src="${principalSignatureDataUri}" alt="" />` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>SK Progress Report - ${escapeHtml(student.name)}</title>
<style>
  ${mulishFontFaces([400, 700, 800])}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; }
  body { font-family: 'Mulish', sans-serif; color: #000; font-size: 9pt; line-height: 1.3;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  table.grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.grid td { border: 1px solid #000; vertical-align: middle; }

  /* Masthead */
  .masthead { display: flex; align-items: center; justify-content: space-between; height: 46pt; }
  .masthead .logo { width: 140pt; height: 44pt; display: flex; align-items: center; margin-left: 7pt; }
  .masthead .logo img { max-width: 140pt; max-height: 44pt; object-fit: contain; }
  .masthead .title { flex: 1; text-align: center; padding-left: 40pt; font-size: 18pt; font-weight: 800; letter-spacing: -0.2pt; white-space: nowrap; }

  /* Student grid */
  table.info { border: 2px solid #000; margin-top: 4pt; }
  table.info tr.date-row td { border: none; }
  table.info tr.date-row td.date { border: 2px solid #000; border-bottom: none; font-weight: 700; font-size: 8.5pt; padding: 3pt 3pt 2pt; }
  table.info td.banner { background: ${BLUE}; border: 2px solid #000; text-align: center; font-size: 13pt; font-weight: 700; padding: 2pt 0; }
  table.info td.label, table.info td.value { font-weight: 700; font-size: 8.5pt; padding: 1.5pt 2pt; border-width: 2px 1px; }
  table.info td.label { border-right-width: 2px; }
  table.info td.center { text-align: center; }
  table.info td.key-title { background: ${BLUE}; border: 2px solid #000; position: relative; padding: 0; }
  table.info td.key-title div { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%) rotate(-90deg);
                                width: 60pt; text-align: center; font-size: 8pt; font-weight: 700; letter-spacing: 0.4pt; line-height: 1.25; }
  table.info tr.key td { height: 14pt; font-size: 10.5pt; }
  table.info td.key-code { text-align: center; border-right-width: 2px; }
  table.info td.key-label { font-weight: 700; padding: 0 2pt; }
  table.info tr.key:last-child td { border-bottom-width: 2px; }

  /* LEARNING SKILLS */
  table.skills { border: 2px solid #000; margin-top: 13pt; }
  table.skills tbody.section { break-inside: avoid; page-break-inside: avoid; }
  table.skills tr { break-inside: avoid; page-break-inside: avoid; }
  table.skills tr.skills-banner td { background: ${BLUE}; border: 2px solid #000; text-align: center; font-size: 13.5pt; font-weight: 700; height: 26pt; }
  table.skills tr.section-title td { background: ${GREY}; border-top: 2px solid #000; border-bottom: 2px solid #000;
                                     text-align: center; text-transform: uppercase; font-size: 10.5pt; font-weight: 700; height: 15pt; padding: 0 2pt; }
  table.skills tr.pair-title td { border-left: 2px solid #000; border-right: 2px solid #000; }
  table.skills tr.sub-title td { background: ${LIGHT_BLUE}; border-top: 2px solid #000; border-bottom: 2px solid #000;
                                 text-transform: uppercase; font-size: 10.5pt; font-weight: 700; height: 15pt; padding: 0 2pt; }
  table.skills tr.item td { height: 16.5pt; }
  table.skills td.text { vertical-align: top; padding: 2pt 1pt 3pt 2pt; }
  table.skills tbody.pair tr.item td { height: 23pt; vertical-align: middle; font-size: 9.5pt; }
  table.skills td.rating { text-align: center; font-weight: 700; border-left: 2px solid #000; }
  table.skills td.rating.narrow { border-right: 2px solid #000; }

  /* Strengths / Next Steps */
  table.comments { border: 2px solid #000; break-before: page; page-break-before: always; }
  table.comments tr { break-inside: avoid; page-break-inside: avoid; }
  table.comments th { background: ${GREY}; border: 2px solid #000; height: 48pt; font-size: 10.5pt; font-weight: 700; text-align: center; vertical-align: middle; }
  table.comments td { border-width: 2px; }
  table.comments td.subject { background: ${GREY}; font-size: 10.5pt; font-weight: 700; padding: 2pt; vertical-align: middle; }
  table.comments td.subject .caption { font-size: 6.5pt; font-weight: 400; line-height: 1.35; margin-top: 1pt; }
  table.comments td.comment { font-size: 10.5pt; line-height: 1.6; padding: 1pt 2pt 2pt; height: 40pt; white-space: pre-wrap; vertical-align: top; }
  table.comments tr.signatures td { height: 26pt; font-size: 8pt; font-weight: 700; padding: 0 2pt; vertical-align: bottom; }
  table.comments tr.signatures td.sig { text-align: center; vertical-align: middle; }
  table.comments tr.signatures td.sig img { max-height: 24pt; max-width: 100%; object-fit: contain; }
</style>
</head>
<body>
  <div class="masthead">
    <div class="logo">${logoDataUri ? `<img src="${logoDataUri}" alt="" />` : ''}</div>
    <div class="title">Progress Report:&nbsp;&nbsp;${escapeHtml(year.title)}</div>
  </div>

  <table class="grid info">
    <colgroup><col style="width: 9.6%" /><col style="width: 10.3%" /><col style="width: 28.3%" /><col style="width: 29.3%" /><col style="width: 22.5%" /></colgroup>
    <tr class="date-row"><td colspan="3"></td><td class="date" colspan="2">Date: ${escapeHtml(dateLabel)}</td></tr>
    <tr><td class="banner" colspan="5">Senior Kindergarten Progress Report</td></tr>
    <tr>
      <td class="label">Student:</td><td class="value" colspan="2">${escapeHtml(student.name)}</td>
      <td class="value" colspan="2">OEN:&nbsp; ${escapeHtml(student.oen || '')}</td>
    </tr>
    <tr>
      <td class="label">Teacher:</td><td class="value" colspan="2">${escapeHtml(student.teacherName || '')}</td>
      <td class="value">Days Absent:</td><td class="value center">${escapeHtml(student.daysAbsent ?? 0)}</td>
    </tr>
    ${keyRows}
  </table>

  <table class="grid skills">
    <colgroup><col style="width: 29.9%" /><col style="width: 8.2%" /><col style="width: 39.4%" /><col style="width: 22.5%" /></colgroup>
    ${sections}
  </table>

  <table class="grid comments">
    <colgroup><col style="width: 20%" /><col style="width: 18.1%" /><col style="width: 39.4%" /><col style="width: 22.5%" /></colgroup>
    <thead><tr><th>Subjects</th><th colspan="3">Strengths/Next Steps for Improvement</th></tr></thead>
    <tbody>
      ${commentRowsHtml(comments)}
      <tr class="signatures">
        <td>Teacher's Signature:</td><td class="sig"></td>
        <td>Principal's Signature:</td><td class="sig">${principalSignature}</td>
      </tr>
    </tbody>
  </table>
</body>
</html>`;

  return {
    html,
    pdfOptions: {
      format: 'Letter',
      // Puppeteer takes px/in/cm/mm, not pt: 54pt, 55pt, 58pt.
      margin: { top: '0.75in', bottom: '0.76in', left: '0.81in', right: '0.81in' },
      headerTemplate: runningHeaderTemplate(student.name, dateLabel),
      footerTemplate: footerTemplate(schoolInfo, year.short),
      // Page 1 has the masthead instead of the running header.
      firstPage: { headerTemplate: '' },
    },
  };
}

module.exports = { renderAlHaadiProgressReportSK, layoutSubjects, SK_PROGRESS_COMMENT_ROWS };
