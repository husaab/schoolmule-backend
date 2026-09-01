// routes/assessmentPublish.routes.js
//
// Its own router rather than extra paths on assessment.routes.js: that
// router's catch-all GET/PATCH/DELETE /:id would capture any literal
// segment (/publish, /history) as an :id. Every other multi-endpoint
// feature here (parent portal, student views, agendas) has its own file at
// its own base path too.
//
// Every route carries :classId so requireClassOwnership can authorize
// uniformly as route middleware, before any controller runs.

const express = require('express');

const requireClassOwnership = require('../middleware/requireClassOwnership');
const {
  getPublicationState,
  previewPublish,
  publishAssessments,
  unpublishAssessments,
  updateAssessmentComment,
  getPublicationHistory,
} = require('../controllers/assessmentPublish.controller');

const router = express.Router();

router.get('/classes/:classId', requireClassOwnership, getPublicationState);
router.get('/classes/:classId/history', requireClassOwnership, getPublicationHistory);
router.post('/classes/:classId/preview', requireClassOwnership, previewPublish);
router.post('/classes/:classId/publish', requireClassOwnership, publishAssessments);
router.post('/classes/:classId/unpublish', requireClassOwnership, unpublishAssessments);
router.patch(
  '/classes/:classId/assessments/:assessmentId/comment',
  requireClassOwnership,
  updateAssessmentComment,
);

module.exports = router;
