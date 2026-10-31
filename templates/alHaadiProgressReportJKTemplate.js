/**
 * Al Haadi Academy — Junior Kindergarten Progress Report Card.
 *
 * A copy of the school's own Google Docs template ("Dalia Al-hussaini JK
 * PROGRESS REPORT CARD 2025-2026.pdf"): A4, Mulish, black-ruled tables.
 *   Page 1   the yellow banner, the pink student grid, the green "Learning
 *            Skills" key.
 *   Then     one table per skill section, each with its own colour and icon
 *            (unknown sections get a neutral colour and no icon).
 *   Last     "Teacher's Comments" (academic achievement, socio-emotional
 *            development), signatures, the date and the school stamp.
 *   Every page: the logo top right and the school's address footer.
 */

const { assetDataUri, mulishFontFaces, escapeHtml, formatLongDate, schoolYearWording, contactLine } = require('./printKit');

const LEGEND = [
  ['D - Developing:', 'Children can apply the skill or concept correctly.'],
  ['B - Beginning:', 'Children show some understanding. Reminders, hints, or support may be needed.'],
  ['I - Improvement needed:', 'Children are experiencing difficulty with the concept or skill. Assistance at home is needed.'],
  ['N - Not Assessed:', 'Not assessed at this time'],
];

// Section colours and icons from the paper template, by section name.
const SECTION_STYLES = {
  'language and communication skills': { color: '#c9daf8', icon: 'language.png' },
  'social skills': { color: '#d9ead3' },
  'emotional development': { color: '#e6b8af', icon: 'emotional.png' },
  'reading and writing skills': { color: '#fce5cd', icon: 'reading-writing.png' },
  'colours and shapes': { color: '#ead1dc', icon: 'colours-shapes.png' },
  'colors and shapes': { color: '#ead1dc', icon: 'colours-shapes.png' },
  numbers: { color: '#cfe2f3', icon: 'numbers.png' },
  'fine motor skills': { color: '#d9d2e9', icon: 'fine-motor.png' },
  'gross motor skills': { color: '#d0e0e3', icon: 'gross-motor.png' },
  'cognitive development': { color: '#fce5cd', icon: 'cognitive.png' },
  arabic: { color: '#e6b8af', icon: 'arabic.png', wideIcon: true },
  'islamic studies': { color: '#d9ead3', icon: 'islamic-studies.png' },
};
const FALLBACK_COLORS = ['#c9daf8', '#d9ead3', '#fce5cd', '#ead1dc', '#cfe2f3', '#d9d2e9'];

const PINK = '#f4cccc';
const GREEN = '#b6d7a8';
const NAVY = '#17407a';
const LINK_BLUE = '#1155cc';

function sectionStyle(name, index) {
  const key = String(name || '').trim().toLowerCase().replace(/:$/, '');
  return SECTION_STYLES[key] || { color: FALLBACK_COLORS[index % FALLBACK_COLORS.length] };
}

function sectionHtml(domain, index, ratingMap) {
  const style = sectionStyle(domain.name, index);
  const icon = style.icon
    ? `<img class="icon${style.wideIcon ? ' wide' : ''}" src="${assetDataUri(`alhaadi-kindergarten/${style.icon}`)}" alt="" />`
    : '';
  const rows = domain.skills
    .map(
      (skill) => `<tr>
        <td class="skill">${escapeHtml(skill.name)}</td>
        <td class="rating">${escapeHtml(ratingMap[skill.skillId] || '')}</td>
      </tr>`
    )
    .join('');
  return `<table class="grid section">
    <colgroup><col style="width: 79%" /><col style="width: 21%" /></colgroup>
    <tr class="section-head" style="background: ${style.color};">
      <td><span class="name">${escapeHtml(domain.name)}</span>${icon}</td><td></td>
    </tr>
    ${rows}
  </table>`;
}

function commentBlock(title, text) {
  const body = String(text || '').trim();
  return `<div class="comment-title">${escapeHtml(title)}</div>
    <div class="comment-text">${escapeHtml(body)}</div>`;
}

