const db = require("../config/database");
const progressReportsQueries = require("../queries/progressReports.queries");
const studentQueries = require("../queries/student.queries");
const logger = require("../logger");
const { createPDFBuffer } = require('../utils/pdfGenerator');
const supabase = require('../config/supabaseClient');
const { getProgressReportHTML } = require('../templates/progressReportTemplate');

const toCamel = row => ({
  id: row.id,
  studentId: row.student_id,
  classId: row.class_id,
  coreStandards: row.core_standards,
  workHabit: row.work_habit,
  behavior: row.behavior,
  comment: row.comment,
  createdAt: row.created_at,
  // Additional fields for joined queries
  subject: row.subject,
  classGrade: row.class_grade,
  teacherName: row.teacher_name,
  studentName: row.student_name,
  studentGrade: row.student_grade
});

// Get progress report feedback for a student in a specific class
const getProgressReportFeedback = async (req, res) => {
  try {
    const { studentId, classId } = req.params;

    if (!studentId || !classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and Class ID are required'
      });
    }

    const result = await db.query(progressReportsQueries.getProgressReportFeedback, [studentId, classId]);
    
    res.json({
      status: 'success',
      data: result.rows[0] ? toCamel(result.rows[0]) : null
    });
  } catch (error) {
    logger.error('Error fetching progress report feedback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch progress report feedback',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create or update progress report feedback for a student in a class
const upsertProgressReportFeedback = async (req, res) => {
  try {
    const { studentId, classId } = req.params;
    const { coreStandards, workHabit, behavior, comment } = req.body;

    if (!studentId || !classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and Class ID are required'
      });
    }

    // Check if feedback already exists
    const existingResult = await db.query(progressReportsQueries.getProgressReportFeedback, [studentId, classId]);
    
    let result;
    if (existingResult.rows.length > 0) {
      // Update existing feedback
      result = await db.query(progressReportsQueries.updateProgressReportFeedback, [
        coreStandards || null,
        workHabit || null,
        behavior || null,
        comment || null,
        studentId,
        classId
      ]);
    } else {
      // Create new feedback
      result = await db.query(progressReportsQueries.createProgressReportFeedback, [
        studentId,
        classId,
        coreStandards || null,
        workHabit || null,
        behavior || null,
        comment || null
      ]);
    }

    res.json({
      status: 'success',
      message: 'Progress report feedback saved successfully',
      data: toCamel(result.rows[0])
    });
  } catch (error) {
    logger.error('Error saving progress report feedback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to save progress report feedback',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all progress report feedback for a student across all classes
const getStudentProgressReportFeedback = async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID is required'
      });
    }

    const result = await db.query(progressReportsQueries.getStudentProgressReportFeedback, [studentId]);
    
    res.json({
      status: 'success',
      data: result.rows.map(toCamel)
    });
  } catch (error) {
    logger.error('Error fetching student progress report feedback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch student progress report feedback',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all progress report feedback for a class
const getClassProgressReportFeedback = async (req, res) => {
  try {
    const { classId } = req.params;

    if (!classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Class ID is required'
      });
    }

    const result = await db.query(progressReportsQueries.getClassProgressReportFeedback, [classId]);
    
    res.json({
      status: 'success',
      data: result.rows.map(toCamel)
    });
  } catch (error) {
    logger.error('Error fetching class progress report feedback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch class progress report feedback',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete progress report feedback
const deleteProgressReportFeedback = async (req, res) => {
  try {
    const { studentId, classId } = req.params;

    if (!studentId || !classId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and Class ID are required'
      });
    }

    const result = await db.query(progressReportsQueries.deleteProgressReportFeedback, [studentId, classId]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Progress report feedback not found'
      });
    }

    res.json({
      status: 'success',
      message: 'Progress report feedback deleted successfully'
    });
  } catch (error) {
    logger.error('Error deleting progress report feedback:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to delete progress report feedback',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create progress report record (for tracking generated reports)
const createProgressReport = async (req, res) => {
  try {
    const { studentId, term, studentName, grade, filePath, school } = req.body;

    if (!studentId || !term) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID and term are required'
      });
    }

    const result = await db.query(progressReportsQueries.createProgressReport, [
      studentId,
      term,
      studentName || null,
      grade || null,
      filePath || null,
      school || null
    ]);

    res.json({
      status: 'success',
      message: 'Progress report created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating progress report:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to create progress report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get progress reports for a student
const getStudentProgressReports = async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID is required'
      });
    }

    const result = await db.query(progressReportsQueries.getStudentProgressReports, [studentId]);
    
    res.json({
      status: 'success',
      data: result.rows
    });
  } catch (error) {
    logger.error('Error fetching student progress reports:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch student progress reports',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get progress reports by term and school
const getProgressReportsByTermAndSchool = async (req, res) => {
  try {
    const { term, school } = req.params;

    if (!term || !school) {
      return res.status(400).json({
        status: 'error',
        message: 'Term and school are required'
      });
    }

    const result = await db.query(progressReportsQueries.getProgressReportsByTermAndSchool, [term, school]);
    
    res.json({
      status: 'success',
      data: result.rows
    });
  } catch (error) {
    logger.error('Error fetching progress reports by term and school:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch progress reports',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Generate single progress report
const generateProgressReport = async (req, res) => {
  try {
    const { studentId, term } = req.body;

    if (!studentId || !term) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Missing studentId or term' 
      });
    }

    const result = await generateSingleProgressReport(studentId, term);
    
    res.json({
      status: 'success',
      message: 'Progress report generated and uploaded successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error generating progress report:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate progress report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Generate multiple progress reports in bulk
const generateProgressReportsBulk = async (req, res) => {
  try {
    const { studentIds, term } = req.body;

    if (!Array.isArray(studentIds) || !term) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid studentIds or term'
      });
    }

    const successes = [];
    const failures = [];

    for (const studentId of studentIds) {
      try {
        const result = await generateSingleProgressReport(studentId, term);
        successes.push({ studentId, message: 'Progress report generated successfully', data: result });
      } catch (error) {
        logger.error(`Failed to generate progress report for ${studentId}:`, error);
        failures.push({ studentId, error: error.message || 'Unknown error' });
      }
    }

    res.json({
      status: 'completed',
      term,
      generated: successes,
      failed: failures
    });
  } catch (error) {
    logger.error('Error in bulk progress report generation:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate progress reports',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Helper function to generate a single progress report
const generateSingleProgressReport = async (studentId, term) => {
  // 1. Get student information
  const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
  if (studentRows.length === 0) {
    throw new Error('Student not found');
  }
  const student = studentRows[0];

  // 2. Get homeroom teacher name
  const { rows: teacherRows } = await db.query(`
    SELECT username
    FROM users
    WHERE user_id = $1
  `, [student.homeroom_teacher_id]);
  const homeroomTeacher = teacherRows.length > 0 ? teacherRows[0].username : 'N/A';

  // 3. Get all classes the student is enrolled in
  const { rows: classRows } = await db.query(`
    SELECT c.class_id, c.subject, c.teacher_name, c.grade as class_grade
    FROM class_students cs
    JOIN classes c ON cs.class_id = c.class_id
    WHERE cs.student_id = $1
    ORDER BY c.subject
  `, [studentId]);

  if (classRows.length === 0) {
    throw new Error('Student not enrolled in any classes');
  }

  // 4. Get progress report feedback for each class
  const progressData = [];
  for (const classInfo of classRows) {
    const { rows: feedbackRows } = await db.query(
      progressReportsQueries.getProgressReportFeedback, 
      [studentId, classInfo.class_id]
    );

    const feedback = feedbackRows.length > 0 ? feedbackRows[0] : null;
    
    progressData.push({
      subject: classInfo.subject,
      teacherName: classInfo.teacher_name,
      classGrade: classInfo.class_grade,
      coreStandards: feedback ? feedback.core_standards : null,
      workHabit: feedback ? feedback.work_habit : null,
      behavior: feedback ? feedback.behavior : null,
      comment: feedback ? feedback.comment : null
    });
  }

  // 5. Get school information (if available)
  const { rows: schoolRows } = await db.query(`
    SELECT name, address, phone, email
    FROM schools
    WHERE school_code = $1
  `, [student.school]);
  
  const schoolInfo = schoolRows.length > 0 ? schoolRows[0] : {
    name: student.school || 'School Name',
    address: '',
    phone: '',
    email: ''
  };

  // 6. Generate HTML template
  const htmlContent = getProgressReportHTML({
    schoolInfo,
    student: {
      name: student.name,
      grade: student.grade,
      oen: student.oen,
      homeroomTeacher
    },
    term,
    progressData,
    generatedDate: new Date().toLocaleDateString()
  });

  // 7. Generate PDF buffer
  const pdfBuffer = await createPDFBuffer(htmlContent);

  // 8. Upload to Supabase storage
  const schoolFolder = student.school.replace(/\s+/g, '').toUpperCase();
  const fileName = `${schoolFolder}/${student.name.replace(/\s+/g, '_')}_${term.replace(/\s+/g, '_')}_progress_report.pdf`;

  const { error } = await supabase
    .storage
    .from('progress-reports')
    .upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (error) {
    logger.error('Supabase upload error:', error);
    throw new Error('Upload to storage failed');
  }

  // 9. Save record to database
  const { rows: recordRows } = await db.query(progressReportsQueries.createProgressReport, [
    studentId,
    term,
    student.name,
    student.grade,
    fileName,
    student.school
  ]);

  return {
    studentId,
    studentName: student.name,
    term,
    filePath: fileName,
    recordId: recordRows[0]
  };
};

// Delete progress report
const deleteProgressReport = async (req, res) => {
  try {
    const { filePath } = req.query;

    if (!filePath) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'filePath is required' 
      });
    }

    // Delete from Supabase Storage
    const { error } = await supabase.storage
      .from('progress-reports')
      .remove([filePath]);

    if (error) {
      logger.error('Supabase delete error:', error);
      return res.status(500).json({ 
        status: 'error', 
        message: 'Failed to delete file from storage' 
      });
    }

    // Remove from database table
    await db.query('DELETE FROM progress_reports WHERE file_path = $1', [filePath]);

    res.json({ 
      status: 'success', 
      message: 'Progress report deleted successfully' 
    });
  } catch (error) {
    logger.error('Delete progress report error:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to delete progress report' 
    });
  }
};

module.exports = {
  getProgressReportFeedback,
  upsertProgressReportFeedback,
  getStudentProgressReportFeedback,
  getClassProgressReportFeedback,
  deleteProgressReportFeedback,
  createProgressReport,
  getStudentProgressReports,
  getProgressReportsByTermAndSchool,
  generateProgressReport,
  generateProgressReportsBulk,
  deleteProgressReport
};