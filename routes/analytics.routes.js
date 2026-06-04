// routes/analytics.routes.js

const express = require('express');
const {
  getOverview,
  getClassDetail,
  getStudentDetail,
  getAiSnapshot,
  getTermComparison,
  invalidateCache,
} = require('../controllers/analytics.controller');

const router = express.Router();

router.get('/overview', getOverview);
router.get('/class/:classId', getClassDetail);
router.get('/student/:studentId', getStudentDetail);
router.get('/snapshot', getAiSnapshot);
router.get('/term-comparison', getTermComparison);
router.post('/invalidate-cache', invalidateCache);

module.exports = router;
