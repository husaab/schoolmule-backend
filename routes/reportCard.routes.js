const express = require('express');
const supabase = require('../config/supabaseClient');
const { generateReportCard, upsertFeedback, getFeedback, getClassFeedback, upsertBulkFeedback, generateReportCardsBulk, getGeneratedReportCards, deleteReportCard, getGeneratedReportCardsByStudentId} = require('../controllers/reportCard.controller');

const router = express.Router();

router.post('/generate', generateReportCard);
router.post('/feedback', upsertFeedback);
router.get('/feedback', getFeedback);
router.get('/feedback/class/:classId', getClassFeedback);
router.post('/feedback/bulk', upsertBulkFeedback);
router.post('/generate/bulk', generateReportCardsBulk);
router.get('/view', getGeneratedReportCards);
router.get("/view/student", getGeneratedReportCardsByStudentId);
router.delete('/delete', deleteReportCard);

router.get('/signed-url', async (req, res) => {
  const { path } = req.query;

  if (!path) return res.status(400).json({ error: 'Missing file path' });

  const { data, error } = await supabase
    .storage
    .from('report-cards')
    .createSignedUrl(path, 60 * 10); // valid for 10 minutes

  if (error) return res.status(500).json({ error: error.message });

  res.json({ url: data.signedUrl });
});

module.exports = router;
