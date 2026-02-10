/**
 * Horizontal (Landscape) Student Summary Report Template
 * Uses A4 landscape orientation for better assessment visualization
 */

/**
 * Get letter grade and color based on percentage
 * Uses Ontario grading scale
 */
function getLetterGrade(percentage) {
  if (percentage >= 90) return { letter: 'A+', color: '#10b981', bg: '#d1fae5' };
  if (percentage >= 85) return { letter: 'A', color: '#10b981', bg: '#d1fae5' };
  if (percentage >= 80) return { letter: 'A-', color: '#10b981', bg: '#d1fae5' };
  if (percentage >= 77) return { letter: 'B+', color: '#3b82f6', bg: '#dbeafe' };
  if (percentage >= 73) return { letter: 'B', color: '#3b82f6', bg: '#dbeafe' };
  if (percentage >= 70) return { letter: 'B-', color: '#3b82f6', bg: '#dbeafe' };
  if (percentage >= 67) return { letter: 'C+', color: '#f59e0b', bg: '#fef3c7' };
  if (percentage >= 63) return { letter: 'C', color: '#f59e0b', bg: '#fef3c7' };
  if (percentage >= 60) return { letter: 'C-', color: '#f59e0b', bg: '#fef3c7' };
  if (percentage >= 57) return { letter: 'D+', color: '#f97316', bg: '#ffedd5' };
  if (percentage >= 53) return { letter: 'D', color: '#f97316', bg: '#ffedd5' };
  if (percentage >= 50) return { letter: 'D-', color: '#f97316', bg: '#ffedd5' };
  return { letter: 'F', color: '#ef4444', bg: '#fee2e2' };
}

/**
 * Format assessment date to "Feb 7, 2026" format (shorter for horizontal layout)
 * Falls back to created_at if date is not available
 */
function formatAssessmentDate(date, createdAt) {
  const d = date || createdAt;
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}

