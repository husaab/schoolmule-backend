// src/routes/studentAssessment.router.js

const express = require('express');
const { getScoresByClass, upsertScoresByClass, exportScoresExcel, getStudentAssessment, setScoreStatus } = require('../controllers/studentAssessment.controller');
const { setModifiedMark, clearModifiedMark } = require('../controllers/modifiedMark.controller');
const { requireStaffAccess } = require('../middleware/access');
const requireClassOwnership = require('../middleware/requireClassOwnership');
const requireGradebookAccess = require('../middleware/requireGradebookAccess');

const router = express.Router();

// RBAC: scores are a class's gradebook: its teachers, or classes.all.
router.use(requireStaffAccess);

router.get('/classes/:classId/scores', requireClassOwnership, getScoresByClass);
router.post('/classes/:classId/scores', requireClassOwnership, upsertScoresByClass);
router.patch('/classes/:classId/status', requireClassOwnership, setScoreStatus);
router.put('/classes/:classId/modified-marks/:studentId/:assessmentId', requireClassOwnership, setModifiedMark);
router.delete('/classes/:classId/modified-marks/:studentId/:assessmentId', requireClassOwnership, clearModifiedMark);
router.get('/classes/:classId/scores/csv', requireClassOwnership, exportScoresExcel);
router.get('/:studentId/:assessmentId', requireGradebookAccess({ assessmentIds: (req) => [req.params.assessmentId] }), getStudentAssessment);

module.exports = router;
