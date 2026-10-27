// routes/analytics.routes.js

const express = require('express');
const {
  getOverview,
  getClassDetail,
  getStudentDetail,
  getAiSnapshot,
  getTermComparison,
  getClassesHealth,
  invalidateCache,
} = require('../controllers/analytics.controller');
const { listForSchool: getStatsExclusions } = require('../controllers/classStatsExclusions.controller');

const { requirePermission, requireStaffAccess } = require('../middleware/access');

const router = express.Router();

// RBAC: school-wide analytics. classes-health also feeds every staff
// dashboard and scopes itself (classes.all = the school, else own classes).
router.use(requireStaffAccess);
const analytics = requirePermission('analytics');

router.get('/overview', analytics, getOverview);
router.get('/class/:classId', analytics, getClassDetail);
router.get('/student/:studentId', analytics, getStudentDetail);
router.get('/snapshot', analytics, getAiSnapshot);
router.get('/term-comparison', analytics, getTermComparison);
router.get('/classes-health', getClassesHealth);
router.get('/stats-exclusions', analytics, getStatsExclusions);
router.post('/invalidate-cache', analytics, invalidateCache);

module.exports = router;
