const express = require('express');
const router = express.Router();
const controller = require('../controllers/registration.controller');

// ─── Forms ──────────────────────────────────────────────────────────
router.get('/forms', controller.getForms);
router.get('/forms/:formId', controller.getForm);
router.post('/forms', controller.createForm);
router.put('/forms/:formId', controller.updateForm);
router.delete('/forms/:formId', controller.deleteForm);
router.patch('/forms/:formId/status', controller.updateFormStatus);

// ─── Banner Upload ──────────────────────────────────────────────────
router.post('/forms/:formId/banner', controller.upload.single('file'), controller.uploadBanner);
router.delete('/forms/:formId/banner', controller.deleteBanner);

// ─── Fields ─────────────────────────────────────────────────────────
router.put('/forms/:formId/fields', controller.upsertFields);

// ─── Submissions ────────────────────────────────────────────────────
router.get('/forms/:formId/submissions/export', controller.exportSubmissions);
router.get('/forms/:formId/submissions', controller.getSubmissions);
router.get('/forms/:formId/submissions/:submissionId', controller.getSubmission);
router.patch('/submissions/:submissionId/status', controller.updateSubmission);
router.delete('/submissions/:submissionId', controller.deleteSubmission);

// ─── Badge Count ────────────────────────────────────────────────────
router.get('/new-count', controller.getNewCount);

module.exports = router;
