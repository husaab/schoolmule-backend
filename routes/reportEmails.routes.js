const express = require('express');
const router = express.Router();
const reportEmailsController = require('../controllers/reportEmails.controller');
const { requirePermission } = require('../middleware/access');

// RBAC: emailing report cards and progress reports is report_cards; the
// controller keeps every student and history row in the caller's school.
router.use(requirePermission('report_cards'));

// Send single report email (progress report or report card)
router.post('/send',  reportEmailsController.sendReportEmail);

// Send bulk report emails
router.post('/send/bulk', reportEmailsController.sendBulkReportEmails);

// A send's progress, student by student; resend its failed emails; the latest sends
router.get('/runs', reportEmailsController.listRuns);
router.get('/runs/:runId', reportEmailsController.getRun);
router.post('/runs/:runId/retry', reportEmailsController.retryRun);

// Get email history for a specific student
router.get('/history/student/:studentId',reportEmailsController.getStudentEmailHistory);

// Get email history by term and school
router.get('/history/term/:term/school/:school', reportEmailsController.getEmailHistoryByTermAndSchool);

module.exports = router;