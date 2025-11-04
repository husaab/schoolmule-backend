const { Resend } = require('resend');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const reportEmailsQueries = require('../queries/reportEmails.queries');
const progressReportsQueries = require('../queries/progressReports.queries');
const reportCardQueries = require('../queries/report_card.queries');
const studentQueries = require('../queries/student.queries');
const { getProgressReportEmailHTML, getReportCardEmailHTML } = require('../utils/emailTemplate');

// Helper function to convert snake_case to camelCase
const toCamelCase = (row) => ({
  id: row.id,
  reportType: row.report_type,
  studentId: row.student_id,
  term: row.term,
  sentBy: row.sent_by,
  emailAddresses: Array.isArray(row.email_addresses) ? row.email_addresses : JSON.parse(row.email_addresses || '[]'),
  customHeader: row.custom_header,
  customMessage: row.custom_message,
  filePath: row.file_path,
  sentAt: row.sent_at,
  ccAddresses: row.cc_addresses ? (Array.isArray(row.cc_addresses) ? row.cc_addresses : JSON.parse(row.cc_addresses)) : [],
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
  
  const apiKeyVar = `${schoolKey}_RESEND_API_KEY`;
  const schoolApiKey = process.env[apiKeyVar];
  
  if (!schoolApiKey) {
    throw new Error(`No API key found for school: ${school}. Expected env var: ${apiKeyVar}`);
  }
  
  return schoolApiKey;
};

// Send progress report or report card email
const sendReportEmail = async (req, res) => {
  try {
    const { 
      reportType, 
      studentId, 
      term, 
      emailAddresses, 
      ccAddresses, 
      customHeader, 
      customMessage
    } = req.body;

    const userId = req.user?.user_id;

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
    const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
    if (studentRows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Student not found'
      });
    }
    const student = studentRows[0];

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

    // Generate email content
    const emailData = {
      studentName: student.name,
      term,
      customMessage,
      schoolName: student.school,
      customHeader
    };

    const htmlContent = reportType === 'progress_report' 
      ? getProgressReportEmailHTML(emailData)
      : getReportCardEmailHTML(emailData);

    const subject = customHeader || `${student.name} - ${reportType === 'progress_report' ? 'Progress Report' : 'Report Card'} (${term})`;

    // Get school-specific API key
    const schoolApiKey = getSchoolApiKey(student.school);
    const resend = new Resend(schoolApiKey);

    // Prepare email payload
    const emailPayload = {
      from: process.env.EMAIL_FROM || `reports@${process.env.MAIL_DOMAIN}`,
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
    const emailResult = await resend.emails.send(emailPayload);

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
    logger.error('Error sending report email:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to send report email',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send bulk report emails
const sendBulkReportEmails = async (req, res) => {
  try {
    const { 
      reportType, 
      studentIds, 
      term, 
      emailConfig // { emailAddresses, ccAddresses, customHeader, customMessage }
    } = req.body;

    if (!reportType || !studentIds?.length || !term || !emailConfig?.emailAddresses?.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields for bulk email'
      });
    }

    const successes = [];
    const failures = [];

    for (const studentId of studentIds) {
      try {
        // Use the same logic as single email but for each student
        const emailPayload = {
          reportType,
          studentId,
          term,
          ...emailConfig
        };

        // Call single email function for each student
        const mockReq = { body: emailPayload, user: req.user };
        const mockRes = {
          status: () => mockRes,
          json: (result) => {
            if (result.status === 'success') {
              successes.push({ studentId, message: result.message, data: result.data });
            } else {
              failures.push({ studentId, error: result.message });
            }
          }
        };

        await sendReportEmail(mockReq, mockRes);
      } catch (error) {
        logger.error(`Failed to send email for student ${studentId}:`, error);
        failures.push({ studentId, error: error.message });
      }
    }

    res.json({
      status: 'completed',
      term,
      reportType,
      sent: successes,
      failed: failures
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