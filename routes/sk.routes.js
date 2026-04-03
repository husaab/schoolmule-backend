const express = require('express');
const router = express.Router();
const skController = require('../controllers/sk.controller');

// Subjects & Standards
router.get('/subjects', skController.getSubjects);
router.post('/subjects', skController.createSubject);
router.put('/subjects/:subjectId', skController.updateSubject);
router.delete('/subjects/:subjectId', skController.deleteSubjectHandler);

// Standards CRUD
router.post('/standards', skController.createStandard);
router.put('/standards/:standardId', skController.updateStandardHandler);
router.delete('/standards/:standardId', skController.deleteStandardHandler);

// Standard Assessments (E/P/DV/EM/NI/N/A or E/G/S/NI/NA ratings)
router.get('/assessments/:studentId', skController.getAssessments);
router.post('/assessments/bulk', skController.bulkUpsertAssessments);

// Subject Comments (narrative - report card only)
router.get('/subject-comments/:studentId', skController.getSubjectComments);
router.post('/subject-comments/bulk', skController.bulkUpsertSubjectComments);

// Teacher Assistant
router.get('/teacher-assistant/:studentId', skController.getTeacherAssistant);
router.post('/teacher-assistant', skController.upsertTeacherAssistant);

// Progress Report Comments (Academic Achievement / Socio-Emotional)
router.get('/progress-report-comments/:studentId', skController.getProgressReportComments);
router.post('/progress-report-comments/bulk', skController.bulkUpsertProgressReportComments);

// SK Progress Report Generation
router.post('/progress-report/generate', skController.generateProgressReport);
router.post('/progress-report/generate/bulk', skController.generateProgressReportsBulk);

// SK Report Card Generation
router.post('/report-card/generate', skController.generateReportCard);
router.post('/report-card/generate/bulk', skController.generateReportCardsBulk);

module.exports = router;
