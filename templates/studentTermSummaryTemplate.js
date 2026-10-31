// First page of a student's all-classes summary: every class they're in for
// the term with its term grade, so a conference opens on the whole picture.
// Each class's own summary page (studentSummaryTemplate[Horizontal]) follows.
// Same blue letterhead as those pages; works in either orientation.

const { formatCoverage } = require('../services/gradeEngine');
const { getLetterGrade } = require('./studentSummaryCells');
const { escapeHtml } = require('./printKit');

/**
 * @param {object} p
 * @param {{name,address,phone,email}} p.schoolInfo
 * @param {{name,grade}} p.student
 * @param {{name}} p.term
 * @param {Array<{subject,teacherName,pct:number|null,coverage:object|null}>} p.classes
 * @param {number} p.daysOfAbsence
 * @param {'horizontal'|'vertical'} [p.orientation]
 */
function getStudentTermSummaryHTML({ schoolInfo, student, term, classes, daysOfAbsence = 0, orientation = 'horizontal' }) {
  const landscape = orientation !== 'vertical';
  // A long timetable packs its rows tighter, so up to a dozen classes keep to one landscape page.
  const rowPadding = landscape ? (classes.length > 9 ? '4px 12px' : '7px 12px') : '11px 12px';
  const gradedCount = classes.filter((c) => c.pct != null).length;

  const rows = classes
    .map((c) => {
      const lg = c.pct != null ? getLetterGrade(c.pct) : null;
      return `
        <tr>
          <td class="subject">${escapeHtml(c.subject)}</td>
          <td class="teacher">${escapeHtml(c.teacherName) || '—'}</td>
          <td class="coverage">${c.coverage ? escapeHtml(formatCoverage(c.coverage)) : 'No assessments yet'}</td>
          <td class="grade">
            ${c.pct != null
              ? `<span class="pct">${c.pct.toFixed(1)}%</span><span class="badge" style="background:${lg.bg};color:${lg.color}">${lg.letter}</span>`
              : '<span class="none">Not yet graded</span>'}
          </td>
        </tr>`;
    })
    .join('');

  const absenceClass = daysOfAbsence === 0 ? 'good' : daysOfAbsence > 5 ? 'bad' : 'warning';
  const absenceLabel = daysOfAbsence === 0 ? 'Perfect attendance' : daysOfAbsence === 1 ? 'Day absent' : 'Days absent';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Term Summary - ${escapeHtml(student.name)}</title>
      <style>
        ${landscape ? '@page { size: A4 landscape; margin: 15mm; }' : ''}
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          color: #1f2937;
          line-height: 1.5;
          background: #ffffff;
        }
        .header {
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
          color: white;
          padding: ${landscape ? '16px 28px' : '22px 28px'};
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
        }
        .school-name { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
        .school-details { font-size: 13px; opacity: 0.9; line-height: 1.4; margin-top: 2px; }
        .report-title {
          font-size: 15px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
          background: rgba(255, 255, 255, 0.15); padding: 8px 18px; border-radius: 4px; white-space: nowrap;
        }
        .body { padding: ${landscape ? '16px 28px' : '24px 28px'}; }
        .student {
          display: flex; flex-wrap: wrap; align-items: stretch; gap: 14px; margin-bottom: ${landscape ? '16px' : '24px'};
        }
        .card {
          border: 1px solid #e5e7eb; border-radius: 8px; padding: ${landscape ? '10px 18px' : '16px 20px'}; background: #ffffff;
        }
        .who { flex: 1 1 260px; }
        .label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
        .student-name { font-size: ${landscape ? '22px' : '26px'}; font-weight: 700; line-height: 1.2; margin-top: 2px; }
        .meta { font-size: 14px; color: #6b7280; margin-top: 4px; }
        .stat { flex: 0 0 170px; text-align: center; display: flex; flex-direction: column; justify-content: center; }
        .stat-value { font-size: ${landscape ? '28px' : '32px'}; font-weight: 700; line-height: 1.1; margin-top: 4px; }
        .of { font-size: 16px; font-weight: 600; color: #9ca3af; }
        .good { color: #10b981; } .warning { color: #f59e0b; } .bad { color: #ef4444; }
        .stat-note { font-size: 12px; color: #9ca3af; margin-top: 4px; }
        h2 {
          font-size: 13px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px;
          padding-bottom: 10px; border-bottom: 2px solid #3b82f6; margin-bottom: 4px;
        }
        table { width: 100%; border-collapse: collapse; font-size: 14px; }
        thead th {
          text-align: left; font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase;
          letter-spacing: 0.5px; padding: ${landscape ? '8px 12px' : '10px 12px'}; background: #f3f4f6; border-bottom: 2px solid #e5e7eb;
        }
        thead th:last-child { text-align: right; }
        tbody td { padding: ${rowPadding}; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
        tbody tr { page-break-inside: avoid; }
        .subject { font-weight: 600; }
        .teacher, .coverage { color: #6b7280; }
        .coverage { font-size: 13px; }
        .grade { text-align: right; white-space: nowrap; }
        .pct { font-weight: 600; }
        .none { color: #9ca3af; }
        .badge { display: inline-block; margin-left: 8px; min-width: 34px; text-align: center; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 700; }
        .empty { padding: 40px; text-align: center; color: #9ca3af; font-style: italic; }
        .note { font-size: 12px; color: #6b7280; margin-top: 14px; }
        .footer { text-align: center; padding: 12px; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; margin-top: ${landscape ? '14px' : '24px'}; }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <div class="school-name">${escapeHtml(schoolInfo.name)}</div>
          <div class="school-details">${escapeHtml(schoolInfo.address)}${schoolInfo.phone || schoolInfo.email ? `<br>${[schoolInfo.phone, schoolInfo.email].filter(Boolean).map(escapeHtml).join(' | ')}` : ''}</div>
        </div>
        <div class="report-title">Term Summary</div>
      </div>

      <div class="body">
        <div class="student">
          <div class="card who">
            <div class="label">Student</div>
            <div class="student-name">${escapeHtml(student.name)}</div>
            <div class="meta">Grade ${escapeHtml(student.grade)} &nbsp;|&nbsp; ${escapeHtml(term.name)} &nbsp;|&nbsp; ${classes.length} class${classes.length === 1 ? '' : 'es'}</div>
          </div>
          <div class="card stat">
            <div class="label">Graded so far</div>
            <div class="stat-value">${gradedCount}<span class="of"> of ${classes.length}</span></div>
            <div class="stat-note">classes</div>
          </div>
          <div class="card stat">
            <div class="label">Attendance</div>
            <div class="stat-value ${absenceClass}">${daysOfAbsence}</div>
            <div class="stat-note">${absenceLabel}</div>
          </div>
        </div>

        <h2>Term grades</h2>
        ${classes.length > 0 ? `
          <table>
            <thead>
              <tr><th>Class</th><th>Teacher</th><th>Assessed</th><th>Term grade</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="note">Each class's assessments follow, one class per page.</p>
        ` : '<div class="empty">No classes this term.</div>'}

        <div class="footer">
          Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = { getStudentTermSummaryHTML };
