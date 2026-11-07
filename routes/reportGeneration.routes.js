const express = require('express');
const router = express.Router();
const controller = require('../controllers/reportGeneration.controller');
const { requirePermission } = require('../middleware/access');
const requireStudentAccess = require('../middleware/requireStudentAccess');

// RBAC: generating report cards and progress reports is report_cards. Every
// student named must be the caller's (as for the old /generate/bulk routes),
// and the controller keeps every run in the caller's school.
router.use(requirePermission('report_cards'));
const ownStudents = requireStudentAccess({
  keys: ['report_cards'],
  studentIds: (req) => (Array.isArray(req.body?.studentIds) ? req.body.studentIds : []),
});

// Queue a run; the worker prints it. What a page lists; Stop, Try again, Dismiss.
router.post('/runs', ownStudents, controller.startRun);
router.get('/runs', controller.listRuns);
router.post('/runs/:runId/cancel', controller.cancelRun);
router.post('/runs/:runId/retry', controller.retryRun);
router.post('/runs/:runId/dismiss', controller.dismissRun);

module.exports = router;
