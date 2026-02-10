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
 * Format assessment date to "February 7, 2026" format
 * Falls back to created_at if date is not available
 */
function formatAssessmentDate(date, createdAt) {
  const d = date || createdAt;
  if (!d) return 'No date';
  return new Date(d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function getStudentSummaryHTML({
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
            <span>${scoreDisplay}</span>
            ${percentage !== null ? `<span class="percentage">(${percentage.toFixed(1)}%)</span>` : ''}
            ${letterGradeHtml}
          </div>
        </td>
      </tr>
    `;
  });

  // Then, render parent assessments with their children
  parentAssessments.forEach(parent => {
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
          <div class="parent-name">${parent.name}</div>
          <div class="child-count">${childAssessments.length} assessment${childAssessments.length !== 1 ? 's' : ''}</div>
        </td>
        <td class="weight-cell">${parseFloat(parent.weight_points) || 0}%</td>
        <td class="score-cell">
          <div class="score-display">
            <span>${parentScoreDisplay}</span>
            ${parentLetterHtml}
          </div>
        </td>
      </tr>
    `;

    // Child rows
    childAssessments.forEach(child => {
      const childScore = studentAssessments.find(sa => sa.assessment_id === child.assessment_id);
      let scoreDisplay = 'Not Submitted';
      let percentage = null;
      let letterGradeHtml = '';

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
        <tr class="child-assessment">
          <td class="date-cell">${formatAssessmentDate(child.date, child.created_at)}</td>
          <td class="name-cell">
            <div class="child-name">${child.name}</div>
          </td>
          <td class="weight-cell">${parseFloat(child.weight_points) || 0}%</td>
          <td class="score-cell">
            <div class="score-display">
              <span>${scoreDisplay}</span>
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
        :root {
          --primary: #3b82f6;
          --primary-dark: #2563eb;
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
          padding: 24px;
        }

        .container {
          max-width: 800px;
          margin: 0 auto;
          background: var(--bg-primary);
          border-radius: 12px;
          box-shadow: var(--shadow-md);
          overflow: hidden;
        }

        /* Header */
        .header {
          background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
          color: white;
          padding: 32px;
          text-align: center;
        }

        .school-name {
          font-size: 28px;
          font-weight: 700;
          margin-bottom: 8px;
          letter-spacing: -0.5px;
        }

        .school-details {
          font-size: 14px;
          opacity: 0.9;
          line-height: 1.6;
        }

        .report-title {
          margin-top: 24px;
          padding-top: 24px;
          border-top: 1px solid rgba(255, 255, 255, 0.2);
          font-size: 20px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        /* Content */
        .content {
          padding: 32px;
        }

        /* Cards */
        .card {
          background: var(--bg-primary);
          border: 1px solid var(--border-color);
          border-radius: var(--radius);
          padding: 20px;
          margin-bottom: 24px;
          box-shadow: var(--shadow-sm);
        }

        .card-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 2px solid var(--primary);
        }

        /* Student Info Grid */
        .info-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 16px;
        }

        .info-item {
          display: flex;
          flex-direction: column;
        }

        .info-label {
          font-size: 12px;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
        }

        .info-value {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
        }

        /* Stats Row */
        .stats-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          margin-bottom: 24px;
        }

        .stat-card {
          background: var(--bg-secondary);
          border-radius: var(--radius);
          padding: 20px;
          text-align: center;
          border: 1px solid var(--border-color);
        }

        .stat-card.primary {
          background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
          color: white;
          border: none;
        }

        .stat-label {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          opacity: 0.8;
          margin-bottom: 8px;
        }

        .stat-value {
          font-size: 32px;
          font-weight: 700;
          line-height: 1;
        }

        .stat-card.primary .stat-value {
          font-size: 36px;
        }

        .stat-subtext {
          font-size: 12px;
          margin-top: 4px;
          opacity: 0.7;
        }

        .grade-badge {
          display: inline-block;
          padding: 4px 12px;
          border-radius: 20px;
          font-size: 14px;
          font-weight: 600;
          margin-top: 8px;
        }

        /* Weight Breakdown */
        .weight-breakdown {
          background: var(--bg-tertiary);
          border-radius: var(--radius);
          padding: 16px;
          margin-bottom: 24px;
          border-left: 4px solid var(--primary);
        }

        .weight-breakdown-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
          margin-bottom: 8px;
        }

        .weight-items {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
        }

        .weight-item {
          font-size: 14px;
          color: var(--text-primary);
        }

        /* Assessment Table */
        .assessment-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 14px;
        }

        .assessment-table thead th {
          background: var(--bg-tertiary);
          padding: 12px 16px;
          text-align: left;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: 0.5px;
          border-bottom: 2px solid var(--border-color);
        }

        .assessment-table thead th:last-child {
          text-align: right;
        }

        .assessment-table tbody td {
          padding: 12px 16px;
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

        /* Parent assessment rows */
        .parent-assessment td {
          background: #eff6ff;
          border-left: 4px solid var(--primary);
        }

        .parent-name {
          font-weight: 600;
          color: var(--primary-dark);
        }

        .child-count {
          font-size: 12px;
          color: var(--text-muted);
          margin-top: 2px;
        }

        /* Child assessment rows */
        .child-assessment td {
          background: var(--bg-primary);
          padding-left: 40px;
        }

        .child-assessment td:first-child {
          padding-left: 40px;
        }

        .child-name {
          color: var(--text-primary);
          position: relative;
        }

        .child-name::before {
          content: '';
          position: absolute;
          left: -20px;
          top: 50%;
          width: 12px;
          height: 1px;
          background: var(--border-color);
        }

        /* Score display */
        .score-display {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 8px;
        }

        .percentage {
          color: var(--text-muted);
          font-size: 13px;
        }

        .letter-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 28px;
          height: 24px;
          padding: 0 8px;
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
          padding: 24px;
          background: var(--bg-secondary);
          border-top: 1px solid var(--border-color);
          font-size: 12px;
          color: var(--text-muted);
        }

        /* No assessments message */
        .no-assessments {
          text-align: center;
          padding: 40px;
          color: var(--text-muted);
          font-style: italic;
        }

        /* Attendance highlight */
        .attendance-highlight {
          color: var(--danger);
          font-weight: 600;
        }

        .attendance-good {
          color: var(--success);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- Header -->
        <div class="header">
          <div class="school-name">${schoolName}</div>
          <div class="school-details">
            ${address}<br>
            ${phone} | ${email}
          </div>
          <div class="report-title">Student Summary Report</div>
        </div>

        <div class="content">
          <!-- Student Info Card -->
          <div class="card">
            <div class="card-title">Student Information</div>
            <div class="info-grid">
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
              <div class="info-item">
                <span class="info-label">Report Date</span>
                <span class="info-value">${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
              </div>
            </div>
          </div>

          <!-- Stats Row -->
          <div class="stats-row">
            <div class="stat-card primary">
              <div class="stat-label">Current Grade</div>
              <div class="stat-value">${calculatedGrade.toFixed(1)}%</div>
              <div class="grade-badge" style="background: ${overallLetterGrade.bg}; color: ${overallLetterGrade.color};">
                ${overallLetterGrade.letter}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Letter Grade</div>
              <div class="stat-value" style="color: ${overallLetterGrade.color};">${overallLetterGrade.letter}</div>
              <div class="stat-subtext">Overall Standing</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Days Absent</div>
              <div class="stat-value ${daysOfAbsence === 0 ? 'attendance-good' : daysOfAbsence > 5 ? 'attendance-highlight' : ''}">${daysOfAbsence}</div>
              <div class="stat-subtext">${daysOfAbsence === 0 ? 'Perfect Attendance' : daysOfAbsence === 1 ? 'Day Missed' : 'Days Missed'}</div>
            </div>
          </div>

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
          <div class="card">
            <div class="card-title">Assessment Details</div>
            ${assessments.length > 0 ? `
              <table class="assessment-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Assessment</th>
                    <th style="text-align: center;">Weight</th>
                    <th style="text-align: right;">Score</th>
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

        <!-- Footer -->
        <div class="footer">
          Generated on ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = { getStudentSummaryHTML };
