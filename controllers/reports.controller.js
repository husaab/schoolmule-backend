const db = require("../config/database");
const reportsQueries = require("../queries/reports.queries");
const logger = require("../logger");
const { createPDFBuffer } = require("../utils/pdfGenerator");
const { getStudentSummaryHTML } = require("../templates/studentSummaryTemplate");

// Helper function to calculate weighted grade with parent/child assessment support
const calculateWeightedGrade = (assessments, studentScores) => {
  let totalWeightedScore = 0;
  let totalWeight = 0;

  // Group assessments by parent
  const parentAssessments = assessments.filter(a => a.parent_assessment_id === null);
  
  parentAssessments.forEach(parentAssessment => {
    // Get weight from weight_points only (weight_points = weight percentage)
    const weight = parseFloat(parentAssessment.weight_points) || 0;
    
    if (weight === 0) return; // Skip assessments with no weight
    
    let assessmentScore = null;
    
    if (parentAssessment.is_parent) {
      // This is a parent assessment - calculate score from children
      const childAssessments = assessments.filter(a => a.parent_assessment_id === parentAssessment.assessment_id);
      
      if (childAssessments.length > 0) {
        let childTotalScore = 0;
        let childTotalPossible = 0;
        let hasScores = false;
        
        childAssessments.forEach(child => {
          const childScore = studentScores.find(score => score.assessment_id === child.assessment_id);
          if (childScore && childScore.score !== null) {
            const childWeight = parseFloat(child.weight_points) || 1;
            const maxScore = parseFloat(child.max_score) || 100;
            childTotalScore += (parseFloat(childScore.score) * childWeight);
            childTotalPossible += (maxScore * childWeight);
            hasScores = true;
          }
        });
        
        if (hasScores && childTotalPossible > 0) {
          assessmentScore = (childTotalScore / childTotalPossible) * 100;
        }
      }
    } else {
      // This is a regular assessment
      const studentScore = studentScores.find(score => score.assessment_id === parentAssessment.assessment_id);
      
      if (studentScore && studentScore.score !== null) {
        const score = parseFloat(studentScore.score);
        const maxScore = parseFloat(parentAssessment.max_score);
        
        if (maxScore && maxScore > 0) {
          // Points-based assessment
          assessmentScore = (score / maxScore) * 100;
        } else {
          // Percentage-based assessment
          assessmentScore = score;
        }
      }
    }
    
    // Add to total if we have a score
    if (assessmentScore !== null && !isNaN(assessmentScore)) {
      totalWeightedScore += (assessmentScore * weight) / 100;
      totalWeight += weight;
    }
  });

  // If no weighted assessments, return 0
  if (totalWeight === 0) return 0;

  // Return weighted average
  return (totalWeightedScore / totalWeight) * 100;
};

const generateStudentSummaryReport = async (req, res) => {
  try {
    const { studentId, classId } = req.params;

    // Validate required parameters
    if (!studentId || !classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and Class ID are required'
      });
    }

    logger.info(`Generating student summary report for student ${studentId} in class ${classId}`);

    // 1. Get student information
    logger.info(`Fetching student with ID: ${studentId}`);
    const studentResult = await db.query(reportsQueries.getStudentById, [studentId]);
    if (studentResult.rows.length === 0) {
      logger.error(`Student not found: ${studentId}`);
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }
    const student = studentResult.rows[0];
    logger.info(`Student found: ${student.name}`);

    // 2. Get class information
    logger.info(`Fetching class with ID: ${classId}`);
    const classResult = await db.query(reportsQueries.getClassInfo, [classId]);
    if (classResult.rows.length === 0) {
      logger.error(`Class not found: ${classId}`);
      return res.status(404).json({
        status: 'error',
        message: 'Class not found'
      });
    }
    const classInfo = classResult.rows[0];
    logger.info(`Class found: ${classInfo.subject} - Teacher: ${classInfo.teacher_name}`);

    // 3. Verify student is enrolled in the class
    logger.info(`Verifying student enrollment in class`);
    const enrollmentResult = await db.query(reportsQueries.verifyStudentEnrollment, [studentId, classId]);
    if (enrollmentResult.rows.length === 0) {
      logger.error(`Student ${student.name} is not enrolled in class ${classInfo.subject}`);
      return res.status(400).json({
        status: 'error',
        message: 'Student is not enrolled in this class'
      });
    }
    logger.info(`Student enrollment verified`);

    // 4. Get school information
    logger.info(`Fetching school information for school: ${student.school}`);
    const schoolResult = await db.query(reportsQueries.getSchoolInfoByCode, [student.school]);
    if (schoolResult.rows.length === 0) {
      logger.error(`School information not found for school: ${student.school}`);
      return res.status(404).json({
        status: 'error',
        message: 'School information not found'
      });
    }
    const schoolInfo = schoolResult.rows[0];
    logger.info(`School information found: ${schoolInfo.name}`);

    // 5. Get term information
    const termResult = await db.query(reportsQueries.getTermById, [classInfo.term_id]);
    if (termResult.rows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Term information not found'
      });
    }
    const term = termResult.rows[0];

    // 6. Get assessments for the class
    const assessmentsResult = await db.query(reportsQueries.getAssessmentsByClass, [classId]);
    const assessments = assessmentsResult.rows;

    // 7. Get student's scores for these assessments
    const scoresResult = await db.query(reportsQueries.getStudentAssessmentScores, [studentId, classId]);
    const studentScores = scoresResult.rows;

    // 8. Calculate weighted grade
    const calculatedGrade = calculateWeightedGrade(assessments, studentScores);

    // 9. Generate PDF HTML
    const htmlContent = getStudentSummaryHTML({
      schoolInfo,
      student,
      classInfo,
      term,
      assessments,
      studentAssessments: studentScores,
      calculatedGrade
    });

    // 10. Generate PDF buffer
    const pdfBuffer = await createPDFBuffer(htmlContent);

    // 11. Set response headers for PDF download
    const filename = `${student.name.replace(/\s+/g, '_')}_${classInfo.subject}_${term.name}_Summary.pdf`;
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // 12. Send PDF buffer
    res.send(pdfBuffer);

    logger.info(`Student summary report generated successfully for student ${studentId} in class ${classId}`);

  } catch (error) {
    logger.error('Error generating student summary report:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate student summary report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  generateStudentSummaryReport
};