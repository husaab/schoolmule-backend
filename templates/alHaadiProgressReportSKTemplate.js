/**
 * Al Haadi Academy - SK Progress Report Template
 * Generates HTML for the Senior Kindergarten mid-year progress report
 * with subject-based layout and E/G/S/NI/NA scale
 */

const getAlHaadiProgressReportSKHTML = (data) => {
  const { schoolInfo, schoolAssets, student, subjects, ratingMap, commentMap, generatedDate } = data;
  const { name, grade, oen, homeroomTeacher, teacherAssistant, daysOfAbsence } = student;

  const subjectSections = subjects.map(subject => {
    const standardRows = subject.standards.map(standard => {
      const rating = ratingMap[standard.standardId] || '';
      return `
        <tr>
          <td class="standard-name">${standard.name}</td>
          <td class="rating-cell">${rating}</td>
        </tr>
      `;
    }).join('');

    const comment = commentMap[subject.subjectId] || '';

    return `
      <div class="subject-section">
        <table class="subject-table">
          <thead>
            <tr>
              <th class="subject-header" colspan="2">${subject.name}</th>
            </tr>
          </thead>
          <tbody>
            ${standardRows}
          </tbody>
        </table>
        ${comment ? `
        <div class="subject-comment">
          <div class="comment-label">Strengths / Next Steps:</div>
          <div class="comment-text">${comment}</div>
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
  <title>SK Progress Report - ${name}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Georgia', 'Cambria', serif;
      font-size: 11pt;
      color: #333;
      background: #fff;
      line-height: 1.4;
      padding: 15px;
    }

    .corner-logo {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 100px;
      height: auto;
      object-fit: contain;
      z-index: 1000;
    }

    .container {
      max-width: 210mm;
      margin: 0 auto;
      position: relative;
    }

    /* Title Banner */
    .title-banner {
      border: 2px solid #2c5aa0;
      padding: 20px;
      text-align: center;
      margin-bottom: 20px;
      background-color: #eaf0f9;
    }

    .title-banner h1 {
      font-size: 24px;
      font-weight: bold;
      color: #2c5aa0;
    }

    /* Student Info Table */
    .info-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
      border: 1px solid #333;
    }

    .info-table td {
      padding: 8px 12px;
      border: 1px solid #333;
      font-size: 11pt;
    }

    .info-table .info-label {
      font-weight: bold;
      color: #333;
    }

    .info-table .info-value {
      color: #333;
    }

    .info-table .blue-row td {
      background-color: #d6e4f0;
    }

    /* Legend */
    .legend-box {
      border: 1px solid #333;
      margin-bottom: 25px;
      overflow: hidden;
    }

    .legend-header {
      background-color: #2c5aa0;
      color: white;
      padding: 8px 12px;
      font-weight: bold;
      font-size: 12pt;
      border-bottom: 1px solid #333;
    }

    .legend-content {
      padding: 10px 12px;
    }

    .legend-item {
      margin-bottom: 6px;
      font-size: 10.5pt;
    }

    .legend-item strong {
      display: inline;
    }

    /* Subject Sections */
    .subject-section {
      margin-bottom: 20px;
      page-break-inside: avoid;
    }

    .subject-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
    }

    .subject-header {
      background-color: #2c5aa0;
      color: white;
      padding: 8px 12px;
      font-weight: bold;
      font-size: 12pt;
      text-align: left;
      border: 1px solid #333;
    }

    .subject-table tbody tr:nth-child(even) {
      background-color: #f8f9fa;
    }

    .standard-name {
      padding: 6px 12px;
      border: 1px solid #ccc;
      font-size: 10.5pt;
      width: 75%;
    }

    .rating-cell {
      padding: 6px 12px;
      border: 1px solid #ccc;
      text-align: center;
      font-weight: bold;
      font-size: 12pt;
      width: 25%;
      background-color: #d6e4f0;
    }

    /* Subject Comment */
    .subject-comment {
      padding: 8px 12px;
      font-size: 9.5pt;
      line-height: 1.4;
      border: 1px solid #ccc;
      border-top: none;
      background-color: #fafafa;
    }

    .comment-label {
      font-weight: bold;
      font-size: 10pt;
      margin-bottom: 4px;
      color: #2c5aa0;
    }

    .comment-text {
      font-style: normal;
    }

    /* Footer */
    .footer {
      margin-top: 30px;
      padding-top: 15px;
      border-top: 1px solid #ccc;
      page-break-inside: avoid;
    }

    .footer-signatures {
      display: flex;
      justify-content: space-around;
      align-items: flex-end;
      margin-bottom: 15px;
      min-height: 70px;
    }

    .signature-block {
      text-align: center;
      min-width: 150px;
    }

    .signature-image {
      max-height: 50px;
      max-width: 120px;
      object-fit: contain;
      margin-bottom: 5px;
    }

    .stamp-image {
      max-height: 60px;
      max-width: 60px;
      object-fit: contain;
    }

    .signature-line {
      border-top: 1px solid #333;
      padding-top: 5px;
      font-size: 9pt;
      color: #666;
      margin-top: 8px;
    }

    .footer-info {
      text-align: center;
      font-size: 9pt;
      color: #666;
      margin-top: 15px;
    }

    @page { size: A4; margin: 18mm; }

    @media print {
      body { margin: 0; padding: 0; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      .corner-logo { position: absolute !important; top: 0 !important; right: 0 !important; width: 100px !important; }
      .subject-section { page-break-inside: avoid; }
      .footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${schoolAssets?.logoUrl ? `<img src="${schoolAssets.logoUrl}" alt="School Logo" class="corner-logo" />` : ''}

  <div class="container">
    <!-- Title -->
    <div class="title-banner">
      <h1>Senior Kindergarten Progress Report</h1>
    </div>

    <!-- Student Info -->
    <table class="info-table">
      <tr>
        <td class="info-label">Name of Student:</td>
        <td class="info-value">${name}</td>
        <td class="info-label">Teacher: ${homeroomTeacher}</td>
      </tr>
      ${teacherAssistant ? `
      <tr>
        <td colspan="2"></td>
        <td class="info-label">Teacher Assistant: ${teacherAssistant}</td>
      </tr>
      ` : ''}
      <tr class="blue-row">
        <td><span class="info-label">Days of absence</span><br/>${daysOfAbsence}</td>
        <td><span class="info-label">School</span><br/>${schoolInfo.name || 'Al Haadi Academy'}</td>
        <td><span class="info-label">OEN:</span><br/>${oen || 'N/A'}</td>
      </tr>
    </table>

    <!-- Legend -->
    <div class="legend-box">
      <div class="legend-header">Rating Scale</div>
      <div class="legend-content">
        <div class="legend-item"><strong>E - Excellent:</strong> Demonstrates thorough understanding and consistently exceeds expectations.</div>
        <div class="legend-item"><strong>G - Good:</strong> Demonstrates solid understanding and meets expectations consistently.</div>
        <div class="legend-item"><strong>S - Satisfactory:</strong> Demonstrates adequate understanding and meets expectations with some support.</div>
        <div class="legend-item"><strong>NI - Needs Improvement:</strong> Demonstrates limited understanding; additional support and practice are required.</div>
        <div class="legend-item"><strong>NA - Not Applicable:</strong> Not assessed at this time.</div>
      </div>
    </div>

    <!-- Subject Sections -->
    ${subjectSections}

    <!-- Footer -->
    <div class="footer">
      ${schoolAssets?.principalSignatureUrl || schoolAssets?.schoolStampUrl ? `
      <div class="footer-signatures">
        <div class="signature-block">
          ${schoolAssets.principalSignatureUrl ? `<img src="${schoolAssets.principalSignatureUrl}" alt="Principal Signature" class="signature-image" />` : ''}
          <div class="signature-line">Principal's Signature</div>
        </div>
        <div class="signature-block">
          ${schoolAssets.schoolStampUrl ? `<img src="${schoolAssets.schoolStampUrl}" alt="School Stamp" class="stamp-image" />` : ''}
          <div class="signature-line">School Stamp</div>
        </div>
      </div>
      ` : ''}
      <div class="footer-info">
        <div>Created on ${generatedDate}</div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = { getAlHaadiProgressReportSKHTML };
