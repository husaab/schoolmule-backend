// templates/certificateTemplate.js
//
// Renders one PDF page per student listing them as a recipient of the
// view's award (e.g., "Academic Excellence"). Print-friendly A4.

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function certificatePage({ schoolName, viewName, viewDescription, studentName, grade, metric, issuedDate }) {
  return `
    <section class="certificate">
      <div class="border-frame">
        <div class="school-name">${escapeHtml(schoolName)}</div>
        <div class="award-title">${escapeHtml(viewName)}</div>
        <div class="presented-line">is proudly presented to</div>
        <div class="student-name">${escapeHtml(studentName)}</div>
        <div class="grade-line">Grade ${escapeHtml(grade)}</div>
        <div class="description">${escapeHtml(viewDescription)}</div>
        <div class="metric-line">Achieved Average: <strong>${escapeHtml(metric)}%</strong></div>
        <div class="footer-row">
          <div class="footer-cell">
            <div class="footer-rule"></div>
            <div class="footer-label">Date Issued</div>
            <div class="footer-value">${escapeHtml(issuedDate)}</div>
          </div>
          <div class="footer-cell">
            <div class="footer-rule"></div>
            <div class="footer-label">Authorized Signature</div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function certificateTemplate({ schoolName, viewName, viewDescription, students, issuedDate }) {
  const pages = students
    .map((s) =>
      certificatePage({
        schoolName,
        viewName,
        viewDescription,
        studentName: s.studentName,
        grade: s.grade,
        metric: s.metric,
        issuedDate,
      }),
    )
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(viewName)} — Certificates</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Georgia', 'Times New Roman', serif; color: #1f2937; }
  .certificate {
    width: 100%;
    height: 100vh;
    page-break-after: always;
    padding: 32px;
    background: #fffdf5;
  }
  .certificate:last-child { page-break-after: auto; }
  .border-frame {
    height: 100%;
    border: 6px double #b45309;
    padding: 48px 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    text-align: center;
  }
  .school-name {
    font-size: 22px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: #92400e;
  }
  .award-title {
    font-size: 48px;
    font-weight: 700;
    color: #78350f;
    margin-top: 8px;
  }
  .presented-line {
    font-size: 18px;
    font-style: italic;
    color: #4b5563;
    margin-top: 32px;
  }
  .student-name {
    font-size: 56px;
    margin-top: 8px;
    border-bottom: 2px solid #b45309;
    padding-bottom: 8px;
    min-width: 60%;
  }
  .grade-line {
    font-size: 18px;
    margin-top: 8px;
    color: #6b7280;
  }
  .description {
    font-size: 16px;
    color: #374151;
    max-width: 720px;
    margin-top: 24px;
    line-height: 1.5;
  }
  .metric-line {
    font-size: 20px;
    margin-top: 16px;
    color: #1f2937;
  }
  .footer-row {
    display: flex;
    justify-content: space-between;
    width: 100%;
    margin-top: 48px;
  }
  .footer-cell {
    width: 38%;
    text-align: center;
  }
  .footer-rule {
    border-top: 1px solid #1f2937;
    margin-bottom: 6px;
  }
  .footer-label {
    font-size: 12px;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .footer-value {
    font-size: 14px;
    margin-top: 4px;
  }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

module.exports = certificateTemplate;