function headerTemplate(logoDataUri) {
  if (!logoDataUri) return '';
  return `<div style="width: 100%; box-sizing: border-box; padding: 9pt 25pt 0; text-align: right;">
    <img src="${logoDataUri}" style="height: 34pt; max-width: 110pt; object-fit: contain;" />
  </div>`;
}

function footerTemplate(schoolInfo, yearFull) {
  return `<style>${mulishFontFaces([700])}</style>
  <div style="width: 100%; box-sizing: border-box; padding: 0 51pt 0 37pt; display: flex; justify-content: space-between; align-items: flex-start;
              font-family: 'Mulish', sans-serif; font-size: 8pt; font-weight: 700; line-height: 1.7; color: ${NAVY}; -webkit-print-color-adjust: exact;">
    <div>
      <div>${escapeHtml(schoolInfo.name || '')}</div>
      <div>${contactLine(schoolInfo, `color: ${LINK_BLUE}; text-decoration: underline;`)}</div>
      ${yearFull ? `<div>${escapeHtml(yearFull)} All Rights Reserved</div>` : ''}
    </div>
    <div><span class="pageNumber"></span></div>
  </div>`;
}

/**
 * @param {object} data
 * @param {object} data.schoolInfo         { name, address, phone, email }
 * @param {string|null} data.logoDataUri   the school logo, inlined (page header)
 * @param {string|null} data.principalSignatureDataUri  inlined too
 * @param {string|null} data.schoolStampDataUri         inlined too
 * @param {object} data.student            { name, oen, teacherName, teacherAssistant, daysAbsent }
 * @param {Array}  data.domains            [{ domainId, name, skills: [{ skillId, name }] }]
 * @param {object} data.ratingMap          skillId → rating
 * @param {object} data.comments           { academic_achievement, socio_emotional }
 * @param {string} data.reportDate         YYYY-MM-DD
 * @param {string|null} data.schoolYearLabel  e.g. "2025-2026"
 * @returns {{ html: string, pdfOptions: object }}
 */
