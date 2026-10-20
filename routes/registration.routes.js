const express = require('express');
const router = express.Router();
const controller = require('../controllers/registration.controller');
const importController = require('../controllers/registrationImport.controller');
const statusController = require('../controllers/registrationStatus.controller');
const sheetsController = require('../controllers/googleSheets.controller');
const { requirePermission, requireStaffAccess } = require('../middleware/access');
const { requireFormAccess } = require('../middleware/requireFormAccess');

// RBAC (D8). Anyone on staff builds forms and manages their own; `forms`
// opens every form of the school. Linked sheets, statuses and imports are
// school-wide tools: `forms` (an import also creates students: `students`).
// The Google connection is shared with the staff hours sheet.
router.use(requireStaffAccess);
const ownForm = requireFormAccess('form');
const ownSubmission = requireFormAccess('submission');
const allForms = requirePermission('forms');
const googleConnection = requirePermission('forms', 'staff_attendance');
const createsStudents = [allForms, requirePermission('students')];

// ─── Forms ──────────────────────────────────────────────────────────
router.get('/forms', controller.getForms);
router.get('/forms/:formId', ownForm, controller.getForm);
router.post('/forms', controller.createForm);
router.put('/forms/:formId', ownForm, controller.updateForm);
router.delete('/forms/:formId', ownForm, controller.deleteForm);
router.patch('/forms/:formId/status', ownForm, controller.updateFormStatus);

// ─── Banner Upload ──────────────────────────────────────────────────
router.post('/forms/:formId/banner', ownForm, controller.upload.single('file'), controller.uploadBanner);
router.delete('/forms/:formId/banner', ownForm, controller.deleteBanner);

// ─── Fields ─────────────────────────────────────────────────────────
router.put('/forms/:formId/fields', ownForm, controller.upsertFields);

// ─── Submissions ────────────────────────────────────────────────────
router.get('/forms/:formId/submissions/export', ownForm, controller.exportSubmissions);
router.get('/forms/:formId/submissions', ownForm, controller.getSubmissions);
// By the submission's own form: a formId of yours can't open someone else's submission.
router.get('/forms/:formId/submissions/:submissionId', ownSubmission, controller.getSubmission);
router.patch('/submissions/:submissionId/status', ownSubmission, controller.updateSubmission);
router.patch('/submissions/:submissionId/answers', ownSubmission, controller.updateSubmissionAnswers);
router.delete('/submissions/:submissionId', ownSubmission, controller.deleteSubmission);

// ─── Google Sheets sync ─────────────────────────────────────────────
// The OAuth callback is NOT here — Google sends the browser there without a
// JWT, so it lives in googleSheetsPublic.routes.js, mounted before verifyUser.
router.get('/google/status', googleConnection, sheetsController.getConnectionStatus);
// Admin-only: the signed state this mints is what the OAuth callback trusts.
router.get('/google/auth-url', googleConnection, sheetsController.getAuthUrl);
router.delete('/google/connection', googleConnection, sheetsController.disconnect);
router.get('/forms/:formId/sheet', allForms, sheetsController.getSheetLink);
router.put('/forms/:formId/sheet', allForms, sheetsController.linkSheet);
router.delete('/forms/:formId/sheet', allForms, sheetsController.unlinkSheet);
router.post('/forms/:formId/sheet/sync', allForms, sheetsController.syncNow);
// Sharing grants outsiders access to every submission in the spreadsheet, so
// it is admin-only even though the rest of this router is open to all staff.
router.get('/forms/:formId/sheet/shares', allForms, sheetsController.listShares);
router.post('/forms/:formId/sheet/shares', allForms, sheetsController.addShare);
router.delete('/forms/:formId/sheet/shares/:permissionId', allForms, sheetsController.removeShare);

// ─── Submission statuses ────────────────────────────────────────────
// Shared by every form in the school, so these are not nested under a form.
router.get('/statuses', statusController.getStatuses);
router.post('/statuses', allForms, statusController.createStatus);
router.get('/statuses/:statusId/usage', allForms, statusController.getStatusUsage);
router.put('/statuses/:statusId', allForms, statusController.updateStatus);
router.delete('/statuses/:statusId', allForms, statusController.deleteStatus);
router.put('/statuses-order', allForms, statusController.reorderStatuses);

// ─── Import submissions as students ─────────────────────────────────
// Mapping is configured once per form; preview/execute share one classification
// pass so the import writes exactly what the preview showed.
router.get('/forms/:formId/import/mapping', allForms, importController.getMapping);
router.put('/forms/:formId/import/mapping', allForms, importController.saveMapping);
router.post('/forms/:formId/import/preview', allForms, importController.previewImport);
router.post('/forms/:formId/import/execute', ...createsStudents, importController.executeImport);
router.get('/submissions/:submissionId/import/undo', allForms, importController.getUndoInfo);
router.post('/submissions/:submissionId/import/undo', ...createsStudents, importController.undoImport);

// ─── Badge Count ────────────────────────────────────────────────────
router.get('/new-count', controller.getNewCount);

module.exports = router;
