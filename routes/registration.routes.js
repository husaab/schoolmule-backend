const express = require('express');
const router = express.Router();
const controller = require('../controllers/registration.controller');
const importController = require('../controllers/registrationImport.controller');
const statusController = require('../controllers/registrationStatus.controller');
const sheetsController = require('../controllers/googleSheets.controller');

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
router.patch('/submissions/:submissionId/answers', controller.updateSubmissionAnswers);
router.delete('/submissions/:submissionId', controller.deleteSubmission);

// ─── Google Sheets sync ─────────────────────────────────────────────
// The OAuth callback is NOT here — Google sends the browser there without a
// JWT, so it lives in googleSheetsPublic.routes.js, mounted before verifyUser.
router.get('/google/status', sheetsController.getConnectionStatus);
router.get('/google/auth-url', sheetsController.getAuthUrl);
router.delete('/google/connection', sheetsController.disconnect);
router.get('/forms/:formId/sheet', sheetsController.getSheetLink);
router.put('/forms/:formId/sheet', sheetsController.linkSheet);
router.delete('/forms/:formId/sheet', sheetsController.unlinkSheet);
router.post('/forms/:formId/sheet/sync', sheetsController.syncNow);

// ─── Submission statuses ────────────────────────────────────────────
// Shared by every form in the school, so these are not nested under a form.
router.get('/statuses', statusController.getStatuses);
router.post('/statuses', statusController.createStatus);
router.get('/statuses/:statusId/usage', statusController.getStatusUsage);
router.put('/statuses/:statusId', statusController.updateStatus);
router.delete('/statuses/:statusId', statusController.deleteStatus);
router.put('/statuses-order', statusController.reorderStatuses);

// ─── Import submissions as students ─────────────────────────────────
// Mapping is configured once per form; preview/execute share one classification
// pass so the import writes exactly what the preview showed.
router.get('/forms/:formId/import/mapping', importController.getMapping);
router.put('/forms/:formId/import/mapping', importController.saveMapping);
router.post('/forms/:formId/import/preview', importController.previewImport);
router.post('/forms/:formId/import/execute', importController.executeImport);
router.get('/submissions/:submissionId/import/undo', importController.getUndoInfo);
router.post('/submissions/:submissionId/import/undo', importController.undoImport);

// ─── Badge Count ────────────────────────────────────────────────────
router.get('/new-count', controller.getNewCount);

module.exports = router;
