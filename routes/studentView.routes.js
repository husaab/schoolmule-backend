// routes/studentView.routes.js

const express = require('express');
const {
  listViews,
  getView,
  createView,
  updateView,
  deleteView,
  evaluateSavedView,
  evaluatePreview,
  exportCsv,
  generateCertificates,
  sendStudentViewCertificateEmails,
  sendSingleStudentViewCertificateEmail,
} = require('../controllers/studentView.controller');

const router = express.Router();

router.get('/', listViews);
router.post('/', createView);
router.post('/preview', evaluatePreview);

router.get('/:viewId', getView);
router.patch('/:viewId', updateView);
router.delete('/:viewId', deleteView);

router.post('/:viewId/evaluate', evaluateSavedView);
router.get('/:viewId/export.csv', exportCsv);
router.post('/:viewId/certificates.pdf', generateCertificates);
router.post('/:viewId/email', sendStudentViewCertificateEmails);
router.post('/:viewId/email/student/:studentId', sendSingleStudentViewCertificateEmail);

module.exports = router;