function renderAlHaadiProgressReportJK(data) {
  const {
    schoolInfo, logoDataUri, principalSignatureDataUri, schoolStampDataUri,
    student, domains, ratingMap = {}, comments = {}, reportDate, schoolYearLabel,
  } = data;
  const year = schoolYearWording(schoolYearLabel);
  const dateLabel = formatLongDate(reportDate).toUpperCase();
  const ta = String(student.teacherAssistant || '').trim();

  const legendRows = LEGEND.map(([term, text]) => `<div><strong>${term}</strong> ${text}</div>`).join('');
  const sections = domains.map((d, i) => sectionHtml(d, i, ratingMap)).join('');

  const principalSignature = principalSignatureDataUri ? `<img src="${principalSignatureDataUri}" alt="" />` : '';
  const stamp = schoolStampDataUri ? `<div class="stamp"><img src="${schoolStampDataUri}" alt="" /></div>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>JK Progress Report - ${escapeHtml(student.name)}</title>
<style>
  ${mulishFontFaces([400, 600, 700, 800])}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #fff; }
  body { font-family: 'Mulish', sans-serif; color: #000; font-size: 10.5pt; line-height: 1.3;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  table.grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.grid td { border: 1px solid #000; }

  .banner { border: 1px solid #000; }
  .banner img { display: block; width: 100%; height: auto; }

  table.info { margin-top: 18pt; background: ${PINK}; }
  table.info td { text-align: center; vertical-align: top; font-weight: 600; font-size: 10pt; line-height: 1.45; padding: 6pt 4pt; }
  table.info tr.first td { height: 40pt; }
  table.info tr.second td { height: 54pt; }

  table.legend { margin-top: 24pt; background: ${GREEN}; }
  table.legend td { vertical-align: top; padding: 3pt 4pt; }
  table.legend td.label { font-weight: 600; font-size: 10pt; line-height: 1.35; }
  table.legend td.terms { font-size: 9.5pt; line-height: 1.4; }
  table.legend td.terms strong { font-size: 10.5pt; font-weight: 700; }

  table.section { margin-top: 28pt; break-inside: avoid; page-break-inside: avoid; }
  table.section tr { break-inside: avoid; page-break-inside: avoid; }
  table.section tr.section-head td { height: 32pt; vertical-align: middle; padding: 0 5pt; }
  table.section tr.section-head .name { font-weight: 700; font-size: 11pt; vertical-align: middle; }
  table.section tr.section-head .icon { height: 22pt; width: auto; vertical-align: middle; margin-left: 16pt; }
  table.section tr.section-head .icon.wide { height: 18pt; }
  table.section td.skill { height: 25pt; vertical-align: middle; padding: 0 5pt; font-size: 10.5pt; }
  table.section td.rating { text-align: center; vertical-align: middle; font-weight: 600; font-size: 10.5pt; }

  .comments-page { break-before: page; page-break-before: always; }
  .comments { border: 1px solid #000; min-height: 430pt; padding: 8pt 5pt 14pt; }
  .comments h2 { font-size: 10pt; font-weight: 700; margin-bottom: 12pt; }
  .comment-title { font-size: 10pt; text-decoration: underline; margin-bottom: 12pt; }
  .comment-text { font-size: 12pt; line-height: 1.45; white-space: pre-wrap; margin-bottom: 14pt; }

  .signoff { break-inside: avoid; page-break-inside: avoid; margin-top: 22pt; }
  .signoff .row { display: flex; align-items: center; min-height: 40pt; }
  .signoff .cell { width: 50%; display: flex; align-items: center; gap: 12pt; font-weight: 700; font-size: 10.5pt; }
  .signoff .sig { width: 90pt; height: 34pt; display: flex; align-items: center; justify-content: center; }
  .signoff .sig img { max-width: 90pt; max-height: 34pt; object-fit: contain; }
  .stamp { text-align: center; margin-top: 8pt; }
  .stamp img { width: 96pt; height: 96pt; object-fit: contain; }
</style>
</head>
<body>
  <div class="banner"><img src="${assetDataUri('alhaadi-kindergarten/jk-banner.jpg')}" alt="Junior Kindergarten Progress Report Card" /></div>

  <table class="grid info">
    <colgroup><col style="width: 43.4%" /><col style="width: 21.3%" /><col style="width: 35.3%" /></colgroup>
    <tr class="first">
      <td>Name of Student:<br />${escapeHtml(student.name)}</td>
      <td colspan="2">Teacher: ${escapeHtml(student.teacherName || '')}${ta ? `<br />Teacher Assistant: ${escapeHtml(ta)}` : ''}</td>
    </tr>
    <tr class="second">
      <td>Days of absence<br />${escapeHtml(student.daysAbsent ?? 0)}</td>
      <td>School<br />${escapeHtml(schoolInfo.name || '')}</td>
      <td>OEN:<br />${escapeHtml(student.oen || '')}</td>
    </tr>
  </table>

  <table class="grid legend">
    <colgroup><col style="width: 11%" /><col style="width: 89%" /></colgroup>
    <tr><td class="label">Learning Skills</td><td class="terms">${legendRows}</td></tr>
  </table>

  ${sections}

  <div class="comments-page">
    <div class="comments">
      <h2>Teacher's Comments:</h2>
      ${commentBlock('Academic achievement:', comments.academic_achievement)}
      ${commentBlock('Socio-emotional development:', comments.socio_emotional)}
    </div>

    <div class="signoff">
      <div class="row">
        <div class="cell">Teacher's Signature: <span class="sig"></span></div>
        <div class="cell">${ta ? `Teacher Assistant's Signature: <span class="sig"></span>` : ''}</div>
      </div>
      <div class="row">
        <div class="cell">Principal's Signature: <span class="sig">${principalSignature}</span></div>
        <div class="cell">Date: ${escapeHtml(dateLabel)}</div>
      </div>
      ${stamp}
    </div>
  </div>
</body>
</html>`;

  return {
    html,
    pdfOptions: {
      format: 'A4',
      // Puppeteer takes px/in/cm/mm, not pt: 62pt, 80pt, 36pt.
      margin: { top: '0.86in', bottom: '1.11in', left: '0.5in', right: '0.5in' },
      headerTemplate: headerTemplate(logoDataUri),
      footerTemplate: footerTemplate(schoolInfo, year.full),
    },
  };
}

module.exports = { renderAlHaadiProgressReportJK, sectionStyle };
