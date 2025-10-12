const express = require('express');
const router = express.Router();
const supabase = require('../config/supabaseClient');
const progressReportsController = require('../controllers/progressReports.controller');

// Progress Report Feedback Routes
router.get('/feedback/student/:studentId/class/:classId', progressReportsController.getProgressReportFeedback);
router.post('/feedback/student/:studentId/class/:classId',  progressReportsController.upsertProgressReportFeedback);
router.put('/feedback/student/:studentId/class/:classId', progressReportsController.upsertProgressReportFeedback);
router.delete('/feedback/student/:studentId/class/:classId',  progressReportsController.deleteProgressReportFeedback);

// Get all feedback for a student across all classes
router.get('/feedback/student/:studentId', progressReportsController.getStudentProgressReportFeedback);

// Get all feedback for a class
router.get('/feedback/class/:classId',progressReportsController.getClassProgressReportFeedback);

// Progress Report Records Routes
router.post('/reports', progressReportsController.createProgressReport);
router.get('/reports/student/:studentId',  progressReportsController.getStudentProgressReports);
router.get('/reports/term/:term/school/:school', progressReportsController.getProgressReportsByTermAndSchool);

// Progress Report Generation Routes
router.post('/generate', progressReportsController.generateProgressReport);
router.post('/generate/bulk', progressReportsController.generateProgressReportsBulk);
router.delete('/delete', progressReportsController.deleteProgressReport);

router.get('/signed-url', async (req, res) => {
  const { path } = req.query;

  if (!path) return res.status(400).json({ error: 'Missing file path' });

  const { data, error } = await supabase
    .storage
    .from('progress-reports')
    .createSignedUrl(path, 60 * 10); // valid for 10 minutes

  if (error) return res.status(500).json({ error: error.message });

  res.json({ url: data.signedUrl });
});

module.exports = router;