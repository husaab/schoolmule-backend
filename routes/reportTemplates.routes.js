const express = require('express');
const rateLimit = require('express-rate-limit');
const requireStaff = require('../middleware/requireStaff');
const { requirePermission } = require('../middleware/access');
const controller = require('../controllers/reportTemplates.controller');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// RBAC: designing, assigning and previewing templates is school setup.
// Filling in a template's extra fields is part of making report cards, so
// report_cards holders may too. Staff only; everything is the caller's school.
router.use(requireStaff);
const designer = requirePermission('school_setup');
const fieldValues = requirePermission('school_setup', 'report_cards');

// A server-side print launches Chromium: a light per-user limit.
const previewPdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: { status: 'failed', message: 'Too many previews. Wait a minute and try again.' },
});

const uuidParam = (message) => (req, res, next, id) => (
  UUID_RE.test(id) ? next() : res.status(404).json({ status: 'failed', message })
);
router.param('id', uuidParam('Template not found'));
router.param('versionId', uuidParam('Version not found'));
router.param('assignmentId', uuidParam('Assignment not found'));

// Which template prints for which grades and terms.
router.get('/assignments', designer, controller.listAssignments);
router.post('/assignments', designer, controller.createAssignment);
router.patch('/assignments/:assignmentId', designer, controller.updateAssignment);
router.delete('/assignments/:assignmentId', designer, controller.deleteAssignment);
router.get('/coverage', designer, controller.getCoverage);

// Previews.
router.get('/preview/students', designer, controller.previewStudents);
router.get('/preview/data', designer, controller.previewData);
router.get('/preview/sample', designer, controller.previewSample);
router.post('/preview/pdf', designer, previewPdfLimiter, controller.previewPdf);

// Extra field values per student.
router.get('/field-values', fieldValues, controller.getFieldValues);
router.put('/field-values', fieldValues, controller.putFieldValues);

// Templates.
router.get('/', designer, controller.listTemplates);
router.post('/', designer, controller.createTemplate);
router.get('/:id', designer, controller.getTemplate);
router.patch('/:id', designer, controller.renameTemplate);
router.delete('/:id', designer, controller.deleteTemplate);
router.put('/:id/draft', designer, controller.saveDraft);
router.post('/:id/publish', designer, controller.publishTemplate);
router.get('/:id/versions', designer, controller.listVersions);
router.post('/:id/versions/:versionId/restore', designer, controller.restoreVersion);
router.post('/:id/discard-draft', designer, controller.discardDraft);

module.exports = router;
