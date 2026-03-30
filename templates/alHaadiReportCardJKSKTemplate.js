/**
 * Al Haadi Academy - JK/SK Full Report Card Template
 * Generates HTML for the end-of-term report card with BG/DV/NI scale,
 * narrative comments per domain, and E/G/S/N Learning Skills section
 */

const { formatCommentHTML } = require('../utils/commentFormatter');

const LEARNING_SKILL_NAMES = [
  'Responsibility',
  'Organization',
  'Independent Work',
  'Initiative',
  'Collaboration',
  'Self-Regulation'
];

const LEARNING_SKILL_DESCRIPTORS = {
  'Responsibility': [
    'Fulfils responsibilities and commitments within the learning environment',
    'Completes and submits class work, homework, and assignments according to agreed-upon timelines.'
  ],
  'Organization': [
    'Devises and follows a plan and process for completing work and tasks.',
    'Establishes priorities and manages time to complete tasks and achieve goals.'
  ],
  'Independent Work': [
    'Independently monitors, assesses, and revises plans to complete tasks and meet goals.',
    'Uses class time appropriately to complete tasks.'
  ],
  'Initiative': [
    'Looks for and acts on new ideas and opportunities for learning.',
    'Demonstrates the capacity for innovation and a willingness to take risks.',
    'Demonstrates curiosity and interest in learning.',
    'Approaches new tasks with a positive attitude.',
    'Recognizes and advocates appropriately for the rights of self and others.'
  ],
  'Collaboration': [
    'Accepts various roles and an equitable share of work in a group.',
    'Responds positively to the ideas, opinions, values, and traditions of others.',
    'Builds healthy peer-to-peer relationships through personal and media-assisted interactions.',
    'Works with others to resolve conflicts and build consensus to achieve group goals.',
    'Shares information, resources, and expertise, and promotes critical thinking to solve problems and make decisions.'
  ],
  'Self-Regulation': [
    'Sets own individual goals and monitors progress towards achieving them.',
    'Seeks clarification or assistance when needed.',
    'Assesses and reflects critically on own strengths, needs, and interests.',
    'Identifies learning opportunities, choices, and strategies to meet personal needs and achieve goals.',
    'Perseveres and makes an effort when responding to challenges'
  ]
};

function getAcademicYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  return month >= 8 ? `${year} - ${year + 1}` : `${year - 1} - ${year}`;
}

