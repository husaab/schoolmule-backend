/**
 * Al Haadi Academy - JK/SK Progress Report Card Template
 * Generates HTML for the mid-year progress report with D/B/I/N scale
 */

const getAlHaadiProgressReportJKSKHTML = (data) => {
  const { schoolInfo, schoolAssets, student, domains, ratingMap, generatedDate } = data;
  const { name, grade, oen, homeroomTeacher, teacherAssistant, daysOfAbsence } = student;

  const gradeLabel = grade === 'JK' ? 'Junior Kindergarten' : 'Senior Kindergarten';

  const domainSections = domains.map(domain => {
    const skillRows = domain.skills.map(skill => {
      const rating = ratingMap[skill.skillId] || '';
      return `
        <tr>
          <td class="skill-name">${skill.name}</td>
          <td class="rating-cell">${rating}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="domain-section">
        <table class="domain-table">
          <thead>
            <tr>
              <th class="domain-header" colspan="2">${domain.name}</th>
            </tr>
          </thead>
          <tbody>
            ${skillRows}
          </tbody>
        </table>
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Progress Report - ${name}</title>
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
      border: 2px solid #333;
      padding: 20px;
      text-align: center;
      margin-bottom: 20px;
    }

    .title-banner h1 {
      font-size: 24px;
      font-weight: bold;
      color: #333;
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

    .info-table .pink-row td {
      background-color: #f8d7da;
    }

    /* Legend */
    .legend-box {
      border: 1px solid #333;
      margin-bottom: 25px;
      overflow: hidden;
    }

    .legend-header {
      background-color: #d4edda;
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

    /* Domain Sections */
    .domain-section {
      margin-bottom: 20px;
      page-break-inside: avoid;
    }

    .domain-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
    }

    .domain-header {
      background-color: #d4edda;
      padding: 8px 12px;
      font-weight: bold;
      font-size: 12pt;
      text-align: left;
      border: 1px solid #333;
    }

    .domain-table tbody tr:nth-child(even) {
      background-color: #f8f9fa;
    }

    .skill-name {
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
      .domain-section { page-break-inside: avoid; }
      .footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${schoolAssets?.logoUrl ? `<img src="${schoolAssets.logoUrl}" alt="School Logo" class="corner-logo" />` : ''}

  <div class="container">
    <!-- Title -->
    <div class="title-banner">
      <h1>${gradeLabel} Progress Report Card</h1>
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
      <tr class="pink-row">
        <td><span class="info-label">Days of absence</span><br/>${daysOfAbsence}</td>
        <td><span class="info-label">School</span><br/>${schoolInfo.name || 'Al Haadi Academy'}</td>
        <td><span class="info-label">OEN:</span><br/>${oen || 'N/A'}</td>
      </tr>
    </table>

    <!-- Legend -->
    <div class="legend-box">
      <div class="legend-header">Learning Skills</div>
      <div class="legend-content">
        <div class="legend-item"><strong>D - Developing:</strong> Children can apply the skill or concept correctly.</div>
        <div class="legend-item"><strong>B - Beginning:</strong> Children show some understanding. Reminders, hints, or support is necessary.</div>
        <div class="legend-item"><strong>I - Improvement needed:</strong> Children are experiencing difficulty with the concept or skill. Assistance at home is needed.</div>
        <div class="legend-item"><strong>N - Not Assessed:</strong> Not assessed at this time</div>
      </div>
    </div>

    <!-- Skill Domains -->
    ${domainSections}

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

module.exports = { getAlHaadiProgressReportJKSKHTML };
