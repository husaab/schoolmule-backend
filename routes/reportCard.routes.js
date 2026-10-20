const express = require('express');
const supabase = require('../config/supabaseClient');
const requireStaff = require('../middleware/requireStaff');
const { requireStudentReportAccess, requireReportFileAccess, requireOwnReportPaths } = require('../middleware/requireReportAccess');
const { requirePermission, requirePermissionForStaff } = require('../middleware/access');
const requireGradebookAccess = require('../middleware/requireGradebookAccess');
const { generateReportCard, upsertFeedback, getFeedback, getClassFeedback, upsertBulkFeedback, generateReportCardsBulk, getGeneratedReportCards, deleteReportCard, deleteReportCardsBulk, getGeneratedReportCardsByStudentId} = require('../controllers/reportCard.controller');

const router = express.Router();

// RBAC: report cards are `report_cards` (school-wide). A class's teacher
// feedback is open to that class's teachers too.
const reportCards = requirePermission('report_cards');
const classFeedback = (classIdsOf) => requireGradebookAccess({ keys: ['report_cards'], classIds: classIdsOf });
const entriesClasses = (req) => ((req.body && req.body.feedbackEntries) || []).map((e) => e && e.classId);

// Parent-readable: a parent sees only the children they are linked to, and
// may open only a file that belongs to one of them.
router.get('/view/student', requirePermissionForStaff('report_cards'), requireStudentReportAccess((req) => req.query.studentId), getGeneratedReportCardsByStudentId);

router.get('/signed-url', requirePermissionForStaff('report_cards'), requireReportFileAccess('report_cards'), async (req, res) => {
  const { path } = req.query;

  if (!path) return res.status(400).json({ error: 'Missing file path' });

  const { data, error } = await supabase
    .storage
    .from('report-cards')
    .createSignedUrl(path, 60 * 10); // valid for 10 minutes

  if (error) return res.status(500).json({ error: error.message });

  res.json({ url: data.signedUrl });
});

// Everything below is staff-only.
router.use(requireStaff);

router.post('/generate', reportCards, generateReportCard);
router.post('/feedback', classFeedback((req) => [req.body && req.body.classId]), upsertFeedback);
router.get('/feedback', classFeedback((req) => [req.query.classId]), getFeedback);
router.get('/feedback/class/:classId', classFeedback((req) => [req.params.classId]), getClassFeedback);
router.post('/feedback/bulk', classFeedback(entriesClasses), upsertBulkFeedback);
router.post('/generate/bulk', reportCards, generateReportCardsBulk);
router.get('/view', reportCards, getGeneratedReportCards);
router.delete('/delete', reportCards, requireOwnReportPaths((req) => req.query.filePath), deleteReportCard);
router.post('/delete/bulk', reportCards, requireOwnReportPaths((req) => req.body && req.body.filePaths), deleteReportCardsBulk);

module.exports = router;
