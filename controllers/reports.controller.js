const db = require("../config/database");
const reportsQueries = require("../queries/reports.queries");
const logger = require("../logger");
const { createPDFBuffer } = require("../utils/pdfGenerator");
const { getStudentSummaryHTML } = require("../templates/studentSummaryTemplate");
const { calculateStudentGrade } = require("../utils/gradeCalculator");

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

    // 8. Calculate weighted grade using shared utility
    // Note: calculateStudentGrade expects studentScores with is_excluded flag (added to query)
    const calculatedGrade = calculateStudentGrade(assessments, studentScores);

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