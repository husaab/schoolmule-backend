const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const requireStaff = require('../middleware/requireStaff');
const { requireStudentReportAccess, requireReportFileAccess, requireOwnReportPaths } = require('../middleware/requireReportAccess');
const { requirePermission, requirePermissionForStaff } = require('../middleware/access');
const requireGradebookAccess = require('../middleware/requireGradebookAccess');

// RBAC: progress reports are `report_cards` (school-wide); a class's teacher
// feedback is open to that class's teachers too.
const reportCards = requirePermission('report_cards');
const classFeedback = (classIdsOf) => requireGradebookAccess({ keys: ['report_cards'], classIds: classIdsOf });
const paramClass = classFeedback((req) => [req.params.classId]);
const entriesClasses = (req) => ((req.body && req.body.feedbackEntries) || []).map((e) => e && e.classId);
const progressReportsController = require('../controllers/progressReports.controller');

// Parent-readable: a parent sees only the children they are linked to, and
// may open only a file that belongs to one of them.
router.get('/reports/student/:studentId', requirePermissionForStaff('report_cards'), requireStudentReportAccess((req) => req.params.studentId), progressReportsController.getStudentProgressReports);

router.get('/signed-url', requirePermissionForStaff('report_cards'), requireReportFileAccess('progress_reports'), async (req, res) => {
  const { path } = req.query;

  if (!path) return res.status(400).json({ error: 'Missing file path' });

  const { data, error } = await supabase
    .storage
    .from('progress-reports')
    .createSignedUrl(path, 60 * 10); // valid for 10 minutes

  if (error) return res.status(500).json({ error: error.message });

  res.json({ url: data.signedUrl });
});

// Everything below is staff-only.
router.use(requireStaff);

// Progress Report Feedback Routes
router.get('/feedback/student/:studentId/class/:classId', paramClass, progressReportsController.getProgressReportFeedback);
router.post('/feedback/student/:studentId/class/:classId', paramClass, progressReportsController.upsertProgressReportFeedback);
router.put('/feedback/student/:studentId/class/:classId', paramClass, progressReportsController.upsertProgressReportFeedback);
router.delete('/feedback/student/:studentId/class/:classId', paramClass, progressReportsController.deleteProgressReportFeedback);

// Get all feedback for a student across all classes
router.get('/feedback/student/:studentId', reportCards, progressReportsController.getStudentProgressReportFeedback);

// Get all feedback for a class
router.get('/feedback/class/:classId', paramClass, progressReportsController.getClassProgressReportFeedback);

// Bulk upsert feedback for multiple students
router.post('/feedback/bulk', classFeedback(entriesClasses), progressReportsController.upsertBulkProgressReportFeedback);

// Progress Report Records Routes
router.post('/reports', reportCards, requireOwnReportPaths((req) => req.body && req.body.filePath), progressReportsController.createProgressReport);
router.get('/reports/term/:term/school/:school', reportCards, progressReportsController.getProgressReportsByTermAndSchool);

// Progress Report Generation Routes
router.post('/generate', reportCards, progressReportsController.generateProgressReport);
router.post('/generate/bulk', reportCards, progressReportsController.generateProgressReportsBulk);
router.delete('/delete', reportCards, requireOwnReportPaths((req) => req.query.filePath), progressReportsController.deleteProgressReport);
router.post('/delete/bulk', reportCards, requireOwnReportPaths((req) => req.body && req.body.filePaths), progressReportsController.deleteProgressReportsBulk);

module.exports = router;
