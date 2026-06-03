// routes/analytics.routes.js

const express = require('express');
const {
  getOverview,
  getClassDetail,
  getStudentDetail,
  getAiSnapshot,
  invalidateCache,
} = require('../controllers/analytics.controller');

const router = express.Router();

router.get('/overview', getOverview);
router.get('/class/:classId', getClassDetail);
router.get('/student/:studentId', getStudentDetail);
router.get('/snapshot', getAiSnapshot);
router.post('/invalidate-cache', invalidateCache);

module.exports = router;
