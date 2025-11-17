const { Resend } = require('resend');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const reportEmailsQueries = require('../queries/reportEmails.queries');
const progressReportsQueries = require('../queries/progressReports.queries');
const reportCardQueries = require('../queries/report_card.queries');
const studentQueries = require('../queries/student.queries');
const schoolQueries = require('../queries/school.queries');
const { getProgressReportEmailHTML, getReportCardEmailHTML } = require('../utils/emailTemplate');
const { getSchoolName } = require('../utils/schoolUtils');

// Helper function to clean and validate email arrays
const cleanEmailArray = (emails) => {
  if (!emails) return [];
  if (!Array.isArray(emails)) return [];
  
  return emails
    .map(email => typeof email === 'string' ? email.trim() : '')
    .filter(email => email.length > 0)
    .filter(email => email.includes('@')); // Basic email validation
};

// Helper function to convert snake_case to camelCase
const toCamelCase = (row) => ({
  id: row.id,
  reportType: row.report_type,
  studentId: row.student_id,
  term: row.term,
  sentBy: row.sent_by,
  emailAddresses: cleanEmailArray(Array.isArray(row.email_addresses) ? row.email_addresses : JSON.parse(row.email_addresses || '[]')),
  customHeader: row.custom_header,
  customMessage: row.custom_message,
  filePath: row.file_path,
  sentAt: row.sent_at,
  ccAddresses: cleanEmailArray(row.cc_addresses ? (Array.isArray(row.cc_addresses) ? row.cc_addresses : JSON.parse(row.cc_addresses)) : []),
  school: row.school,
  studentName: row.student_name, // From joined queries
  sentByUsername: row.sent_by_username // From joined queries
});

// Helper function to get school-specific API key
const getSchoolApiKey = (school) => {
  // Convert school name to env variable format (e.g., "Al Haadi Academy" -> "ALHAADI_RESEND_API_KEY")
  const schoolKey = school
    .replace(/\s+/g, '') // Remove spaces
    .replace(/[^A-Za-z0-9]/g, '') // Remove special characters
    .toUpperCase();
  
  logger.info("school key is" + schoolKey)
  
  const apiKeyVar = `${schoolKey}_RESEND_API_KEY`;
  const schoolApiKey = process.env[apiKeyVar];
  
  if (!schoolApiKey) {
    return process.env.RESEND_API_KEY
  }
  
  return schoolApiKey;
};

const getSchoolDomain = (school) => {

  switch (school) {
    case "ALHAADIACADEMY":
      logger.info("School Domain Found: alhaadiacademy.ca")
      return "alhaadiacademy.ca"
    default:
      logger.info("No domain found for school")
      return "schoolmule.ca"
  }

}

