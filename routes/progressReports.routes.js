const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const requireStaff = require('../middleware/requireStaff');
const { requireStudentReportAccess, requireReportFileAccess } = require('../middleware/requireReportAccess');
const progressReportsController = require('../controllers/progressReports.controller');

// Parent-readable: a parent sees only the children they are linked to, and
// may open only a file that belongs to one of them.
router.get('/reports/student/:studentId', requireStudentReportAccess((req) => req.params.studentId), progressReportsController.getStudentProgressReports);

router.get('/signed-url', requireReportFileAccess('progress_reports'), async (req, res) => {
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
router.get('/feedback/student/:studentId/class/:classId', progressReportsController.getProgressReportFeedback);
router.post('/feedback/student/:studentId/class/:classId',  progressReportsController.upsertProgressReportFeedback);
router.put('/feedback/student/:studentId/class/:classId', progressReportsController.upsertProgressReportFeedback);
router.delete('/feedback/student/:studentId/class/:classId',  progressReportsController.deleteProgressReportFeedback);

// Get all feedback for a student across all classes
router.get('/feedback/student/:studentId', progressReportsController.getStudentProgressReportFeedback);

// Get all feedback for a class
router.get('/feedback/class/:classId', progressReportsController.getClassProgressReportFeedback);

// Bulk upsert feedback for multiple students
router.post('/feedback/bulk', progressReportsController.upsertBulkProgressReportFeedback);

// Progress Report Records Routes
router.post('/reports', progressReportsController.createProgressReport);
router.get('/reports/term/:term/school/:school', progressReportsController.getProgressReportsByTermAndSchool);

// Progress Report Generation Routes
router.post('/generate', progressReportsController.generateProgressReport);
router.post('/generate/bulk', progressReportsController.generateProgressReportsBulk);
router.delete('/delete', progressReportsController.deleteProgressReport);
router.post('/delete/bulk', progressReportsController.deleteProgressReportsBulk);

module.exports = router;
