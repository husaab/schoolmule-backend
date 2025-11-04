const express = require('express');
const router = express.Router();
const reportEmailsController = require('../controllers/reportEmails.controller');
// Send single report email (progress report or report card)
router.post('/send',  reportEmailsController.sendReportEmail);

// Send bulk report emails
router.post('/send/bulk', reportEmailsController.sendBulkReportEmails);

// Get email history for a specific student
router.get('/history/student/:studentId',reportEmailsController.getStudentEmailHistory);

// Get email history by term and school
router.get('/history/term/:term/school/:school', reportEmailsController.getEmailHistoryByTermAndSchool);

module.exports = router;