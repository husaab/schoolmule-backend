const express = require('express');
const { generateReportCard, upsertFeedback, getFeedback } = require('../controllers/reportCard.controller');

const router = express.Router();

router.post('/generate', generateReportCard);
router.post('/feedback', upsertFeedback);
router.get('/feedback', getFeedback);

module.exports = router;
