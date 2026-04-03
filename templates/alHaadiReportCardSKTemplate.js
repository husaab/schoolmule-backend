/**
 * Al Haadi Academy - SK Report Card Template
 * Generates HTML for the Senior Kindergarten end-of-term report card
 * with subject-based curriculum standards and E/P/DV/EM/NI/N/A scale
 */

const { formatCommentHTML } = require('../utils/commentFormatter');

function getAcademicYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return month >= 8 ? `${year} \u2013 ${year + 1}` : `${year - 1} \u2013 ${year}`;
}

const getAlHaadiReportCardSKHTML = (data) => {
  const {
    schoolInfo, schoolAssets, student, term, subjects,
    ratingMapTerm1, ratingMapTerm2, commentMap, generatedDate
  } = data;
  const { name, grade, oen, homeroomTeacher, teacherAssistant, daysOfAbsence } = student;

  const academicYear = getAcademicYear();

  // Build subject sections
  const subjectSections = subjects.map(subject => {
    const standardRows = subject.standards.map(standard => `
      <tr>
        <td class="standard-name">${standard.name}</td>
        <td class="term-cell">${ratingMapTerm1[standard.standardId] || ''}</td>
        <td class="term-cell">${ratingMapTerm2[standard.standardId] || ''}</td>
      </tr>
    `).join('');

    const comment = commentMap[subject.subjectId];
    const commentHTML = comment ? formatCommentHTML(comment) : '';

    return `
      <div class="subject-section">
        <table class="subject-table">
          <thead>
            <tr>
              <th class="col-standard">${subject.name}</th>
              <th class="col-term">Term 1</th>
              <th class="col-term">Term 2</th>
            </tr>
          </thead>
          <tbody>
            ${standardRows}
          </tbody>
        </table>
        ${commentHTML ? `
        <div class="subject-comment">
          <div class="comment-label">Strengths / Next Steps for Improvement:</div>
          <div class="comment-text">${commentHTML}</div>
        </div>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SK Report Card - ${name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Georgia', 'Cambria', serif;
      font-size: 10pt;
      color: #333;
      background: #fff;
      line-height: 1.35;
      padding: 10px;
    }

    .container {
      max-width: 210mm;
      margin: 0 auto;
      position: relative;
    }

    .corner-logo {
      position: absolute;
      top: 0;
      right: 0;
      width: 100px;
      height: auto;
      object-fit: contain;
      z-index: 1000;
    }

    /* Header */
    .header {
      text-align: center;
      margin-bottom: 15px;
      color: #2c5aa0;
    }

    .header h1 {
      font-size: 22px;
      font-weight: bold;
    }

    /* Info Tables */
    .info-section {
      margin-bottom: 12px;
    }

    .info-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
      margin-bottom: 8px;
    }

    .info-table td, .info-table th {
      padding: 5px 8px;
      border: 1px solid #333;
      font-size: 9.5pt;
    }

    .info-table .info-header {
      background-color: #2c5aa0;
      color: white;
      text-align: center;
      font-weight: bold;
      font-size: 10pt;
    }

    .info-table .label-cell {
      font-weight: bold;
    }

    /* School Info Box */
    .school-box {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
      margin-bottom: 12px;
    }

    .school-box td {
      padding: 5px 8px;
      border: 1px solid #333;
      font-size: 9pt;
    }

    /* Legend */
    .legend-box {
      border: 1px solid #333;
      margin-bottom: 18px;
      overflow: hidden;
    }

    .legend-header {
      background-color: #2c5aa0;
      color: white;
      padding: 6px 10px;
      font-weight: bold;
      font-size: 10pt;
      border-bottom: 1px solid #333;
    }

    .legend-content {
      padding: 8px 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 20px;
    }

    .legend-item {
      font-size: 9pt;
      white-space: nowrap;
    }

    /* Subject Tables */
    .subject-section {
      margin-bottom: 18px;
      page-break-inside: avoid;
    }

    .subject-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
    }

    .subject-table th {
      background-color: #2c5aa0;
      color: white;
      padding: 6px 8px;
      font-size: 9.5pt;
      font-weight: bold;
      border: 1px solid #333;
      text-align: center;
    }

    .col-standard { width: 70%; text-align: left !important; }
    .col-term { width: 15%; }

    .subject-table td {
      padding: 5px 8px;
      border: 1px solid #ccc;
      font-size: 9.5pt;
      vertical-align: top;
    }

    .standard-name {
      font-size: 9pt;
    }

    .term-cell {
      text-align: center;
      font-weight: bold;
      font-size: 10pt;
    }

    /* Subject Comment */
    .subject-comment {
      padding: 8px 10px;
      font-size: 9pt;
      line-height: 1.4;
      border: 1px solid #ccc;
      border-top: none;
      background-color: #fafafa;
    }

    .comment-label {
      font-weight: bold;
      font-size: 9.5pt;
      margin-bottom: 4px;
      color: #2c5aa0;
    }

    .comment-text {
      font-style: normal;
    }

    /* Footer */
    .footer {
      margin-top: 25px;
      padding-top: 15px;
      page-break-inside: avoid;
    }

    .footer-signatures {
      display: flex;
      justify-content: space-around;
      align-items: flex-end;
      min-height: 60px;
    }

    .signature-block {
      text-align: center;
      min-width: 140px;
    }

    .signature-image {
      max-height: 45px;
      max-width: 110px;
      object-fit: contain;
      margin-bottom: 5px;
    }

    .stamp-image {
      max-height: 55px;
      max-width: 55px;
      object-fit: contain;
    }

    .signature-line {
      border-top: 1px solid #333;
      padding-top: 4px;
      font-size: 8.5pt;
      color: #666;
      margin-top: 6px;
    }

    .date-block {
      text-align: center;
      min-width: 140px;
    }

    .date-value {
      font-size: 10pt;
      font-weight: bold;
      margin-bottom: 5px;
    }

    .footer-info {
      text-align: center;
      font-size: 8pt;
      color: #999;
      margin-top: 10px;
    }

    @page { size: A4; margin: 15mm; }

    @media print {
      body { margin: 0; padding: 0; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      .corner-logo { position: absolute !important; top: 0 !important; right: 0 !important; width: 90px !important; }
      .subject-section { page-break-inside: avoid; }
      .footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${schoolAssets?.logoUrl ? `<img src="${schoolAssets.logoUrl}" alt="School Logo" class="corner-logo" />` : ''}

  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>Senior Kindergarten Report Card: &nbsp;${academicYear}</h1>
    </div>

    <!-- Student Info -->
    <div class="info-section">
      <table class="info-table">
        <tr>
          <td class="info-header" colspan="3">Senior Kindergarten First Term Report Card ${academicYear}</td>
        </tr>
        <tr>
          <td class="label-cell">Name of Student: ${name}</td>
          <td>OEN: ${oen || 'N/A'}</td>
          <td>Days Absent: ${daysOfAbsence}</td>
        </tr>
        <tr>
          <td class="label-cell">Grade: Senior Kindergarten</td>
          <td colspan="2">Teacher: ${homeroomTeacher}${teacherAssistant ? ' & ' + teacherAssistant : ''}</td>
        </tr>
        <tr>
          <td class="label-cell">Board: Private</td>
          <td colspan="2">School: ${schoolInfo.name || 'Al Haadi Academy'}</td>
        </tr>
      </table>

      <!-- School Details -->
      <table class="school-box">
        <tr>
          <td rowspan="2" style="width: 40%;">
            <strong>${schoolInfo.name || 'Al Haadi Academy'}</strong><br/>
            ${schoolInfo.address || ''}
          </td>
          <td>Website: www.alhaadiacademy.ca</td>
        </tr>
        <tr>
          <td>Principal: Sr. Majida &nbsp;&nbsp;&nbsp; Telephone: ${schoolInfo.phone || ''}</td>
        </tr>
      </table>
    </div>

    <!-- Legend -->
    <div class="legend-box">
      <div class="legend-header">Rating Scale</div>
      <div class="legend-content">
        <div class="legend-item"><strong>E</strong> - Exemplary</div>
        <div class="legend-item"><strong>P</strong> - Proficient</div>
        <div class="legend-item"><strong>DV</strong> - Developing</div>
        <div class="legend-item"><strong>EM</strong> - Emerging</div>
        <div class="legend-item"><strong>NI</strong> - Needs Improvement</div>
        <div class="legend-item"><strong>N/A</strong> - Not Assessed</div>
      </div>
    </div>

    <!-- Subject Sections -->
    ${subjectSections}

    <!-- Footer -->
    <div class="footer">
      <div class="footer-signatures">
        <div class="signature-block">
          ${schoolAssets?.principalSignatureUrl ? `<img src="${schoolAssets.principalSignatureUrl}" alt="Teacher Signature" class="signature-image" />` : ''}
          <div class="signature-line">Teacher's Signature:</div>
        </div>
        <div class="signature-block">
          ${schoolAssets?.principalSignatureUrl ? `<img src="${schoolAssets.principalSignatureUrl}" alt="Principal Signature" class="signature-image" />` : ''}
          <div class="signature-line">Principal's Signature:</div>
        </div>
        <div class="date-block">
          <div class="date-value">Date: ${generatedDate}</div>
        </div>
      </div>
      <div class="footer-info">
        ${subjects.length > 0 ? Math.ceil(subjects.length / 2) + 2 : 3} | Page
      </div>
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = { getAlHaadiReportCardSKHTML };