// Send progress report or report card email
const sendReportEmail = async (req, res) => {
  try {
    logger.info('Starting sendReportEmail function');
    
    const { 
      reportType, 
      studentId, 
      term, 
      emailAddresses: rawEmailAddresses, 
      ccAddresses: rawCcAddresses, 
      customHeader, 
      customMessage
    } = req.body;

    // Clean and validate email addresses
    const emailAddresses = cleanEmailArray(rawEmailAddresses);
    const ccAddresses = cleanEmailArray(rawCcAddresses);

    const userId = req.user?.user_id;
    
    logger.info(`Payload received: ${reportType}, student: ${studentId}, term: ${term}, emails: ${emailAddresses?.length}`);

    // Validation
    if (!reportType || !studentId || !term || !emailAddresses?.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: reportType, studentId, term, emailAddresses'
      });
    }

    if (!['progress_report', 'report_card'].includes(reportType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid report type. Must be "progress_report" or "report_card"'
      });
    }

    // Get student information
    logger.info(`Fetching student data for ID: ${studentId}`);
    const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
    if (studentRows.length === 0) {
      logger.error(`Student not found: ${studentId}`);
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }
    const student = studentRows[0];
    logger.info(`Student found: ${student.name}, School: ${student.school}`);

    // Get the report file path and verify it exists
    let reportQuery, reportTable, storageFolder;
    if (reportType === 'progress_report') {
      reportQuery = progressReportsQueries.getProgressReportByStudentAndTerm;
      storageFolder = 'progress-reports';
    } else {
      reportQuery = reportCardQueries.selectGeneratedReportCardsByStudentId;
      storageFolder = 'report-cards';
    }

    const { rows: reportRows } = await db.query(reportQuery, [studentId, term, student.school]);
    if (reportRows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: `No ${reportType.replace('_', ' ')} found for student ${student.name} in term ${term}`
      });
    }

    const report = reportRows[0];
    const filePath = report.file_path;

    // Get signed URL for the PDF attachment
    const { data: signedUrlData, error: urlError } = await supabase
      .storage
      .from(storageFolder)
      .createSignedUrl(filePath, 3600); // 1 hour expiry

    if (urlError || !signedUrlData?.signedUrl) {
      logger.error('Failed to get signed URL:', urlError);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to access report file'
      });
    }

    // Download the PDF file to attach to email
    const pdfResponse = await fetch(signedUrlData.signedUrl);
    if (!pdfResponse.ok) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to download report file'
      });
    }
    const pdfBuffer = await pdfResponse.arrayBuffer();

    // Fetch school contact information
    logger.info(`Fetching school info for: ${student.school}`);
    let schoolInfo = null;
    try {
      const { rows: schoolRows } = await db.query(schoolQueries.selectSchoolByCode, [student.school]);
      if (schoolRows.length > 0) {
        schoolInfo = schoolRows[0];
        logger.info(`School info found: ${schoolInfo.name}`);
      } else {
        logger.warn(`No school info found for: ${student.school}`);
      }
    } catch (schoolError) {
      logger.error('Error fetching school info:', schoolError);
      // Continue without school info - template will fall back to basic footer
    }

    // Generate email content
    const emailData = {
      studentName: student.name,
      term,
      customMessage,
      schoolName: getSchoolName(student.school),
      customHeader,
      schoolInfo
    };

    const htmlContent = reportType === 'progress_report' 
      ? getProgressReportEmailHTML(emailData)
      : getReportCardEmailHTML(emailData);

    const subject = customHeader || `${student.name} - ${reportType === 'progress_report' ? 'Progress Report' : 'Report Card'} (${term})`;

    // Get school-specific API key
    logger.info(`Getting API key for school: ${student.school}`);
    const schoolApiKey = getSchoolApiKey(student.school);
    logger.info('API key obtained successfully');
    
    const schoolDomain = getSchoolDomain(student.school);
    logger.info(`School domain: ${schoolDomain}`);
    
    const resend = new Resend(schoolApiKey);

    // Prepare email payload
    const emailPayload = {
      from: `reports@${schoolDomain}`,
      to: emailAddresses,
      subject,
      html: htmlContent,
      attachments: [
        {
          filename: `${student.name}_${term}_${reportType}.pdf`,
          content: Buffer.from(pdfBuffer)
        }
      ]
    };

    // Add CC addresses if provided
    if (ccAddresses?.length) {
      emailPayload.cc = ccAddresses;
    }

    // Send email
    logger.info('Sending email with payload:', {
      from: emailPayload.from,
      to: emailPayload.to,
      subject: emailPayload.subject,
      attachmentCount: emailPayload.attachments?.length || 0
    });
    
    const emailResult = await resend.emails.send(emailPayload);
    
    logger.info('Email send result:', emailResult);

    if (emailResult.error) {
      logger.error('Resend email error:', emailResult.error);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to send email',
        error: emailResult.error
      });
    }

    // Save email record to database
    const { rows: emailRecordRows } = await db.query(reportEmailsQueries.createReportEmail, [
      reportType,
      studentId,
      term,
      userId,
      JSON.stringify(emailAddresses),
      customHeader,
      customMessage,
      filePath,
      ccAddresses ? JSON.stringify(ccAddresses) : null,
      student.school
    ]);

    // Update the report table to mark as emailed
    const updateQuery = reportType === 'progress_report' 
      ? progressReportsQueries.updateProgressReportEmailStatus
      : reportCardQueries.updateReportCardEmailStatus;
    
    await db.query(updateQuery, [
      studentId,
      term,
      true, // email_sent
      new Date().toISOString(), // email_sent_at
      userId // email_sent_by
    ]);

    res.json({
      status: 'success',
      message: `${reportType === 'progress_report' ? 'Progress report' : 'Report card'} email sent successfully`,
      data: {
        id: emailRecordRows[0].id,
        sentAt: emailRecordRows[0].sent_at,
        emailId: emailResult.data?.id
      }
    });

  } catch (error) {
    logger.error(`Error sending report email: ${error.message}`);
    logger.error('Full error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to send report email',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send bulk report emails
const sendBulkReportEmails = async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { 
      reportType, 
      studentIds, 
      term, 
      bulkConfig // { customHeader, customMessage, ccAddresses }
    } = req.body;

    const userId = req.user?.user_id;

    // Validation
    if (!reportType || !studentIds?.length || !term) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: reportType, studentIds, term'
      });
    }

    if (!['progress_report', 'report_card'].includes(reportType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid report type. Must be "progress_report" or "report_card"'
      });
    }

    logger.info(`Starting bulk email for ${studentIds.length} students: ${reportType}, term: ${term}`);

    // Step 1: Batch fetch all student data
    logger.info('Fetching student data...');
    const studentQuery = `
      SELECT student_id, name, school, grade, mother_email, father_email
      FROM students 
      WHERE student_id = ANY($1)
    `;
    const { rows: students } = await db.query(studentQuery, [studentIds]);
    
    if (students.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No students found with provided IDs'
      });
    }

    // Get first student's school for shared resources
    const school = students[0].school;

    // Step 2: Fetch school info once (shared for all emails)
    logger.info(`Fetching school info for: ${school}`);
    let schoolInfo = null;
    try {
      const { rows: schoolRows } = await db.query(schoolQueries.selectSchoolByCode, [school]);
      if (schoolRows.length > 0) {
        schoolInfo = schoolRows[0];
        logger.info(`School info found: ${schoolInfo.name}`);
      }
    } catch (schoolError) {
      logger.warn('Error fetching school info, continuing without it:', schoolError);
    }

    // Step 3: Batch fetch all progress reports
    logger.info('Fetching progress reports...');
    let reportQuery, storageFolder;
    if (reportType === 'progress_report') {
      reportQuery = `
        SELECT student_id, term, file_path, student_name
        FROM progress_reports 
        WHERE student_id = ANY($1) AND term = $2 AND school = $3
      `;
      storageFolder = 'progress-reports';
    } else {
      reportQuery = `
        SELECT student_id, term, file_path, student_name
        FROM report_cards 
        WHERE student_id = ANY($1) AND term = $2
      `;
      storageFolder = 'report-cards';
    }

    const { rows: reports } = await db.query(reportQuery, [studentIds, term, school]);

    // Step 4: Get school-specific configuration
    const schoolApiKey = getSchoolApiKey(school);
    const schoolDomain = getSchoolDomain(school);
    const resend = new Resend(schoolApiKey);
    const schoolName = getSchoolName(school);

    // Step 5: Prepare email tasks
    const emailTasks = [];
    const results = [];

    for (const student of students) {
      const report = reports.find(r => r.student_id === student.student_id);
      
      if (!report) {
        results.push({
          studentId: student.student_id,
          studentName: student.name,
          status: 'failed',
          error: `No ${reportType.replace('_', ' ')} found for term ${term}`
        });
        continue;
      }

      // Get parent emails for this student
      const rawParentEmails = [];
      if (student.mother_email) rawParentEmails.push(student.mother_email);
      if (student.father_email) rawParentEmails.push(student.father_email);
      
      const parentEmails = cleanEmailArray(rawParentEmails);

      if (parentEmails.length === 0) {
        results.push({
          studentId: student.student_id,
          studentName: student.name,
          status: 'failed',
          error: 'No parent email addresses found'
        });
        continue;
      }

      // Create email task
      emailTasks.push({
        student,
        report,
        parentEmails,
        customHeader: bulkConfig?.customHeader,
        customMessage: bulkConfig?.customMessage,
        ccAddresses: cleanEmailArray(bulkConfig?.ccAddresses)
      });
    }

    logger.info(`Prepared ${emailTasks.length} email tasks`);

    // Step 6: Process emails sequentially to respect rate limits (2 req/sec max)
    logger.info(`Processing ${emailTasks.length} emails sequentially to respect rate limits`);

    for (const [taskIndex, task] of emailTasks.entries()) {
      logger.info(`Processing email ${taskIndex + 1}/${emailTasks.length} for ${task.student.name}`);

      try {
        // Get signed URL for PDF
        const { data: signedUrlData, error: urlError } = await supabase
          .storage
          .from(storageFolder)
          .createSignedUrl(task.report.file_path, 3600);

        if (urlError || !signedUrlData?.signedUrl) {
          throw new Error('Failed to get signed URL for report file');
        }

        // Download PDF
        const pdfResponse = await fetch(signedUrlData.signedUrl);
        if (!pdfResponse.ok) {
          throw new Error('Failed to download report file');
        }
        const pdfBuffer = await pdfResponse.arrayBuffer();

        // Generate email content
        const emailData = {
          studentName: task.student.name,
          term,
          customMessage: task.customMessage,
          schoolName,
          customHeader: task.customHeader,
          schoolInfo
        };

        const htmlContent = reportType === 'progress_report' 
          ? getProgressReportEmailHTML(emailData)
          : getReportCardEmailHTML(emailData);

        const subject = task.customHeader || `${task.student.name} - ${reportType === 'progress_report' ? 'Progress Report' : 'Report Card'} (${term})`;

        // Prepare email payload
        const emailPayload = {
          from: `reports@${schoolDomain}`,
          to: task.parentEmails,
          subject,
          html: htmlContent,
          attachments: [{
            filename: `${task.student.name}_${term}_${reportType}.pdf`,
            content: Buffer.from(pdfBuffer)
          }]
        };

        // Add CC if provided
        if (task.ccAddresses?.length) {
          emailPayload.cc = task.ccAddresses;
        }

        // Send email
        const emailResult = await resend.emails.send(emailPayload);

        if (emailResult.error) {
          throw new Error(emailResult.error.message || 'Email sending failed');
        }

        // Save email record to database
        await db.query(reportEmailsQueries.createReportEmail, [
          reportType,
          task.student.student_id,
          term,
          userId,
          JSON.stringify(task.parentEmails),
          task.customHeader,
          task.customMessage,
          task.report.file_path,
          task.ccAddresses?.length ? JSON.stringify(task.ccAddresses) : null,
          school
        ]);

        // Update report table to mark as emailed
        const updateQuery = reportType === 'progress_report' 
          ? progressReportsQueries.updateProgressReportEmailStatus
          : reportCardQueries.updateReportCardEmailStatus;
        
        await db.query(updateQuery, [
          task.student.student_id,
          term,
          true,
          new Date().toISOString(),
          userId
        ]);

        results.push({
          studentId: task.student.student_id,
          studentName: task.student.name,
          status: 'success',
          emailId: emailResult.data?.id,
          sentTo: task.parentEmails
        });

        logger.info(`Email sent successfully to ${task.student.name}`);

      } catch (error) {
        logger.error(`Failed to send email for student ${task.student.name}:`, error);
        results.push({
          studentId: task.student.student_id,
          studentName: task.student.name,
          status: 'failed',
          error: error.message
        });
      }

      // Rate limiting: Wait 600ms between emails (ensuring < 2 req/sec)
      if (taskIndex < emailTasks.length - 1) {
        logger.info('Waiting 600ms before next email to respect rate limits...');
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }

    // Step 7: Calculate final statistics
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    const successful = results.filter(r => r.status === 'success');
    const failed = results.filter(r => r.status === 'failed');

    logger.info(`Bulk email completed: ${successful.length} sent, ${failed.length} failed in ${duration}s`);

    res.json({
      status: 'completed',
      term,
      reportType,
      summary: {
        total: results.length,
        sent: successful.length,
        failed: failed.length,
        duration: `${duration}s`
      },
      results: results.map(r => ({
        studentId: r.studentId,
        studentName: r.studentName,
        status: r.status,
        ...(r.status === 'success' ? { sentTo: r.sentTo } : { error: r.error })
      }))
    });

  } catch (error) {
    logger.error('Error in bulk email sending:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to send bulk emails',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get email history for a student
const getStudentEmailHistory = async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId) {
      return res.status(400).json({
        status: 'error',
        message: 'Student ID is required'
      });
    }

    const { rows } = await db.query(reportEmailsQueries.getReportEmailsByStudent, [studentId]);

    res.json({
      status: 'success',
      data: rows.map(toCamelCase)
    });
  } catch (error) {
    logger.error('Error fetching student email history:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch email history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get email history by term and school
const getEmailHistoryByTermAndSchool = async (req, res) => {
  try {
    const { term, school } = req.params;

    if (!term || !school) {
      return res.status(400).json({
        status: 'error',
        message: 'Term and school are required'
      });
    }

    const { rows } = await db.query(reportEmailsQueries.getReportEmailsByTermAndSchool, [term, school]);

    res.json({
      status: 'success',
      data: rows.map(toCamelCase)
    });
  } catch (error) {
    logger.error('Error fetching email history:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch email history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  sendReportEmail,
  sendBulkReportEmails,
  getStudentEmailHistory,
  getEmailHistoryByTermAndSchool
};