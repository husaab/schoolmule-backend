/**
 * Progress Report HTML Template
 * Generates HTML content for student progress reports
 */

const getProgressReportHTML = (data) => {
  const { schoolInfo, student, term, progressData, generatedDate } = data;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Progress Report - ${student.name}</title>
    <style>
        body {
            font-family: 'Times New Roman', serif;
            margin: 0;
            padding: 20px;
            color: #333;
            line-height: 1.4;
        }
        
        .header {
            text-align: center;
            border-bottom: 3px solid #2c5aa0;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        
        .school-name {
            font-size: 24px;
            font-weight: bold;
            color: #2c5aa0;
            margin-bottom: 5px;
        }
        
        .school-details {
            font-size: 12px;
            color: #666;
            margin-bottom: 15px;
        }
        
        .report-title {
            font-size: 20px;
            font-weight: bold;
            color: #2c5aa0;
            margin: 10px 0;
        }
        
        .student-info {
            background-color: #f8f9fa;
            border: 1px solid #ddd;
            border-radius: 5px;
            padding: 15px;
            margin-bottom: 25px;
        }
        
        .student-info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }
        
        .info-item {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        
        .info-label {
            font-weight: bold;
            color: #2c5aa0;
        }
        
        .progress-section {
            margin-bottom: 30px;
        }
        
        .section-title {
            font-size: 16px;
            font-weight: bold;
            color: #2c5aa0;
            border-bottom: 2px solid #2c5aa0;
            padding-bottom: 5px;
            margin-bottom: 15px;
        }
        
        .subject-card {
            border: 1px solid #ddd;
            border-radius: 5px;
            margin-bottom: 20px;
            overflow: hidden;
        }
        
        .subject-header {
            background-color: #2c5aa0;
            color: white;
            padding: 10px 15px;
            font-weight: bold;
            font-size: 14px;
        }
        
        .subject-content {
            padding: 15px;
        }
        
        .assessment-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 15px;
            margin-bottom: 15px;
        }
        
        .assessment-item {
            text-align: center;
        }
        
        .assessment-label {
            font-weight: bold;
            font-size: 12px;
            color: #666;
            margin-bottom: 5px;
        }
        
        .assessment-value {
            font-size: 18px;
            font-weight: bold;
            padding: 5px 10px;
            border-radius: 3px;
            min-height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .rating-E { background-color: #d4edda; color: #155724; }
        .rating-G { background-color: #cce7ff; color: #0066cc; }
        .rating-S { background-color: #fff3cd; color: #856404; }
        .rating-N { background-color: #f8d7da; color: #721c24; }
        .rating-empty { background-color: #f8f9fa; color: #6c757d; }
        
        .standards-section {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #eee;
        }
        
        .standards-label {
            font-weight: bold;
            color: #2c5aa0;
            margin-bottom: 8px;
        }
        
        .standards-value {
            padding: 8px 12px;
            background-color: #f8f9fa;
            border-radius: 3px;
            border-left: 4px solid #2c5aa0;
            margin-bottom: 10px;
        }
        
        .comment-section {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #eee;
        }
        
        .comment-label {
            font-weight: bold;
            color: #2c5aa0;
            margin-bottom: 8px;
        }
        
        .comment-text {
            padding: 10px;
            background-color: #f8f9fa;
            border-radius: 3px;
            border-left: 4px solid #2c5aa0;
            font-style: italic;
            min-height: 40px;
        }
        
        .legend {
            background-color: #f8f9fa;
            border: 1px solid #ddd;
            border-radius: 5px;
            padding: 15px;
            margin-top: 30px;
        }
        
        .legend-title {
            font-weight: bold;
            color: #2c5aa0;
            margin-bottom: 10px;
        }
        
        .legend-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        
        .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 3px;
            font-weight: bold;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
        }
        
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #ddd;
            text-align: center;
            font-size: 12px;
            color: #666;
        }
        
        .no-data {
            color: #6c757d;
            font-style: italic;
        }
        
        @media print {
            body { margin: 0; }
            .header { page-break-after: avoid; }
            .subject-card { page-break-inside: avoid; }
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="school-name">${schoolInfo.name}</div>
        ${schoolInfo.address ? `<div class="school-details">${schoolInfo.address}</div>` : ''}
        ${schoolInfo.phone || schoolInfo.email ? `<div class="school-details">
            ${schoolInfo.phone ? `Phone: ${schoolInfo.phone}` : ''}
            ${schoolInfo.phone && schoolInfo.email ? ' | ' : ''}
            ${schoolInfo.email ? `Email: ${schoolInfo.email}` : ''}
        </div>` : ''}
        <div class="report-title">STUDENT PROGRESS REPORT</div>
    </div>
    
    <div class="student-info">
        <div class="student-info-grid">
            <div>
                <div class="info-item">
                    <span class="info-label">Student Name:</span>
                    <span>${student.name}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Grade:</span>
                    <span>${student.grade}</span>
                </div>
            </div>
            <div>
                <div class="info-item">
                    <span class="info-label">Term:</span>
                    <span>${term}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Homeroom Teacher:</span>
                    <span>${student.homeroomTeacher}</span>
                </div>
                ${student.oen ? `
                <div class="info-item">
                    <span class="info-label">OEN:</span>
                    <span>${student.oen}</span>
                </div>
                ` : ''}
            </div>
        </div>
    </div>
    
    <div class="progress-section">
        <div class="section-title">Progress by Subject</div>
        
        ${progressData.map(subject => `
            <div class="subject-card">
                <div class="subject-header">
                    ${subject.subject}
                    ${subject.teacherName ? ` - ${subject.teacherName}` : ''}
                </div>
                <div class="subject-content">
                    <div class="assessment-grid">
                        <div class="assessment-item">
                            <div class="assessment-label">Work Habits</div>
                            <div class="assessment-value ${subject.workHabit ? `rating-${subject.workHabit}` : 'rating-empty'}">
                                ${subject.workHabit || 'Not Assessed'}
                            </div>
                        </div>
                        <div class="assessment-item">
                            <div class="assessment-label">Behavior</div>
                            <div class="assessment-value ${subject.behavior ? `rating-${subject.behavior}` : 'rating-empty'}">
                                ${subject.behavior || 'Not Assessed'}
                            </div>
                        </div>
                        <div class="assessment-item">
                            <div class="assessment-label">Overall</div>
                            <div class="assessment-value ${getOverallRating(subject.workHabit, subject.behavior)}">
                                ${calculateOverallRating(subject.workHabit, subject.behavior)}
                            </div>
                        </div>
                    </div>
                    
                    ${subject.coreStandards ? `
                    <div class="standards-section">
                        <div class="standards-label">Core Standards Progress:</div>
                        <div class="standards-value">${subject.coreStandards}</div>
                    </div>
                    ` : ''}
                    
                    ${subject.comment ? `
                    <div class="comment-section">
                        <div class="comment-label">Teacher Comments:</div>
                        <div class="comment-text">${subject.comment}</div>
                    </div>
                    ` : ''}
                </div>
            </div>
        `).join('')}
    </div>
    
    <div class="legend">
        <div class="legend-title">Assessment Scale</div>
        <div class="legend-grid">
            <div class="legend-item">
                <div class="legend-color rating-E">E</div>
                <span>Excellent</span>
            </div>
            <div class="legend-item">
                <div class="legend-color rating-G">G</div>
                <span>Good</span>
            </div>
            <div class="legend-item">
                <div class="legend-color rating-S">S</div>
                <span>Satisfactory</span>
            </div>
            <div class="legend-item">
                <div class="legend-color rating-N">N</div>
                <span>Needs Improvement</span>
            </div>
        </div>
    </div>
    
    <div class="footer">
        <div>Generated on ${generatedDate}</div>
        <div style="margin-top: 5px;">This progress report provides an overview of the student's current academic and behavioral progress.</div>
    </div>
</body>
</html>
  `;
};

// Helper function to calculate overall rating
function calculateOverallRating(workHabit, behavior) {
  if (!workHabit && !behavior) return 'Not Assessed';
  if (!workHabit) return behavior;
  if (!behavior) return workHabit;
  
  const ratings = { 'E': 4, 'G': 3, 'S': 2, 'N': 1 };
  const average = (ratings[workHabit] + ratings[behavior]) / 2;
  
  if (average >= 3.5) return 'E';
  if (average >= 2.5) return 'G';
  if (average >= 1.5) return 'S';
  return 'N';
}

// Helper function to get CSS class for overall rating
function getOverallRating(workHabit, behavior) {
  const overall = calculateOverallRating(workHabit, behavior);
  if (overall === 'Not Assessed') return 'rating-empty';
  return `rating-${overall}`;
}

module.exports = {
  getProgressReportHTML
};