const db = require('../config/database');
const logger = require('../logger');
const reportEmailsQueries = require('../queries/reportEmails.queries');
const progressReportsQueries = require('../queries/progressReports.queries');
const reportCardQueries = require('../queries/reportCard.queries');
const studentQueries = require('../queries/student.queries');
const { cleanEmailArray } = require('../utils/emailUtils');
const reportEmails = require('../services/reportEmails');

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

// A send's request only checks and queues: the emails go out from the email
// outbox (services/reportEmails.js), started at once, and the page follows
// the send through GET /runs/:runId. Nothing is sent inside the request.

const REPORT_TYPES = ['progress_report', 'report_card'];

const fail = (res, error, message) => {
  if (error.expose && error.status) {
    return res.status(error.status).json({ status: 'error', message: error.message });
  }
  logger.error({ err: error }, message);
  return res.status(500).json({
    status: 'error',
    message,
    error: process.env.NODE_ENV === 'development' ? error.message : undefined,
  });
};

const queuedBody = (reportType, term, queued) => ({
  status: 'queued',
  runId: queued.runId,
  reportType,
  term,
  summary: { total: queued.total, queued: queued.queued, skipped: queued.skipped },
});

// POST /api/report-emails/send — one student, to the addresses typed.
const sendReportEmail = async (req, res) => {
  try {
    const {
      reportType,
      studentId,
      term,
      emailAddresses: rawEmailAddresses,
      ccAddresses: rawCcAddresses,
      customHeader,
      customMessage,
    } = req.body;
    const emailAddresses = cleanEmailArray(rawEmailAddresses);
    const ccAddresses = cleanEmailArray(rawCcAddresses);

    if (!reportType || !studentId || !term || !emailAddresses?.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: reportType, studentId, term, emailAddresses',
      });
    }
    if (!REPORT_TYPES.includes(reportType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid report type. Must be "progress_report" or "report_card"',
      });
    }

    const { rows: studentRows } = await db.query(studentQueries.selectStudentById, [studentId]);
    // Only the caller's own school's students (another school's reads as missing).
    if (studentRows.length === 0 || String(studentRows[0].school) !== String(req.user.school)) {
      return res.status(404).json({ status: 'error', message: 'Student not found' });
    }
    const student = studentRows[0];
    const reportQuery = reportType === 'progress_report'
      ? progressReportsQueries.getProgressReportByStudentAndTerm
      : reportCardQueries.selectGeneratedReportCardsByStudentId;
    const { rows: reportRows } = await db.query(reportQuery, [studentId, term, student.school]);
    if (reportRows.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: `No ${reportType.replace('_', ' ')} found for student ${student.name} in term ${term}`,
      });
    }

    const queued = await reportEmails.queueSend({
      school: student.school,
      userId: req.user?.userId,
      reportType,
      term,
      studentIds: [studentId],
      customHeader,
      customMessage,
      ccAddresses,
      chosen: emailAddresses,
    });
    return res.status(202).json({
      ...queuedBody(reportType, term, queued),
      message: `Sending the ${reportType === 'progress_report' ? 'progress report' : 'report card'}`,
    });
  } catch (error) {
    return fail(res, error, 'Failed to send report email');
  }
};

// POST /api/report-emails/send/bulk — many students, to their parents on file.
const sendBulkReportEmails = async (req, res) => {
  try {
    const { reportType, studentIds, term, bulkConfig } = req.body; // bulkConfig: { customHeader, customMessage, ccAddresses }

    if (!reportType || !studentIds?.length || !term) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: reportType, studentIds, term',
      });
    }
    if (!REPORT_TYPES.includes(reportType)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid report type. Must be "progress_report" or "report_card"',
      });
    }

    const queued = await reportEmails.queueSend({
      school: req.user.school,
      userId: req.user?.userId,
      reportType,
      term,
      studentIds,
      customHeader: bulkConfig?.customHeader,
      customMessage: bulkConfig?.customMessage,
      ccAddresses: cleanEmailArray(bulkConfig?.ccAddresses),
    });
    logger.info({ runId: queued.runId, reportType, term, ...queued }, 'Report emails queued');
    return res.status(202).json(queuedBody(reportType, term, queued));
  } catch (error) {
    return fail(res, error, 'Failed to send bulk emails');
  }
};

// GET /api/report-emails/runs/:runId — one send, student by student.
const getRun = async (req, res) => {
  try {
    const run = UUID.test(String(req.params.runId || '')) ? await reportEmails.runDelivery(req.params.runId, req.user.school) : null;
    if (!run) return res.status(404).json({ status: 'error', message: 'Send not found' });
    return res.json({ status: 'success', data: run });
  } catch (error) {
    return fail(res, error, 'Failed to load the send');
  }
};

// POST /api/report-emails/runs/:runId/retry — send the failed emails again.
const retryRun = async (req, res) => {
  try {
    const outcome = UUID.test(String(req.params.runId || ''))
      ? await reportEmails.retryRun({ runId: req.params.runId, school: req.user.school, userId: req.user?.userId })
      : null;
    if (!outcome) return res.status(404).json({ status: 'error', message: 'Send not found' });
    const run = await reportEmails.runDelivery(req.params.runId, req.user.school);
    return res.json({ status: 'success', data: { ...outcome, ...run } });
  } catch (error) {
    return fail(res, error, 'Could not retry the emails');
  }
};

// GET /api/report-emails/runs?reportType=&term=&limit= — the latest sends.
const listRuns = async (req, res) => {
  try {
    const reportType = REPORT_TYPES.includes(req.query.reportType) ? req.query.reportType : null;
    const term = typeof req.query.term === 'string' && req.query.term.trim() ? req.query.term.trim() : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    return res.json({ status: 'success', data: await reportEmails.recentRuns({ school: req.user.school, reportType, term, limit }) });
  } catch (error) {
    return fail(res, error, 'Failed to load the sends');
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const { rows } = await db.query(reportEmailsQueries.getReportEmailsByStudent, [studentId, req.user.school]);

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
    // The :school segment is legacy: the caller's own school always applies.
    const { term } = req.params;
    const { school } = req.user;

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
  getRun,
  retryRun,
  listRuns,
  getStudentEmailHistory,
  getEmailHistoryByTermAndSchool
};