const getAlHaadiReportCardJKSKHTML = (data) => {
  const {
    schoolInfo, schoolAssets, student, term, domains,
    ratingMapTerm1, ratingMapTerm2, commentMap, learningSkills, generatedDate
  } = data;
  const { name, grade, oen, homeroomTeacher, teacherAssistant, daysOfAbsence } = student;

  const gradeLabel = grade === 'JK' ? 'Junior Kindergarten' : 'Senior Kindergarten';
  const academicYear = getAcademicYear();

  // Build domain sections
  const domainSections = domains.map(domain => {
    const skillRows = domain.skills.map(skill => `
      <tr>
        <td class="learning-goal">${skill.name}</td>
        <td class="approach-desc">${skill.description || ''}</td>
        <td class="term-cell">${ratingMapTerm1[skill.skillId] || ''}</td>
        <td class="term-cell">${ratingMapTerm2[skill.skillId] || ''}</td>
      </tr>
    `).join('');

    const comment = commentMap[domain.domainId];
    const commentHTML = comment ? formatCommentHTML(comment) : '';

    return `
      <div class="domain-section">
        <table class="domain-table">
          <thead>
            <tr>
              <th class="col-goal">Learning Goals</th>
              <th class="col-approach">${domain.name}</th>
              <th class="col-term">Term 1</th>
              <th class="col-term">Term 2</th>
            </tr>
          </thead>
          <tbody>
            ${skillRows}
          </tbody>
        </table>
        ${commentHTML ? `
        <div class="domain-comment">
          <div class="comment-text">${commentHTML}</div>
        </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // Build Learning Skills section
  const learningSkillRows = LEARNING_SKILL_NAMES.map(skillName => {
    const descriptors = LEARNING_SKILL_DESCRIPTORS[skillName] || [];
    const rating = learningSkills[skillName] || '';
    const descriptorList = descriptors.map(d => `<li>${d}</li>`).join('');

    return `
      <tr>
        <td class="ls-name" colspan="2">
          <strong>${skillName}</strong>
          <ul class="ls-descriptors">${descriptorList}</ul>
        </td>
        <td class="ls-rating">${rating}</td>
        <td class="ls-rating"></td>
      </tr>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Report Card - ${name}</title>
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

    /* Domain Tables */
    .domain-section {
      margin-bottom: 18px;
      page-break-inside: avoid;
    }

    .domain-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
    }

    .domain-table th {
      background-color: #2c5aa0;
      color: white;
      padding: 6px 8px;
      font-size: 9.5pt;
      font-weight: bold;
      border: 1px solid #333;
      text-align: center;
    }

    .col-goal { width: 22%; text-align: left !important; }
    .col-approach { width: 48%; text-align: left !important; }
    .col-term { width: 15%; }

    .domain-table td {
      padding: 5px 8px;
      border: 1px solid #ccc;
      font-size: 9.5pt;
      vertical-align: top;
    }

    .learning-goal {
      font-weight: bold;
      font-size: 9pt;
    }

    .approach-desc {
      font-size: 9pt;
    }

    .term-cell {
      text-align: center;
      font-weight: bold;
      font-size: 10pt;
    }

    /* Domain Comment */
    .domain-comment {
      padding: 8px 10px;
      font-size: 9pt;
      line-height: 1.4;
      border: 1px solid #ccc;
      border-top: none;
      background-color: #fafafa;
    }

    .comment-text {
      font-style: normal;
    }

    /* Learning Skills Section */
    .ls-section {
      margin-top: 20px;
      page-break-before: always;
    }

    .ls-title {
      text-align: center;
      font-size: 16pt;
      font-weight: bold;
      margin-bottom: 10px;
      text-decoration: underline;
    }

    .ls-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #333;
    }

    .ls-table th {
      background-color: #e0e0e0;
      padding: 5px 8px;
      font-size: 9pt;
      border: 1px solid #333;
      text-align: center;
    }

    .ls-legend-row th {
      font-weight: normal;
      font-size: 9pt;
    }

    .ls-name {
      padding: 6px 8px;
      border: 1px solid #ccc;
      font-size: 9pt;
      vertical-align: top;
    }

    .ls-name strong {
      display: block;
      background-color: #e0e0e0;
      padding: 3px 6px;
      margin: -6px -8px 6px -8px;
      font-size: 9.5pt;
    }

    .ls-descriptors {
      margin: 4px 0 0 16px;
      font-size: 8.5pt;
      line-height: 1.3;
    }

    .ls-descriptors li {
      margin-bottom: 2px;
    }

    .ls-rating {
      text-align: center;
      font-weight: bold;
      font-size: 12pt;
      vertical-align: middle;
      border: 1px solid #ccc;
      width: 8%;
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
      .domain-section { page-break-inside: avoid; }
      .ls-section { page-break-before: always; }
      .footer { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  ${schoolAssets?.logoUrl ? `<img src="${schoolAssets.logoUrl}" alt="School Logo" class="corner-logo" />` : ''}

  <div class="container">
    <!-- Header -->
    <div class="header">
      <h1>Kindergarten Report Card: &nbsp;${academicYear}</h1>
    </div>

    <!-- Student Info -->
    <div class="info-section">
      <table class="info-table">
        <tr>
          <td class="info-header" colspan="6">${gradeLabel} First Term Report Card ${academicYear}</td>
        </tr>
        <tr>
          <td class="label-cell">Name of Student: ${name}</td>
          <td>OEN: ${oen || 'N/A'}</td>
          <td>Days Absent: ${daysOfAbsence}</td>
        </tr>
        <tr>
          <td class="label-cell">Grade: ${gradeLabel}</td>
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

    <!-- Domain Sections -->
    ${domainSections}

    <!-- Learning Skills Section -->
    <div class="ls-section">
      <div class="ls-title">LEARNING SKILLS</div>
      <table class="ls-table">
        <thead>
          <tr class="ls-legend-row">
            <th style="width: 16%;">Learning Skills</th>
            <th style="width: 60%;">E – Excellent &nbsp;&nbsp; G – Good &nbsp;&nbsp; S – Satisfactory &nbsp;&nbsp; N – Needs Improvement</th>
            <th style="width: 12%;"></th>
            <th style="width: 12%;"></th>
          </tr>
        </thead>
        <tbody>
          ${learningSkillRows}
        </tbody>
      </table>
    </div>

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
        ${domains.length > 0 ? Math.ceil(domains.length / 2) + 2 : 3} | Page
      </div>
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = { getAlHaadiReportCardJKSKHTML };