function getStudentSummaryHTMLHorizontal({
  schoolInfo,
  student,
  classInfo,
  term,
  assessments,
  studentAssessments,
  calculatedGrade,
  daysOfAbsence = 0
}) {
  const { name: schoolName, address, phone, email } = schoolInfo;
  const { name: studentName, grade } = student;
  const { subject, teacher_name: teacherName } = classInfo;
  const { name: termName } = term;

  // Get letter grade for overall grade
  const overallLetterGrade = getLetterGrade(calculatedGrade);

  // Organize assessments into hierarchy: parents with children, and standalone
  const parentAssessments = assessments.filter(a => a.is_parent && a.parent_assessment_id === null);
  const standaloneAssessments = assessments.filter(a => !a.is_parent && a.parent_assessment_id === null);

  // Build assessment rows with proper nesting
  let assessmentRows = '';

  // First, render standalone assessments
  standaloneAssessments.forEach(assessment => {
    const studentScore = studentAssessments.find(sa => sa.assessment_id === assessment.assessment_id);
    let scoreDisplay = 'Not Submitted';
    let percentage = null;
    let letterGradeHtml = '';

    if (studentScore && studentScore.score !== null) {
      percentage = assessment.max_score
        ? (studentScore.score / assessment.max_score) * 100
        : studentScore.score;
      scoreDisplay = assessment.max_score
        ? `${studentScore.score}/${assessment.max_score}`
        : `${studentScore.score}%`;
      const lg = getLetterGrade(percentage);
      letterGradeHtml = `<span class="letter-badge" style="background: ${lg.bg}; color: ${lg.color};">${lg.letter}</span>`;
    }

    assessmentRows += `
      <tr class="standalone-assessment">
        <td class="date-cell">${formatAssessmentDate(assessment.date, assessment.created_at)}</td>
        <td class="name-cell">${assessment.name}</td>
        <td class="weight-cell">${parseFloat(assessment.weight_points) || 0}%</td>
        <td class="score-cell">
          <div class="score-display">
            <span class="score-value">${scoreDisplay}</span>
            ${percentage !== null ? `<span class="percentage">(${percentage.toFixed(1)}%)</span>` : ''}
            ${letterGradeHtml}
          </div>
        </td>
      </tr>
    `;
  });

  // Then, render parent assessments with their children
  parentAssessments.forEach((parent, parentIndex) => {
    const childAssessments = assessments.filter(a => a.parent_assessment_id === parent.assessment_id);

    // Calculate parent score from children
    let parentScoreDisplay = 'Not Submitted';
    let parentPercentage = null;
    let parentLetterHtml = '';

    if (childAssessments.length > 0) {
      let childTotalScore = 0;
      let childTotalPossible = 0;
      let hasScores = false;

      childAssessments.forEach(child => {
        const childScore = studentAssessments.find(sa => sa.assessment_id === child.assessment_id);
        if (childScore && childScore.score !== null) {
          const childWeight = child.weight_points || 1;
          childTotalScore += (childScore.score * childWeight);
          childTotalPossible += ((child.max_score || 100) * childWeight);
          hasScores = true;
        }
      });

      if (hasScores && childTotalPossible > 0) {
        parentPercentage = (childTotalScore / childTotalPossible) * 100;
        parentScoreDisplay = `${parentPercentage.toFixed(1)}%`;
        const lg = getLetterGrade(parentPercentage);
        parentLetterHtml = `<span class="letter-badge" style="background: ${lg.bg}; color: ${lg.color};">${lg.letter}</span>`;
      }
    }

    // Parent row
    assessmentRows += `
      <tr class="parent-assessment">
        <td class="date-cell">-</td>
        <td class="name-cell">
          <div class="parent-name">
            <span class="expand-indicator">▸</span>
            ${parent.name}
          </div>
          <div class="child-count">${childAssessments.length} assessment${childAssessments.length !== 1 ? 's' : ''}</div>
        </td>
        <td class="weight-cell">${parseFloat(parent.weight_points) || 0}%</td>
        <td class="score-cell">
          <div class="score-display">
            <span class="score-value">${parentScoreDisplay}</span>
            ${parentLetterHtml}
          </div>
        </td>
      </tr>
    `;

    // Child rows with tree indicators
    childAssessments.forEach((child, childIndex) => {
      const childScore = studentAssessments.find(sa => sa.assessment_id === child.assessment_id);
      let scoreDisplay = 'Not Submitted';
      let percentage = null;
      let letterGradeHtml = '';
      const isLast = childIndex === childAssessments.length - 1;

      if (childScore && childScore.score !== null) {
        percentage = child.max_score
          ? (childScore.score / child.max_score) * 100
          : childScore.score;
        scoreDisplay = child.max_score
          ? `${childScore.score}/${child.max_score}`
          : `${childScore.score}%`;
        const lg = getLetterGrade(percentage);
        letterGradeHtml = `<span class="letter-badge" style="background: ${lg.bg}; color: ${lg.color};">${lg.letter}</span>`;
      }

      assessmentRows += `
        <tr class="child-assessment ${isLast ? 'last-child' : ''}">
          <td class="date-cell">${formatAssessmentDate(child.date, child.created_at)}</td>
          <td class="name-cell">
            <div class="child-name-wrapper">
              <span class="tree-connector ${isLast ? 'last' : ''}"></span>
              <span class="child-name">${child.name}</span>
            </div>
          </td>
          <td class="weight-cell">${parseFloat(child.weight_points) || 0}%</td>
          <td class="score-cell">
            <div class="score-display">
              <span class="score-value">${scoreDisplay}</span>
              ${percentage !== null ? `<span class="percentage">(${percentage.toFixed(1)}%)</span>` : ''}
              ${letterGradeHtml}
            </div>
          </td>
        </tr>
      `;
    });
  });

  // Weight breakdown for parents + standalone
  const allTopLevel = [...standaloneAssessments, ...parentAssessments];
  const weightBreakdown = allTopLevel.reduce((acc, assessment) => {
    const weight = parseFloat(assessment.weight_points) || 0;
    if (weight > 0) {
      acc.push(`<span class="weight-item">${assessment.name}: <strong>${weight}%</strong></span>`);
    }
    return acc;
  }, []).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Student Summary Report - ${studentName}</title>
      <style>
        @page {
          size: A4 landscape;
          margin: 15mm;
        }

        :root {
          --primary: #3b82f6;
          --primary-dark: #2563eb;
          --primary-light: #eff6ff;
          --success: #10b981;
          --warning: #f59e0b;
          --danger: #ef4444;
          --text-primary: #1f2937;
          --text-secondary: #6b7280;
          --text-muted: #9ca3af;
          --bg-primary: #ffffff;
          --bg-secondary: #f9fafb;
          --bg-tertiary: #f3f4f6;
          --border-color: #e5e7eb;
          --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
          --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
          --radius: 8px;
        }

        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          background-color: var(--bg-secondary);
          color: var(--text-primary);
          line-height: 1.5;
          padding: 0;
        }

        .container {
          width: 100%;
          min-height: 100vh;
          background: var(--bg-primary);
        }

        /* Header - Full Width */
        .header {
          background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
          color: white;
          padding: 20px 32px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .header-left {
          display: flex;
          align-items: center;
          gap: 24px;
        }

        .school-name {
          font-size: 24px;
          font-weight: 700;
          letter-spacing: -0.5px;
        }

        .school-details {
          font-size: 13px;
          opacity: 0.9;
          line-height: 1.4;
          border-left: 1px solid rgba(255, 255, 255, 0.3);
          padding-left: 24px;
        }

        .report-title {
          font-size: 16px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
          background: rgba(255, 255, 255, 0.15);
          padding: 8px 20px;
          border-radius: 4px;
        }

        /* Main Layout - Two Columns */
        .main-layout {
          display: flex;
          gap: 24px;
          padding: 24px;
          min-height: calc(100vh - 140px);
        }

        /* Sidebar */
        .sidebar {
          width: 280px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        /* Main Content */
        .main-content {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }

        /* Cards */
        .card {
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius);
          padding: 20px;
          box-shadow: var(--shadow-sm);
        }

        .card-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 2px solid var(--primary);
        }

        /* Student Info in Sidebar */
        .info-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .info-item {
          display: flex;
          flex-direction: column;
        }

        .info-label {
          font-size: 11px;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 2px;
        }

        .info-value {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
        }

        /* Grade Display */
        .grade-display {
          text-align: center;
          padding: 24px 20px;
        }

        .grade-percentage {
          font-size: 48px;
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1;
        }

        .grade-letter {
          display: inline-block;
          margin-top: 12px;
          padding: 8px 24px;
          border-radius: 24px;
          font-size: 20px;
          font-weight: 700;
        }

        .grade-label {
          font-size: 12px;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-top: 12px;
        }

        /* Attendance Card */
        .attendance-display {
          text-align: center;
          padding: 16px;
        }

        .attendance-value {
          font-size: 36px;
          font-weight: 700;
          line-height: 1;
        }

        .attendance-value.good {
          color: var(--success);
        }

        .attendance-value.warning {
          color: var(--warning);
        }

        .attendance-value.bad {
          color: var(--danger);
        }

        .attendance-label {
          font-size: 13px;
          color: var(--text-muted);
          margin-top: 8px;
        }

        /* Weight Breakdown */
        .weight-breakdown {
          background: var(--bg-tertiary);
          border-radius: var(--radius);
          padding: 16px;
          border-left: 4px solid var(--primary);
        }

        .weight-breakdown-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary);
          margin-bottom: 10px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .weight-items {
          display: flex;
          flex-wrap: wrap;
          gap: 12px 24px;
        }

        .weight-item {
          font-size: 13px;
          color: var(--text-primary);
        }

        /* Assessment Table */
        .assessment-table-wrapper {
          flex: 1;
          overflow: hidden;
        }

        .assessment-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }

        .assessment-table thead th {
          background: var(--bg-tertiary);
          padding: 14px 16px;
          text-align: left;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: 0.5px;
          border-bottom: 2px solid var(--border-color);
          position: sticky;
          top: 0;
        }

        .assessment-table thead th:nth-child(1) { width: 120px; }
        .assessment-table thead th:nth-child(3) { width: 80px; text-align: center; }
        .assessment-table thead th:nth-child(4) { width: 200px; text-align: right; }

        .assessment-table tbody td {
          padding: 14px 16px;
          border-bottom: 1px solid var(--border-color);
          vertical-align: middle;
        }

        .assessment-table tbody tr:last-child td {
          border-bottom: none;
        }

        /* Standalone assessments */
        .standalone-assessment td {
          background: var(--bg-primary);
        }

        .standalone-assessment:hover td {
          background: var(--bg-secondary);
        }

        /* Parent assessment rows */
        .parent-assessment td {
          background: var(--primary-light);
          border-left: 4px solid var(--primary);
        }

        .parent-name {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          color: var(--primary-dark);
        }

        .expand-indicator {
          color: var(--primary);
          font-size: 12px;
        }

        .child-count {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 2px;
          margin-left: 20px;
        }

        /* Child assessment rows */
        .child-assessment td {
          background: var(--bg-primary);
        }

        .child-assessment:hover td {
          background: var(--bg-secondary);
        }

        .child-assessment td:first-child {
          padding-left: 32px;
        }

        .child-name-wrapper {
          display: flex;
          align-items: center;
          padding-left: 20px;
          position: relative;
        }

        .tree-connector {
          position: absolute;
          left: 0;
          top: 50%;
          width: 16px;
          height: 1px;
          background: var(--border-color);
        }

        .tree-connector::before {
          content: '';
          position: absolute;
          left: 0;
          bottom: 0;
          width: 1px;
          height: 28px;
          background: var(--border-color);
        }

        .tree-connector.last::before {
          height: 14px;
          bottom: 0;
        }

        .child-name {
          color: var(--text-primary);
        }

        /* Score display */
        .score-display {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 10px;
        }

        .score-value {
          font-weight: 500;
        }

        .percentage {
          color: var(--text-muted);
          font-size: 13px;
        }

        .letter-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 32px;
          height: 26px;
          padding: 0 10px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 700;
        }

        /* Table cells */
        .date-cell {
          color: var(--text-muted);
          font-size: 13px;
          white-space: nowrap;
        }

        .weight-cell {
          text-align: center;
          color: var(--text-secondary);
          font-weight: 500;
        }

        .score-cell {
          text-align: right;
        }

        /* Footer */
        .footer {
          text-align: center;
          padding: 16px 24px;
          background: var(--bg-secondary);
          border-top: 1px solid var(--border-color);
          font-size: 12px;
          color: var(--text-muted);
        }

        /* No assessments message */
        .no-assessments {
          text-align: center;
          padding: 60px 40px;
          color: var(--text-muted);
          font-style: italic;
        }

        /* Print optimization */
        @media print {
          body {
            padding: 0;
            background: white;
          }

          .container {
            box-shadow: none;
          }

          .main-layout {
            min-height: auto;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header -->
        <div class="header">
          <div class="header-left">
            <div class="school-name">${schoolName}</div>
            <div class="school-details">
              ${address}<br>
              ${phone} | ${email}
            </div>
          </div>
          <div class="report-title">Student Summary Report</div>
        </div>

        <!-- Main Two-Column Layout -->
        <div class="main-layout">
          <!-- Left Sidebar -->
          <div class="sidebar">
            <!-- Student Info Card -->
            <div class="card">
              <div class="card-title">Student Information</div>
              <div class="info-list">
                <div class="info-item">
                  <span class="info-label">Student Name</span>
                  <span class="info-value">${studentName}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Grade Level</span>
                  <span class="info-value">Grade ${grade}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Subject</span>
                  <span class="info-value">${subject}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Teacher</span>
                  <span class="info-value">${teacherName}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Term</span>
                  <span class="info-value">${termName}</span>
                </div>
              </div>
            </div>

            <!-- Grade Display Card -->
            <div class="card">
              <div class="card-title">Current Grade</div>
              <div class="grade-display">
                <div class="grade-percentage">${calculatedGrade.toFixed(1)}%</div>
                <div class="grade-letter" style="background: ${overallLetterGrade.bg}; color: ${overallLetterGrade.color};">
                  ${overallLetterGrade.letter}
                </div>
                <div class="grade-label">Overall Standing</div>
              </div>
            </div>

            <!-- Attendance Card -->
            <div class="card">
              <div class="card-title">Attendance</div>
              <div class="attendance-display">
                <div class="attendance-value ${daysOfAbsence === 0 ? 'good' : daysOfAbsence > 5 ? 'bad' : 'warning'}">${daysOfAbsence}</div>
                <div class="attendance-label">
                  ${daysOfAbsence === 0 ? 'Perfect Attendance' : daysOfAbsence === 1 ? 'Day Absent' : 'Days Absent'}
                </div>
              </div>
            </div>
          </div>

          <!-- Right Main Content -->
          <div class="main-content">
            <!-- Weight Breakdown -->
            ${weightBreakdown ? `
              <div class="weight-breakdown">
                <div class="weight-breakdown-title">Grade Weight Distribution</div>
                <div class="weight-items">
                  ${weightBreakdown}
                </div>
              </div>
            ` : ''}

            <!-- Assessment Details -->
            <div class="card assessment-table-wrapper">
              <div class="card-title">Assessment Details</div>
              ${assessments.length > 0 ? `
                <table class="assessment-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Assessment</th>
                      <th>Weight</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${assessmentRows}
                  </tbody>
                </table>
              ` : `
                <div class="no-assessments">
                  No assessments found for this class and term.
                </div>
              `}
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="footer">
          Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = { getStudentSummaryHTMLHorizontal };
