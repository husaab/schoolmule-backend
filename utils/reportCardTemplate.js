/**
 * Report Card HTML Template
 * Generates a professional, print-ready report card with blue color scheme
 */

function getReportCardHTML({
  schoolInfo,
  schoolAssets,
  student,
  term,
  subjects,
  feedbacks,
  generatedDate
}) {
  const { name, grade, oen, homeroomTeacher, daysOfAbsence, school } = student;
  const { logoUrl, principalSignatureUrl, schoolStampUrl } = schoolAssets || {};
  const {
    name: schoolName = school,
    address: schoolAddress = '',
    phone: schoolPhone = '',
    email: schoolEmail = ''
  } = schoolInfo || {};

  // Generate subject cards with dedicated comment boxes (2 per page max)
  const subjectCards = subjects.map((sub, index) => {
    const feedback = feedbacks.find(fb => fb.subject === sub.subject);
    const workHabits = feedback?.work_habits || '-';
    const behavior = feedback?.behavior || '-';
    const comment = feedback?.comment || '';

    // Add page break after every 2nd card (but not after the last pair)
    const needsPageBreak = (index + 1) % 2 === 0 && index < subjects.length - 1;

    return `
      <div class="subject-card">
        <div class="subject-header">${sub.subject}</div>
        <table class="grades-table">
          <thead>
            <tr>
              <th>Grade</th>
              <th>Work Habits</th>
              <th>Behaviour</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="grade-cell">${sub.grade}%</td>
              <td class="habit-cell">${workHabits}</td>
              <td class="habit-cell">${behavior}</td>
            </tr>
          </tbody>
        </table>
        <div class="comment-header">Teacher Comments</div>
        <div class="comment-box">${comment || '<span class="no-comment">No comments provided</span>'}</div>
      </div>
      ${needsPageBreak ? '<div class="page-break"></div>' : ''}
    `;
  }).join('');

  // Format term for display (e.g., "Term 1" -> "FIRST TERM")
  const termDisplay = formatTermDisplay(term);
  const academicYear = getAcademicYear();

  // Build school contact line
  const contactParts = [];
  if (schoolAddress) contactParts.push(schoolAddress);
  if (schoolPhone) contactParts.push(schoolPhone);
  if (schoolEmail) contactParts.push(schoolEmail);
  const contactLine = contactParts.join(' | ');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Report Card - ${name}</title>
      <style>
        :root {
          --primary-blue: #2c5aa0;
          --light-blue: #d6e4f0;
          --lighter-blue: #e8f0f8;
          --text-primary: #333333;
          --text-secondary: #666666;
          --border-color: #cccccc;
          --white: #ffffff;
          --light-gray: #f8f9fa;
          --logo-w: 160px;
          --logo-h: 90px;
          --logo-gutter: 0px;
          --logo-nudge-x: -8px;
          --logo-nudge-y: -6px;
        }

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: 'Georgia', 'Cambria', serif;
          font-size: 11pt;
          color: var(--text-primary);
          background: var(--white);
          line-height: 1.4;
          padding: 20px;
        }

        .container {
          max-width: 210mm;
          margin: 0 auto;
          position: relative;
          background: var(--white);
        }

        /* Corner Logo - matches progress report */
        .corner-logo {
          position: fixed;
          top: var(--logo-gutter);
          right: var(--logo-gutter);
          width: var(--logo-w);
          max-height: var(--logo-h);
          height: auto;
          object-fit: contain;
          z-index: 1000;
          pointer-events: none;
          transform: translate(var(--logo-nudge-x), var(--logo-nudge-y));
        }

        /* Header Section */
        .header {
          text-align: center;
          margin-bottom: 25px;
          padding-bottom: 15px;
          border-bottom: 3px solid var(--primary-blue);
        }

        .school-name {
          font-size: 28px;
          font-weight: bold;
          color: var(--text-primary);
          margin-bottom: 5px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .school-contact {
          font-size: 11px;
          color: var(--text-secondary);
          margin-bottom: 15px;
        }

        .report-title {
          display: inline-block;
          font-size: 18px;
          font-weight: bold;
          color: var(--text-primary);
          margin-top: 10px;
          padding: 10px 30px;
          background: var(--light-blue);
          border: 1px solid var(--border-color);
        }

        /* Student Info Grid */
        .student-info {
          margin-bottom: 20px;
          padding: 15px 20px;
          border: 1px solid var(--border-color);
          border-radius: 5px;
        }

        .student-info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px 40px;
        }

        .info-item {
          display: flex;
          gap: 8px;
        }

        .info-label {
          font-weight: bold;
          color: var(--text-primary);
          min-width: 150px;
          font-size: 11pt;
        }

        .info-value {
          color: var(--text-primary);
          font-size: 11pt;
        }

        /* Work Habits Legend - Horizontal Row Layout */
        .work-habits-legend {
          margin-bottom: 20px;
          text-align: center;
        }

        .legend-title-box {
          display: inline-block;
          background: var(--light-blue);
          border: 1px solid var(--border-color);
          padding: 8px 20px;
          font-weight: bold;
          font-size: 12pt;
          color: var(--text-primary);
          margin-bottom: 10px;
        }

        .work-habits-table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 5px;
          text-align: left;
        }

        .work-habits-table th,
        .work-habits-table td {
          border: 1px solid var(--border-color);
          padding: 10px 15px;
          text-align: center;
          font-size: 11pt;
        }

        .work-habits-table th {
          background: var(--white);
          font-weight: normal;
        }

        .work-habits-table td {
          background: var(--white);
          font-weight: bold;
          font-size: 14pt;
        }

        /* Achievement Legend */
        .achievement-legend {
          margin-bottom: 25px;
          text-align: center;
        }

        .achievement-table {
          text-align: left;
          width: 100%;
          border-collapse: collapse;
          margin-top: 5px;
        }

        .achievement-table th {
          background: var(--light-gray);
          border: 1px solid var(--border-color);
          padding: 8px 12px;
          font-weight: bold;
          font-size: 10pt;
          text-align: center;
        }

        .achievement-table td {
          border: 1px solid var(--border-color);
          padding: 6px 10px;
          font-size: 10pt;
          text-align: center;
        }

        .achievement-table .level-cell {
          font-weight: bold;
          background: var(--lighter-blue);
        }

        .achievement-table .description-cell {
          text-align: left;
          font-size: 9pt;
          line-height: 1.3;
        }

        /* Subject Cards */
        .subjects-section {
          margin-bottom: 20px;
        }

        .section-title {
          font-size: 14pt;
          font-weight: bold;
          color: var(--primary-blue);
          margin-bottom: 15px;
          padding-bottom: 5px;
          border-bottom: 2px solid var(--primary-blue);
        }

        .subject-card {
          border: 1px solid var(--border-color);
          border-radius: 5px;
          margin-bottom: 15px;
          overflow: hidden;
          page-break-inside: avoid;
        }

        /* Force page break after every 2 subject cards */
        .page-break {
          page-break-after: always;
          break-after: page;
          height: 0;
          margin: 0;
          padding: 0;
        }

        .subject-header {
          background: var(--primary-blue);
          padding: 10px 15px;
          font-weight: bold;
          font-size: 12pt;
          color: var(--white);
        }

        .grades-table {
          width: 100%;
          border-collapse: collapse;
        }

        .grades-table th {
          background: var(--light-gray);
          padding: 10px 15px;
          font-weight: bold;
          font-size: 10pt;
          border: 1px solid var(--border-color);
          text-align: center;
        }

        .grades-table td {
          padding: 12px 15px;
          border: 1px solid var(--border-color);
          text-align: center;
          background: var(--white);
        }

        .grade-cell {
          font-weight: bold;
          font-size: 14pt;
          color: var(--primary-blue);
        }

        .habit-cell {
          font-weight: bold;
          font-size: 12pt;
        }

        .comment-header {
          background: var(--light-gray);
          padding: 8px 15px;
          font-weight: bold;
          font-size: 10pt;
          color: var(--text-primary);
          border-top: 1px solid var(--border-color);
        }

        .comment-box {
          padding: 12px 15px;
          min-height: 50px;
          background: var(--white);
          font-size: 10pt;
          line-height: 1.5;
          color: var(--text-primary);
          border-left: 4px solid var(--primary-blue);
        }

        .no-comment {
          color: #999;
          font-style: italic;
        }

        /* Footer Section */
        .footer {
          margin-top: 30px;
          padding-top: 20px;
          border-top: 1px solid var(--border-color);
          page-break-inside: avoid;
        }

        .footer-signatures {
          display: flex;
          justify-content: space-around;
          align-items: flex-end;
          margin-bottom: 20px;
          min-height: 80px;
        }

        .signature-block {
          text-align: center;
          min-width: 150px;
        }

        .signature-image {
          max-height: 60px;
          max-width: 150px;
          object-fit: contain;
          margin-bottom: 5px;
        }

        .stamp-image {
          max-height: 80px;
          max-width: 80px;
          object-fit: contain;
        }

        .signature-line {
          border-top: 1px solid var(--text-primary);
          padding-top: 5px;
          font-size: 10pt;
          color: var(--text-secondary);
          margin-top: 10px;
        }

        .footer-info {
          text-align: center;
          font-size: 10pt;
          color: var(--text-secondary);
          margin-top: 20px;
        }

        .generation-date {
          margin-top: 10px;
          font-size: 9pt;
          color: #888;
        }

        /* Print Styles */
        @page {
          size: A4;
          margin: 18mm;
        }

        @media print {
          body {
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }

          :root {
            --logo-w: 140px;
            --logo-h: 90px;
            --logo-gutter: 0mm;
            --logo-nudge-x: -3mm;
            --logo-nudge-y: -2mm;
          }

          .corner-logo {
            display: block !important;
            position: absolute !important;
            top: var(--logo-gutter) !important;
            right: var(--logo-gutter) !important;
            width: var(--logo-w) !important;
            max-height: var(--logo-h) !important;
          }

          .container {
            padding: 0;
            max-width: none;
          }

          .subject-card {
            page-break-inside: avoid;
          }

          .footer {
            page-break-inside: avoid;
          }
        }
      </style>
    </head>
    <body>
      ${logoUrl ? `<img src="${logoUrl}" alt="School Logo" class="corner-logo" />` : ''}

      <div class="container">
        <!-- Header -->
        <div class="header">
          <div class="school-name">${schoolName}</div>
          ${contactLine ? `<div class="school-contact">${contactLine}</div>` : ''}
          <div class="report-title">${termDisplay} REPORT CARD ${academicYear}</div>
        </div>

        <!-- Student Information Grid -->
        <div class="student-info">
          <div class="student-info-grid">
            <div class="info-item">
              <span class="info-label">Name of Student:</span>
              <span class="info-value">${name}</span>
            </div>
            <div class="info-item">
              <span class="info-label">OEN:</span>
              <span class="info-value">${oen || 'N/A'}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Days of Absence:</span>
              <span class="info-value">${daysOfAbsence ?? 0}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Grade:</span>
              <span class="info-value">${grade}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Homeroom Teacher:</span>
              <span class="info-value">${homeroomTeacher}</span>
            </div>
          </div>
        </div>

        <!-- Work Habits & Behaviour Legend - Horizontal Row -->
        <div class="work-habits-legend">
          <div class="legend-title-box">WORK HABITS & BEHAVIOUR</div>
          <table class="work-habits-table">
            <thead>
              <tr>
                <th>Unsatisfactory</th>
                <th>Needs Improvement</th>
                <th>Satisfactory</th>
                <th>Excellent</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>U</td>
                <td>N</td>
                <td>S</td>
                <td>E</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Achievement of Curriculum Expectations Legend -->
        <div class="achievement-legend">
          <div class="legend-title-box">ACHIEVEMENT OF THE CURRICULUM EXPECTATIONS</div>
          <table class="achievement-table">
            <thead>
              <tr>
                <th style="width: 60px;">Letter</th>
                <th style="width: 70px;">Percent</th>
                <th style="width: 70px;">Level</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>A+</td>
                <td>90-100</td>
                <td rowspan="3" class="level-cell">Level 4</td>
                <td rowspan="3" class="description-cell">The student demonstrates capabilities beyond expectations for their level. Achievement surpasses the provincial standard.</td>
              </tr>
              <tr>
                <td>A</td>
                <td>85-89</td>
              </tr>
              <tr>
                <td>A-</td>
                <td>80-84</td>
              </tr>
              <tr>
                <td>B+</td>
                <td>77-79</td>
                <td rowspan="3" class="level-cell">Level 3</td>
                <td rowspan="3" class="description-cell">The student has demonstrated the required knowledge and skills with a high degree of effectiveness. Achievement surpasses the provincial standard.</td>
              </tr>
              <tr>
                <td>B</td>
                <td>73-76</td>
              </tr>
              <tr>
                <td>B-</td>
                <td>70-72</td>
              </tr>
              <tr>
                <td>C+</td>
                <td>67-69</td>
                <td rowspan="3" class="level-cell">Level 2</td>
                <td rowspan="3" class="description-cell">The student has demonstrated the required knowledge and skills with considerable effectiveness. Achievement meets the provincial standard.</td>
              </tr>
              <tr>
                <td>C</td>
                <td>63-66</td>
              </tr>
              <tr>
                <td>C-</td>
                <td>60-62</td>
              </tr>
              <tr>
                <td>D+</td>
                <td>57-59</td>
                <td rowspan="3" class="level-cell">Level 1</td>
                <td rowspan="3" class="description-cell">The student has demonstrated the required knowledge and skills with some effectiveness. Achievement approaches the provincial standard.</td>
              </tr>
              <tr>
                <td>D</td>
                <td>53-56</td>
              </tr>
              <tr>
                <td>D-</td>
                <td>50-52</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Subject Cards -->
        <div class="subjects-section">
          <div class="section-title">Academic Achievement</div>
          ${subjectCards}
        </div>

        <!-- Footer -->
        <div class="footer">
          ${principalSignatureUrl || schoolStampUrl ? `
          <div class="footer-signatures">
            <div class="signature-block">
              ${principalSignatureUrl ? `<img src="${principalSignatureUrl}" alt="Principal Signature" class="signature-image" />` : ''}
              <div class="signature-line">Principal's Signature</div>
            </div>
            <div class="signature-block">
              ${schoolStampUrl ? `<img src="${schoolStampUrl}" alt="School Stamp" class="stamp-image" />` : ''}
              <div class="signature-line">School Stamp</div>
            </div>
          </div>
          ` : ''}

          <div class="footer-info">
            <div class="generation-date">Created on ${generatedDate || new Date().toLocaleDateString('en-CA')}</div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
}

/**
 * Format term string for display
 * e.g., "Term 1" -> "FIRST TERM", "Term 2" -> "SECOND TERM"
 */
function formatTermDisplay(term) {
  const termMap = {
    'term 1': 'FIRST TERM',
    'term 2': 'SECOND TERM',
    'term 3': 'THIRD TERM',
    'term 4': 'FOURTH TERM',
    '1': 'FIRST TERM',
    '2': 'SECOND TERM',
    '3': 'THIRD TERM',
    '4': 'FOURTH TERM'
  };

  const normalized = (term || '').toLowerCase().trim();
  return termMap[normalized] || term?.toUpperCase() || 'TERM';
}

/**
 * Get academic year string (e.g., "2025-2026")
 */
function getAcademicYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // Academic year typically starts in September
  if (month >= 8) { // September or later
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

module.exports = { getReportCardHTML };
