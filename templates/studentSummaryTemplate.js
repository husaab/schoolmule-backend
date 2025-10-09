function getStudentSummaryHTML({ 
  schoolInfo, 
  student, 
  classInfo, 
  term, 
  assessments, 
  studentAssessments, 
  calculatedGrade 
}) {
  const { name: schoolName, address, phone, email } = schoolInfo;
  const { name: studentName, grade } = student;
  const { subject, teacher_name: teacherName } = classInfo;
  const { name: termName } = term;

  // Create assessment breakdown for display - only show parent assessments
  const parentAssessments = assessments.filter(a => a.parent_assessment_id === null);
  
  const assessmentBreakdown = parentAssessments.map(assessment => {
    let scoreDisplay = 'Not Submitted';
    
    if (assessment.is_parent) {
      // Parent assessment - calculate from children
      const childAssessments = assessments.filter(a => a.parent_assessment_id === assessment.assessment_id);
      
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
          const percentage = (childTotalScore / childTotalPossible) * 100;
          scoreDisplay = `${percentage.toFixed(1)}%`;
        }
      }
    } else {
      // Regular assessment
      const studentScore = studentAssessments.find(sa => sa.assessment_id === assessment.assessment_id);
      if (studentScore && studentScore.score !== null) {
        scoreDisplay = assessment.max_score ? 
          `${studentScore.score}/${assessment.max_score} (${((studentScore.score/assessment.max_score)*100).toFixed(1)}%)` : 
          `${studentScore.score}%`;
      }
    }

    return `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${assessment.date ? new Date(assessment.date).toLocaleDateString() : 'TBD'}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${assessment.name}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${parseFloat(assessment.weight_points) || 0}%</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${scoreDisplay}</td>
      </tr>
    `;
  }).join('');

  // Create weight breakdown display - only parent assessments
  const weightBreakdown = parentAssessments.reduce((acc, assessment) => {
    const weight = parseFloat(assessment.weight_points) || 0;
    const name = assessment.name;
    if (weight > 0) {
      acc.push(`${weight}% ${name}`);
    }
    return acc;
  }, []).join(', ');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <title>Student Summary Report - ${studentName}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          padding: 20px;
          margin: 0;
          line-height: 1.4;
        }
        .container {
          max-width: 800px;
          margin: auto;
          border: 1px solid #ccc;
          padding: 30px;
          border-radius: 8px;
        }
        .header {
          text-align: center;
          border-bottom: 2px solid #048dca;
          padding-bottom: 20px;
          margin-bottom: 30px;
        }
        .school-info {
          margin-bottom: 15px;
        }
        .school-name {
          font-size: 24px;
          font-weight: bold;
          color: #048dca;
          margin-bottom: 5px;
        }
        .school-details {
          font-size: 14px;
          color: #666;
        }
        .report-title {
          font-size: 28px;
          font-weight: bold;
          color: #333;
          margin: 20px 0 10px 0;
        }
        .student-info {
          background-color: #f8f9fa;
          padding: 20px;
          border-radius: 6px;
          margin: 20px 0;
        }
        .info-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 10px;
        }
        .info-label {
          font-weight: bold;
          color: #333;
        }
        .section-title {
          font-size: 18px;
          font-weight: bold;
          color: #048dca;
          margin: 25px 0 15px 0;
          border-bottom: 1px solid #ddd;
          padding-bottom: 5px;
        }
        .calculated-grade {
          background-color: #e3f2fd;
          padding: 15px;
          border-radius: 6px;
          text-align: center;
          margin: 20px 0;
        }
        .grade-display {
          font-size: 36px;
          font-weight: bold;
          color: #1976d2;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin: 15px 0;
        }
        th {
          background-color: #048dca;
          color: white;
          padding: 12px 8px;
          text-align: left;
          font-weight: bold;
        }
        td {
          padding: 8px;
          border: 1px solid #ddd;
        }
        tr:nth-child(even) {
          background-color: #f9f9f9;
        }
        .weight-breakdown {
          background-color: #fff3cd;
          padding: 15px;
          border-radius: 6px;
          margin: 15px 0;
          border-left: 4px solid #ffc107;
        }
        .footer {
          text-align: center;
          margin-top: 40px;
          padding-top: 20px;
          border-top: 1px solid #ddd;
          font-size: 12px;
          color: #666;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <!-- School Header -->
        <div class="header">
          <div class="school-info">
            <div class="school-name">${schoolName}</div>
            <div class="school-details">
              ${address}<br>
              Phone: ${phone} | Email: ${email}
            </div>
          </div>
          <div class="report-title">Student Summary Report</div>
        </div>

        <!-- Student Information -->
        <div class="student-info">
          <div class="info-row">
            <span><span class="info-label">Student Name:</span> ${studentName}</span>
            <span><span class="info-label">Grade:</span> ${grade}</span>
          </div>
          <div class="info-row">
            <span><span class="info-label">Subject:</span> ${subject}</span>
            <span><span class="info-label">Teacher:</span> ${teacherName}</span>
          </div>
          <div class="info-row">
            <span><span class="info-label">Term:</span> ${termName}</span>
            <span><span class="info-label">Report Date:</span> ${new Date().toLocaleDateString()}</span>
          </div>
        </div>

        <!-- Assessment Breakdown -->
        <div class="section-title">Assessment Weight Distribution</div>
        <div class="weight-breakdown">
          <strong>Grade Calculation:</strong> ${weightBreakdown || 'No weighted assessments found'}
        </div>

        <!-- Calculated Grade -->
        <div class="calculated-grade">
          <div style="font-size: 16px; margin-bottom: 10px;">Current Grade</div>
          <div class="grade-display">${calculatedGrade.toFixed(1)}%</div>
        </div>

        <!-- Assessment Details -->
        <div class="section-title">Assessment Details</div>
        ${assessments.length > 0 ? `
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Assessment Name</th>
                <th>Weight</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              ${assessmentBreakdown}
            </tbody>
          </table>
        ` : `
          <p style="text-align: center; color: #666; font-style: italic; padding: 20px;">
            No assessments found for this class and term.
          </p>
        `}

        <div class="footer">
          Generated by on ${new Date().toLocaleString()}
        </div>
      </div>
    </body>
    </html>
  `;
}

module.exports = { getStudentSummaryHTML };