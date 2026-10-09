const express = require('express');
const supabase = require('../config/supabaseClient');
const requireStaff = require('../middleware/requireStaff');
const { requireStudentReportAccess, requireReportFileAccess } = require('../middleware/requireReportAccess');
const { generateReportCard, upsertFeedback, getFeedback, getClassFeedback, upsertBulkFeedback, generateReportCardsBulk, getGeneratedReportCards, deleteReportCard, deleteReportCardsBulk, getGeneratedReportCardsByStudentId} = require('../controllers/reportCard.controller');

const router = express.Router();

// Parent-readable: a parent sees only the children they are linked to, and
// may open only a file that belongs to one of them.
router.get('/view/student', requireStudentReportAccess((req) => req.query.studentId), getGeneratedReportCardsByStudentId);

router.get('/signed-url', requireReportFileAccess('report_cards'), async (req, res) => {
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

router.post('/generate', generateReportCard);
router.post('/feedback', upsertFeedback);
router.get('/feedback', getFeedback);
router.get('/feedback/class/:classId', getClassFeedback);
router.post('/feedback/bulk', upsertBulkFeedback);
router.post('/generate/bulk', generateReportCardsBulk);
router.get('/view', getGeneratedReportCards);
router.delete('/delete', deleteReportCard);
router.post('/delete/bulk', deleteReportCardsBulk);

module.exports = router;
