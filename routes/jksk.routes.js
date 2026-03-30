const express = require('express');
const router = express.Router();
const jkskController = require('../controllers/jksk.controller');

// Domains & Skills
router.get('/domains', jkskController.getDomains);
router.post('/domains', jkskController.createDomain);
router.put('/domains/:domainId', jkskController.updateDomain);
router.delete('/domains/:domainId', jkskController.deleteDomainHandler);

// Skills CRUD
router.post('/skills', jkskController.createSkill);
router.put('/skills/:skillId', jkskController.updateSkillHandler);
router.delete('/skills/:skillId', jkskController.deleteSkillHandler);

// Skill Assessments (D/B/I/N or BG/DV/NI ratings)
router.get('/assessments/:studentId', jkskController.getAssessments);
router.post('/assessments/bulk', jkskController.bulkUpsertAssessments);

// Learning Skills (E/G/S/N - report card only)
router.get('/learning-skills/:studentId', jkskController.getLearningSkills);
router.post('/learning-skills/bulk', jkskController.bulkUpsertLearningSkills);

// Domain Comments (narrative - report card only)
router.get('/domain-comments/:studentId', jkskController.getDomainComments);
router.post('/domain-comments/bulk', jkskController.bulkUpsertDomainComments);

// Progress Report Comments (Academic Achievement / Socio-Emotional)
router.get('/progress-report-comments/:studentId', jkskController.getProgressReportComments);
router.post('/progress-report-comments/bulk', jkskController.bulkUpsertProgressReportComments);

// Teacher Assistant
router.get('/teacher-assistant/:studentId', jkskController.getTeacherAssistant);
router.post('/teacher-assistant', jkskController.upsertTeacherAssistant);

// JK/SK Progress Report Generation
router.post('/progress-report/generate', jkskController.generateProgressReport);
router.post('/progress-report/generate/bulk', jkskController.generateProgressReportsBulk);

// JK/SK Report Card Generation
router.post('/report-card/generate', jkskController.generateReportCard);
router.post('/report-card/generate/bulk', jkskController.generateReportCardsBulk);

module.exports = router;
