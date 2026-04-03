const express = require('express');
const router = express.Router();
const jkController = require('../controllers/jk.controller');

// Domains & Skills
router.get('/domains', jkController.getDomains);
router.post('/domains', jkController.createDomain);
router.put('/domains/:domainId', jkController.updateDomain);
router.delete('/domains/:domainId', jkController.deleteDomainHandler);

// Skills CRUD
router.post('/skills', jkController.createSkill);
router.put('/skills/:skillId', jkController.updateSkillHandler);
router.delete('/skills/:skillId', jkController.deleteSkillHandler);

// Skill Assessments (D/B/I/N or BG/DV/NI ratings)
router.get('/assessments/:studentId', jkController.getAssessments);
router.post('/assessments/bulk', jkController.bulkUpsertAssessments);

// Learning Skills (E/G/S/N - report card only)
router.get('/learning-skills/:studentId', jkController.getLearningSkills);
router.post('/learning-skills/bulk', jkController.bulkUpsertLearningSkills);

// Domain Comments (narrative - report card only)
router.get('/domain-comments/:studentId', jkController.getDomainComments);
router.post('/domain-comments/bulk', jkController.bulkUpsertDomainComments);

// Progress Report Comments (Academic Achievement / Socio-Emotional)
router.get('/progress-report-comments/:studentId', jkController.getProgressReportComments);
router.post('/progress-report-comments/bulk', jkController.bulkUpsertProgressReportComments);

// Teacher Assistant
router.get('/teacher-assistant/:studentId', jkController.getTeacherAssistant);
router.post('/teacher-assistant', jkController.upsertTeacherAssistant);

// JK Progress Report Generation
router.post('/progress-report/generate', jkController.generateProgressReport);
router.post('/progress-report/generate/bulk', jkController.generateProgressReportsBulk);

// JK Report Card Generation
router.post('/report-card/generate', jkController.generateReportCard);
router.post('/report-card/generate/bulk', jkController.generateReportCardsBulk);

module.exports = router;
